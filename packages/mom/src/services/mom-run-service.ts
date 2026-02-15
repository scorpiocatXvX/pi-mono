import { join } from "path";
import { type AgentRunner, getOrCreateRunner } from "../agent.js";
import * as log from "../log.js";
import type { SandboxConfig } from "../sandbox.js";
import type { MomHandler, SlackBot, SlackEvent } from "../slack.js";
import { ChannelStore } from "../store.js";
import { createSlackContext } from "./slack-context-service.js";

interface ChannelState {
	running: boolean;
	runner: AgentRunner;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
}

interface MomRunServiceConfig {
	workingDir: string;
	sandbox: SandboxConfig;
	botToken: string;
	createRunner?: (sandbox: SandboxConfig, channelId: string, channelDir: string) => AgentRunner;
	createStore?: (workingDir: string, botToken: string) => ChannelStore;
}

export class MomRunService implements MomHandler {
	private readonly workingDir: string;
	private readonly sandbox: SandboxConfig;
	private readonly botToken: string;
	private readonly channelStates = new Map<string, ChannelState>();
	private readonly createRunner: (sandbox: SandboxConfig, channelId: string, channelDir: string) => AgentRunner;
	private readonly createStore: (workingDir: string, botToken: string) => ChannelStore;
	private activeRuns = 0;
	private idleResolvers: Array<() => void> = [];

	constructor(config: MomRunServiceConfig) {
		this.workingDir = config.workingDir;
		this.sandbox = config.sandbox;
		this.botToken = config.botToken;
		this.createRunner = config.createRunner ?? getOrCreateRunner;
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
			state.runner.abort();
			const ts = await slack.postMessage(channelId, "_Stopping..._");
			state.stopMessageTs = ts;
			return;
		}
		await slack.postMessage(channelId, "_Nothing running_");
	}

	async handleEvent(event: SlackEvent, slack: SlackBot, isEvent?: boolean): Promise<void> {
		if (isEvent) {
			log.logInfo(`[${event.channel}] Ignoring non-message event: ${event.text.substring(0, 50)}`);
			return;
		}
		if (!event.text.trim()) {
			log.logInfo(`[${event.channel}] Ignoring empty message`);
			return;
		}
		if ((event.attachments?.length || 0) > 0) {
			log.logInfo(`[${event.channel}] Ignoring non-plain message (attachments)`);
			return;
		}

		const state = this.getOrCreateState(event.channel);
		state.running = true;
		state.stopRequested = false;
		this.activeRuns += 1;

		log.logInfo(`[${event.channel}] Starting run: ${event.text.substring(0, 50)}`);

		try {
			const ctx = createSlackContext(event, slack, state, isEvent);
			await ctx.setTyping(true);
			await ctx.setWorking(true);
			const result = await state.runner.run(ctx as any, state.store);
			await ctx.setWorking(false);

			if (result.stopReason === "aborted" && state.stopRequested) {
				if (state.stopMessageTs) {
					await slack.updateMessage(event.channel, state.stopMessageTs, "_Stopped_");
					state.stopMessageTs = undefined;
				} else {
					await slack.postMessage(event.channel, "_Stopped_");
				}
			}
		} catch (err) {
			log.logWarning(`[${event.channel}] Run error`, err instanceof Error ? err.message : String(err));
		} finally {
			state.running = false;
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

		const channelDir = join(this.workingDir, channelId);
		state = {
			running: false,
			runner: this.createRunner(this.sandbox, channelId, channelDir),
			store: this.createStore(this.workingDir, this.botToken),
			stopRequested: false,
		};
		this.channelStates.set(channelId, state);
		return state;
	}
}
