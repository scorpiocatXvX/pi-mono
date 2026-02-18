import * as log from "../log.js";
import type { SandboxConfig } from "../sandbox.js";
import type { MomHandler, SlackBot, SlackEvent } from "../slack.js";
import { ChannelStore } from "../store.js";
import { type ConversationAgent, FileConversationAgent } from "./conversation-agent-service.js";
import type {
	ConversationContext,
	ConversationProfile,
	ExecutionTaskCard,
	UserMessageIntent,
} from "./conversation-types.js";
import { DefaultExecutionGateway, type ExecutionGateway } from "./execution-gateway-service.js";
import { FileQueuePiBridgeClient, type PiBridgeClient } from "./pi-bridge-client.js";
import { createSlackContext } from "./slack-context-service.js";

const SLACK_REPLY_CHUNK_SIZE = 30_000;
const EXECUTION_CONFIRMATION_TTL_MS = 10 * 60 * 1000;
const CONFIRMATION_REMINDER_DEBOUNCE_MS = 3000;

interface PendingExecutionApproval {
	intent: UserMessageIntent;
	profile: ConversationProfile;
	taskCard: ExecutionTaskCard;
	bridgeRequest: ReturnType<ExecutionGateway["createBridgeRequest"]>;
	confirmationToken: string;
	createdAtMs: number;
	lastReminderAtMs?: number;
}

interface ChannelState {
	running: boolean;
	store: ChannelStore;
	stopRequested: boolean;
	stopMessageTs?: string;
	abortController?: AbortController;
	pendingExecutionApproval?: PendingExecutionApproval;
}

interface MomRunServiceConfig {
	workingDir: string;
	sandbox: SandboxConfig;
	botToken: string;
	createStore?: (workingDir: string, botToken: string) => ChannelStore;
	createBridgeClient?: (workingDir: string) => PiBridgeClient;
	createConversationAgent?: (workingDir: string) => ConversationAgent;
	createExecutionGateway?: () => ExecutionGateway;
	now?: () => number;
}

export class MomRunService implements MomHandler {
	private readonly workingDir: string;
	private readonly botToken: string;
	private readonly bridgeClient: PiBridgeClient;
	private readonly conversationAgent: ConversationAgent;
	private readonly executionGateway: ExecutionGateway;
	private readonly now: () => number;
	private readonly channelStates = new Map<string, ChannelState>();
	private readonly createStore: (workingDir: string, botToken: string) => ChannelStore;
	private activeRuns = 0;
	private idleResolvers: Array<() => void> = [];

