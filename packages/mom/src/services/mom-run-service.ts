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
import { DefaultExecutionRunner, type ExecutionRunner } from "./execution-runner-service.js";
import { DefaultModelRouter, type ModelRouter } from "./model-routing-service.js";
import { DefaultOrchestrator, type Orchestrator } from "./orchestrator-service.js";
import { FileQueuePiBridgeClient, type PiBridgeClient } from "./pi-bridge-client.js";
import { FileRunObservability, type RunObservability } from "./run-observability-service.js";
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
	createExecutionRunner?: (bridgeClient: PiBridgeClient) => ExecutionRunner;
	createModelRouter?: () => ModelRouter;
	createOrchestrator?: () => Orchestrator;
	createObservability?: (workingDir: string) => RunObservability;
	now?: () => number;
}

export class MomRunService implements MomHandler {
	private readonly workingDir: string;
	private readonly botToken: string;
	private readonly bridgeClient: PiBridgeClient;
	private readonly conversationAgent: ConversationAgent;
	private readonly executionGateway: ExecutionGateway;
	private readonly executionRunner: ExecutionRunner;
	private readonly modelRouter: ModelRouter;
	private readonly orchestrator: Orchestrator;
	private readonly observability: RunObservability;
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
		const orchestratorFactory = config.createOrchestrator ?? (() => new DefaultOrchestrator());
		const modelRouterFactory = config.createModelRouter ?? (() => new DefaultModelRouter());
		const observabilityFactory =
			config.createObservability ?? ((workingDir: string) => new FileRunObservability(workingDir));
		this.bridgeClient = bridgeClientFactory(this.workingDir);
		const executionRunnerFactory =
			config.createExecutionRunner ?? ((bridgeClient: PiBridgeClient) => new DefaultExecutionRunner(bridgeClient));
		this.conversationAgent = conversationAgentFactory(this.workingDir);
		this.executionGateway = executionGatewayFactory();
		this.executionRunner = executionRunnerFactory(this.bridgeClient);
		this.modelRouter = modelRouterFactory();
		this.orchestrator = orchestratorFactory();
		this.observability = observabilityFactory(this.workingDir);
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
		let runId = "";

