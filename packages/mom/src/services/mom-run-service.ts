import * as log from "../log.js";
import type { SandboxConfig } from "../sandbox.js";
import type { MomHandler, SlackBot, SlackEvent } from "../slack.js";
import { ChannelStore } from "../store.js";
import { FileQueuePiBridgeClient, type PiBridgeClient, type PiBridgeStatus } from "./pi-bridge-client.js";
import { createSlackContext } from "./slack-context-service.js";

const SLACK_REPLY_CHUNK_SIZE = 30_000;

interface ChannelState {
	running: boolean;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
	abortController?: AbortController;
}

interface MomRunServiceConfig {
	workingDir: string;
	sandbox: SandboxConfig;
	botToken: string;
	createStore?: (workingDir: string, botToken: string) => ChannelStore;
	createBridgeClient?: (workingDir: string) => PiBridgeClient;
}

export class MomRunService implements MomHandler {
	private readonly workingDir: string;
	private readonly botToken: string;
	private readonly bridgeClient: PiBridgeClient;
	private readonly channelStates = new Map<string, ChannelState>();
	private readonly createStore: (workingDir: string, botToken: string) => ChannelStore;
	private activeRuns = 0;
	private idleResolvers: Array<() => void> = [];

	constructor(config: MomRunServiceConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;
		const bridgeClientFactory =
			config.createBridgeClient ?? ((workingDir: string) => FileQueuePiBridgeClient.fromWorkingDir(workingDir));
		this.bridgeClient = bridgeClientFactory(this.workingDir);
		this.createStore = config.createStore ?? ((workingDir, botToken) => new ChannelStore({ workingDir, botToken }));
	}

	isRunning(channelId: string): boolean {
		const state = this.channelStates.get(channelId);
		return state?.running ?? false;
	}

	async handleStop(channelId: string, slack: SlackBot): Promise<void> {
		const state = this.channelStates.get(channelId);
		if (state?.running) {
			state.stopRequested = true;
			state.abortController?.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts;
			return;
		}
		await slack.postMessage(channelId, "_Nothing running_");
	}

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		const hasText = event.text.trim().length > 0;
		const hasAttachments = (event.attachments?.length || 0) > 0;

		if (!hasText && !hasAttachments) {
			log.logInfo(`[${event.channel}] Ignoring empty message`);
			return;
		}

		const state = this.getOrCreateState(event.channel);
		state.running = true;
		state.stopRequested = false;
		state.abortController = new AbortController();
		this.activeRuns += 1;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		const ctx = createSlackContext(event, slack, state, isEvent);

		try {
			await ctx.setTyping(true);
			await ctx.replaceMessage("收到，我开始处理了。");
			await ctx.setWorking(true);

			let lastStatusKey = "";
			const result = await this.bridgeClient.request(
				{
					channelId: event.channel,
					threadTs: event.threadTs,
					userId: event.user,
					userName: slack.getUser(event.user)?.userName,
					text: event.text,
					attachments: (event.attachments ?? []).map((attachment) => attachment.local),
					isEvent: Boolean(isEvent),
					ts: event.ts,
				},
				state.abortController.signal,
				async (status) => {
					if (state.stopRequested) {
						return;
					}
					const key = `${status.phase}:${status.updatedAt}:${status.text}`;
					if (key === lastStatusKey) {
						return;
					}
					lastStatusKey = key;
					const progressText = formatStatusUpdate(status);
					if (progressText.length > 0) {
						await ctx.replaceMessage(progressText);
					}
				},
			);

			if (!state.stopRequested) {
				const responseText = result.text.trim();
				if (responseText.length > 0) {
					const chunks = splitTextIntoChunks(responseText, SLACK_REPLY_CHUNK_SIZE);
					if (chunks.length === 1) {
						await ctx.respond(responseText, true);
					} else {
						await ctx.replaceMessage(chunks[0]);
						for (let index = 1; index < chunks.length; index += 1) {
							const header = `_(续 ${index + 1}/${chunks.length})_\n`;
							await ctx.respondInThread(`${header}${chunks[index]}`);
						}
					}
				} else {
					await ctx.respond("_已处理完成，但 pi 没有返回文本结果。_", true);
				}
			}

			await ctx.setWorking(false);

			if (state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			if (!isAbortError(err) || !state.stopRequested) {
				const errorMessage = err instanceof Error ? err.message : String(err);
				log.logWarning(`[${event.channel}] Run error`, errorMessage);
				try {
					await ctx.replaceMessage(`_处理失败: ${errorMessage}_`);
					await ctx.setWorking(false);
				} catch {
					// Slack best-effort.
				}
			}

			if (state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} finally {
			state.running = false;
			state.abortController = undefined;
			this.activeRuns = Math.max(0, this.activeRuns - 1);
			if (this.activeRuns === 0) {
				for (const resolve of this.idleResolvers.splice(0)) {
					resolve();
				}
			}
		}
	}

	async waitForIdle(timeoutMs = 5000): Promise<boolean> {
		if (this.activeRuns === 0) {
			return true;
		}

		await Promise.race([
			new Promise<void>((resolve) => {
				this.idleResolvers.push(resolve);
			}),
			new Promise<void>((resolve) => setTimeout(resolve, timeoutMs)),
		]);

		return this.activeRuns === 0;
	}

	private getOrCreateState(channelId: string): ChannelState {
		let state = this.channelStates.get(channelId);
		if (state) {
			return state;
		}

		state = {
			running: false,
			store: this.createStore(this.workingDir, this.botToken),
			stopRequested: false,
		};
		this.channelStates.set(channelId, state);
		return state;
	}
}

function formatStatusUpdate(status: PiBridgeStatus): string {
	if (status.text.trim().length > 0) {
		return status.text.trim();
	}

	switch (status.phase) {
		case "received":
			return "收到，我开始处理了。";
		case "queued":
			return "我已经接单，正在排队执行。";
		case "running":
			return "我正在处理中。";
		case "tool":
			return "我正在执行关键步骤。";
		case "waiting":
			return "我还在继续处理，没有卡住。";
		case "completed":
			return "处理完成，正在整理结果。";
		case "failed":
			return "处理中出现异常，我正在整理错误信息。";
		default:
			return "我还在处理中。";
	}
}

function splitTextIntoChunks(text: string, maxLength: number): string[] {
	if (text.length <= maxLength) {
		return [text];
	}

	const chunks: string[] = [];
	let remaining = text;

	while (remaining.length > maxLength) {
		let splitIndex = remaining.lastIndexOf("\n\n", maxLength);
		if (splitIndex < Math.floor(maxLength * 0.4)) {
			splitIndex = remaining.lastIndexOf("\n", maxLength);
		}
		if (splitIndex < Math.floor(maxLength * 0.6)) {
			splitIndex = remaining.lastIndexOf(" ", maxLength);
		}
		if (splitIndex <= 0) {
			splitIndex = maxLength;
		}

		chunks.push(remaining.slice(0, splitIndex).trimEnd());
		remaining = remaining.slice(splitIndex).trimStart();
	}

	if (remaining.length > 0) {
		chunks.push(remaining);
	}

	return chunks.length > 0 ? chunks : [text];
}

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