	constructor(config: MomRunServiceConfig) {
		this.workingDir = config.workingDir;
		this.botToken = config.botToken;
		const bridgeClientFactory =
			config.createBridgeClient ?? ((workingDir: string) => FileQueuePiBridgeClient.fromWorkingDir(workingDir));
		const conversationAgentFactory =
			config.createConversationAgent ?? ((workingDir: string) => new FileConversationAgent(workingDir));
		const executionGatewayFactory = config.createExecutionGateway ?? (() => new DefaultExecutionGateway());
		this.bridgeClient = bridgeClientFactory(this.workingDir);
		this.conversationAgent = conversationAgentFactory(this.workingDir);
		this.executionGateway = executionGatewayFactory();
		this.now = config.now ?? (() => Date.now());
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
		const conversationContext: ConversationContext = {
			channelId: event.channel,
			userId: event.user,
			isEvent: Boolean(isEvent),
			messageTs: event.ts,
		};
		const attachments = (event.attachments ?? []).map((attachment) => attachment.local);
		const profile = this.conversationAgent.resolveProfile(conversationContext);

		try {
			let intent: UserMessageIntent;
			let taskCard: ExecutionTaskCard;
			let bridgeRequest: ReturnType<ExecutionGateway["createBridgeRequest"]>;
			let activeProfile = profile;
			const nowMs = this.now();
			const pendingApproval = state.pendingExecutionApproval;
			if (pendingApproval && nowMs - pendingApproval.createdAtMs > EXECUTION_CONFIRMATION_TTL_MS) {
				state.pendingExecutionApproval = undefined;
				await ctx.respond("上一次待确认任务已过期，请重新下达任务。", true);
				return;
			}

			const activePendingApproval = state.pendingExecutionApproval;
			if (activePendingApproval) {
				const confirmation = this.conversationAgent.readConfirmationDecision(event.text);
				if (confirmation.decision === "cancel") {
					if (confirmation.token && confirmation.token !== activePendingApproval.confirmationToken) {
						await ctx.respond(
							`确认码不匹配。请回复“取消 ${activePendingApproval.confirmationToken}”终止。`,
							true,
						);
						return;
					}
					state.pendingExecutionApproval = undefined;
					await ctx.respond("已取消本次执行。你可以继续告诉我新的任务。", true);
					return;
				}
				if (confirmation.decision !== "confirm") {
					if (
						!activePendingApproval.lastReminderAtMs ||
						nowMs - activePendingApproval.lastReminderAtMs >= CONFIRMATION_REMINDER_DEBOUNCE_MS
					) {
						activePendingApproval.lastReminderAtMs = nowMs;
						await ctx.respond(
							`请回复“确认 ${activePendingApproval.confirmationToken}”继续执行，或回复“取消 ${activePendingApproval.confirmationToken}”终止。`,
							true,
						);
					}
					return;
				}
				if (confirmation.token !== activePendingApproval.confirmationToken) {
					await ctx.respond(`确认码不匹配。请回复“确认 ${activePendingApproval.confirmationToken}”继续。`, true);
					return;
				}
				state.pendingExecutionApproval = undefined;
				intent = activePendingApproval.intent;
				taskCard = activePendingApproval.taskCard;
				bridgeRequest = activePendingApproval.bridgeRequest;
				activeProfile = activePendingApproval.profile;
			} else {
				const confirmation = this.conversationAgent.readConfirmationDecision(event.text);
				if (confirmation.decision === "confirm" || confirmation.decision === "cancel") {
					await ctx.respond("当前没有待确认的任务。请先告诉我你希望执行什么。", true);
					return;
				}
				intent = this.conversationAgent.buildIntent(event.text, attachments, profile);
				if (intent.clarificationsNeeded.length > 0) {
					await ctx.respond(intent.clarificationsNeeded.join("\n"), true);
					return;
				}
				taskCard = this.executionGateway.createTaskCard(intent);
				bridgeRequest = this.executionGateway.createBridgeRequest(
					taskCard,
					conversationContext,
					event.text,
					attachments,
				);
				if (this.conversationAgent.requiresExecutionConfirmation(intent, taskCard, profile)) {
					const confirmationToken = createConfirmationToken(event.ts);
					state.pendingExecutionApproval = {
						intent,
						profile,
						taskCard,
						bridgeRequest,
						confirmationToken,
						createdAtMs: nowMs,
					};
					await ctx.respond(this.conversationAgent.buildConfirmationPrompt(taskCard, confirmationToken), true);
					return;
				}
			}

			await ctx.setTyping(true);
			await ctx.replaceMessage(this.conversationAgent.buildAcknowledgement(intent));
			await ctx.setWorking(true);

			let lastStatusKey = "";
			const result = await this.bridgeClient.request(
				{
					...bridgeRequest,
					threadTs: event.threadTs,
					userName: slack.getUser(event.user)?.userName,
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
					const progressText = this.conversationAgent.buildStatusUpdate(status);
					if (progressText.length > 0) {
						await ctx.replaceMessage(progressText);
					}
				},
			);

			if (!state.stopRequested) {
				await this.respondWithNarrative(ctx, intent, result.text, taskCard, activeProfile);
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
					await ctx.replaceMessage(this.conversationAgent.buildFailureMessage(errorMessage));
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

	private async respondWithNarrative(
		ctx: ReturnType<typeof createSlackContext>,
		_intent: UserMessageIntent,
		responseText: string,
		taskCard: ExecutionTaskCard,
		profile: ConversationProfile,
	): Promise<void> {
		const executionResult = this.executionGateway.buildExecutionResult(responseText, taskCard);
		const narrative = this.conversationAgent.buildNarrativeResponse(executionResult, profile);

		if (narrative.userSummary.trim().length === 0) {
			await ctx.respond("_已处理完成，但 pi 没有返回文本结果。_", true);
			return;
		}

		const chunks = splitTextIntoChunks(narrative.userSummary, SLACK_REPLY_CHUNK_SIZE);
		if (chunks.length === 1) {
			await ctx.respond(narrative.userSummary, true);
			return;
		}

		await ctx.replaceMessage(chunks[0]);
		for (let index = 1; index < chunks.length; index += 1) {
			const header = `_(续 ${index + 1}/${chunks.length})_\n`;
			await ctx.respondInThread(`${header}${chunks[index]}`);
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

function createConfirmationToken(messageTs: string): string {
	const compact = messageTs.replace(/[^0-9]/g, "");
	return compact.slice(-6) || "000000";
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