		try {
			let intent: UserMessageIntent;
			let taskCard: ExecutionTaskCard;
			let bridgeRequest: ReturnType<ExecutionGateway["createBridgeRequest"]>;
			let activeProfile = profile;
			let traceStarted = false;
			const nowMs = this.now();
			const pendingApproval = state.pendingExecutionApproval;
			if (pendingApproval && nowMs - pendingApproval.createdAtMs > EXECUTION_CONFIRMATION_TTL_MS) {
				state.pendingExecutionApproval = undefined;
				const expiredRunId = pendingApproval.bridgeRequest.runId;
				if (expiredRunId) {
					this.observability.event(expiredRunId, "confirmation", "approval expired");
					this.observability.finish(expiredRunId, "cancelled");
				}
				await ctx.respond("上一次待确认任务已过期，请重新下达任务。", true);
				return;
			}

			const activePendingApproval = state.pendingExecutionApproval;
			if (activePendingApproval) {
				if (activePendingApproval.bridgeRequest.runId) {
					this.observability.markConfirmation(activePendingApproval.bridgeRequest.runId);
				}
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
					if (activePendingApproval.bridgeRequest.runId) {
						this.observability.event(activePendingApproval.bridgeRequest.runId, "confirmation", "user cancelled");
						this.observability.finish(activePendingApproval.bridgeRequest.runId, "cancelled");
					}
					await ctx.respond("已取消本次执行。你可以继续告诉我新的任务。", true);
					return;
				}
				if (confirmation.decision !== "confirm") {
					if (
						!activePendingApproval.lastReminderAtMs ||
						nowMs - activePendingApproval.lastReminderAtMs >= CONFIRMATION_REMINDER_DEBOUNCE_MS
					) {
						activePendingApproval.lastReminderAtMs = nowMs;
						if (activePendingApproval.bridgeRequest.runId) {
							this.observability.event(
								activePendingApproval.bridgeRequest.runId,
								"confirmation",
								"reminder sent",
							);
						}
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
				runId = bridgeRequest.runId ?? "";
				traceStarted = runId.length > 0;
			} else {
				const confirmation = this.conversationAgent.readConfirmationDecision(event.text);
				if (confirmation.decision === "confirm" || confirmation.decision === "cancel") {
					await ctx.respond("当前没有待确认的任务。请先告诉我你希望执行什么。", true);
					return;
				}
				intent = this.conversationAgent.buildIntent(event.text, attachments, profile);
				if (intent.clarificationsNeeded.length > 0) {
					runId = createRunId(event.ts);
					this.observability.startRun(runId, event.channel, event.user);
					this.observability.markClarification(runId);
					const clarificationText = intent.clarificationsNeeded.join("\n");
					this.observability.recordTokenUsage(
						runId,
						"conversation",
						estimateTokens(event.text),
						estimateTokens(clarificationText),
					);
					await ctx.respond(clarificationText, true);
					this.observability.finish(runId, "cancelled");
					return;
				}
				taskCard = this.executionGateway.createTaskCard(intent);
				const plan = this.orchestrator.buildPlan(intent, taskCard);
				const modelRoute = this.modelRouter.resolveRoute(intent, plan.runId);
				bridgeRequest = this.executionGateway.createBridgeRequest(
					intent,
					taskCard,
					plan,
					conversationContext,
					event.text,
					attachments,
				);
				bridgeRequest.modelRoute = modelRoute;
				runId = bridgeRequest.runId ?? plan.runId;
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
					this.observability.startRun(runId, event.channel, event.user);
					traceStarted = true;
					this.observability.markConfirmation(runId);
					this.observability.event(runId, "model-route", "resolved model route", {
						conversationModel: bridgeRequest.modelRoute?.conversationModel ?? "balanced",
						executionModel: bridgeRequest.modelRoute?.executionModel ?? "quality",
						strategyVariant: bridgeRequest.modelRoute?.strategyVariant ?? "A",
					});
					this.observability.event(runId, "confirmation", "awaiting user approval", {
						token: confirmationToken,
						riskLevel: taskCard.riskLevel,
					});
					await ctx.respond(this.conversationAgent.buildConfirmationPrompt(taskCard, confirmationToken), true);
					return;
				}
			}

			if (!runId) {
				runId = createRunId(event.ts);
			}
			if (!traceStarted) {
				this.observability.startRun(runId, event.channel, event.user);
				traceStarted = true;
			}
			this.observability.recordTokenUsage(runId, "conversation", estimateTokens(event.text), 0);
			this.observability.event(runId, "execution", "dispatching bridge request", {
				riskLevel: taskCard.riskLevel,
				timeoutMs: String(taskCard.budget.timeoutMs),
				planSteps: String(bridgeRequest.executionPlan?.steps.length ?? 0),
			});

			await ctx.setTyping(true);
			await ctx.replaceMessage(this.conversationAgent.buildAcknowledgement(intent));
			await ctx.setWorking(true);

			let lastStatusKey = "";
			const executionResult = await this.executionRunner.executePlan(
				{
					...bridgeRequest,
					threadTs: event.threadTs,
					userName: slack.getUser(event.user)?.userName,
				},
				bridgeRequest.executionPlan ?? {
					runId,
					steps: [],
				},
				taskCard,
				state.abortController.signal,
				async (step, status) => {
					if (state.stopRequested) {
						return;
					}
					const key = `${step.id}:${status.phase}:${status.updatedAt}:${status.text}`;
					if (key === lastStatusKey) {
						return;
					}
					lastStatusKey = key;
					const progressText = this.conversationAgent.buildStatusUpdate(status);
					if (progressText.length > 0) {
						await ctx.replaceMessage(progressText);
					}
					this.observability.recordRoundTrip(runId);
					this.observability.event(runId, `status:${status.phase}`, status.text || "status update", {
						stepId: step.id,
						worker: step.worker,
					});
				},
			);

			this.observability.recordTokenUsage(
				runId,
				"execution",
				executionResult.totalInputTokens,
				executionResult.totalOutputTokens,
			);

			if (!state.stopRequested) {
				this.observability.recordTokenUsage(runId, "conversation", 0, estimateTokens(executionResult.finalText));
				await this.respondWithNarrative(ctx, intent, executionResult.finalText, taskCard, activeProfile);
				this.observability.finish(runId, "succeeded");
			} else {
				this.observability.finish(runId, "cancelled");
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
				this.observability.event(runId, "error", errorMessage);
				this.observability.finish(runId, "failed");
				try {
					await ctx.replaceMessage(this.conversationAgent.buildFailureMessage(errorMessage));
					await ctx.setWorking(false);
				} catch {
					// Slack best-effort.
				}
			} else {
				this.observability.finish(runId, "cancelled");
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

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function createRunId(messageTs: string): string {
	const compact = messageTs.replace(/[^0-9]/g, "");
	return `run-${compact.slice(-12) || "000000000000"}`;
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
