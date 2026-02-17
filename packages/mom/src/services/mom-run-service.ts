import * as log from "../log.js";
import type { SandboxConfig } from "../sandbox.js";
import type { MomHandler, SlackBot, SlackEvent } from "../slack.js";
import { ChannelStore } from "../store.js";
import { FileQueuePiBridgeClient, type PiBridgeClient } from "./pi-bridge-client.js";
import { createSlackContext } from "./slack-context-service.js";

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
			await ctx.setWorking(true);
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
			);

			if (!state.stopRequested) {
				const responseText = result.text.trim();
				if (responseText.length > 0) {
					await ctx.respond(responseText, true);
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
					await ctx.respond(`_处理失败: ${errorMessage}_`, true);
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

function isAbortError(error: unknown): boolean {
	return error instanceof Error && error.name === "AbortError";
}
