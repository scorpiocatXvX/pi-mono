import assert from "node:assert/strict";
import test from "node:test";
import type { ConversationAgent } from "../../src/services/conversation-agent-service.js";
import type {
	ConversationProfile,
	ExecutionResult,
	ExecutionTaskCard,
	NarrativeResponse,
	UserMessageIntent,
} from "../../src/services/conversation-types.js";
import type { ExecutionGateway } from "../../src/services/execution-gateway-service.js";
import { MomRunService } from "../../src/services/mom-run-service.js";
import type { PiBridgeClient, PiBridgeStatus } from "../../src/services/pi-bridge-client.js";
import type { SlackBot, SlackEvent } from "../../src/slack.js";
import type { ChannelStore } from "../../src/store.js";

function createSlackDouble(messages?: string[]): SlackBot {
	let tsCounter = 0;
	return {
		getUser: () => ({ id: "U1", userName: "alice", displayName: "Alice" }),
		getChannel: () => ({ id: "C1", name: "general" }),
		getAllChannels: () => [{ id: "C1", name: "general" }],
		getAllUsers: () => [{ id: "U1", userName: "alice", displayName: "Alice" }],
		postMessage: async (_channel: string, text: string) => {
			messages?.push(text);
			tsCounter += 1;
			return `1000.${tsCounter}`;
		},
		updateMessage: async (_channel: string, _ts: string, text: string) => {
			messages?.push(text);
		},
		deleteMessage: async () => {},
		uploadFile: async () => {},
		logBotResponse: () => {},
	} as unknown as SlackBot;
}

function createConversationAgentDouble(confirmBeforeExecute: boolean): ConversationAgent {
	const profile: ConversationProfile = {
		id: "test",
		tone: "teammate",
		verbosity: "standard",
		interactionPolicy: confirmBeforeExecute ? "confirm_before_execute" : "execute_then_report",
		lexicon: {},
	};

	return {
		resolveProfile: () => profile,
		buildIntent: (text: string): UserMessageIntent => ({
			intentType: "execute",
			goal: text,
			constraints: [],
			clarificationsNeeded: [],
			toneProfileId: profile.id,
		}),
		buildAcknowledgement: () => "收到，我开始处理了。",
		buildStatusUpdate: (_status: PiBridgeStatus) => "我正在处理中。",
		buildNarrativeResponse: (result: ExecutionResult): NarrativeResponse => ({
			userSummary: result.rawResponse,
			detailLevel: "standard",
			decisionRequired: false,
		}),
		buildFailureMessage: (errorMessage: string) => `_处理失败: ${errorMessage}_`,
		requiresExecutionConfirmation: () => confirmBeforeExecute,
		buildConfirmationPrompt: (taskCard: ExecutionTaskCard, confirmationToken: string) =>
			`需要确认:${taskCard.objective}:${confirmationToken}`,
		readConfirmationDecision: (text: string) => {
			if (text.includes("确认")) {
				const token = text.split(" ")[1];
				return { decision: "confirm", token } as const;
			}
			if (text.includes("取消")) {
				const token = text.split(" ")[1];
				return { decision: "cancel", token } as const;
			}
			return { decision: "unknown" } as const;
		},
	};
}

function createExecutionGatewayDouble(): ExecutionGateway {
	return {
		createTaskCard: (intent: UserMessageIntent): ExecutionTaskCard => ({
			objective: intent.goal,
			inputs: [intent.goal],
			doneCriteria: ["done"],
			riskLevel: "high",
			budget: { tokenBudget: 1000, timeoutMs: 1000 },
		}),
		createBridgeRequest: (intent, taskCard, plan, context, text, attachments) => ({
			channelId: context.channelId,
			threadTs: undefined,
			userId: context.userId,
			userName: context.userId,
			text,
			attachments,
			isEvent: context.isEvent,
			ts: context.messageTs,
			intent,
			taskCard,
			executionPlan: plan,
			runId: plan.runId,
		}),
		buildExecutionResult: (responseText: string): ExecutionResult => ({
			status: "succeeded",
			artifacts: [],
			evidence: [],
			risks: [],
			nextActions: [],
			rawResponse: responseText,
		}),
	};
}

test("run service processes event triggers", async () => {
	let bridgeCalls = 0;
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "event handled" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
		createStore: () => ({}) as ChannelStore,
	});

	const event: SlackEvent = {
		type: "mention",
		channel: "C1",
		ts: "1000.0",
		user: "U1",
		text: "[EVENT:foo:immediate:none] ping",
	};

	await service.handleEvent(event, createSlackDouble(), true);
	assert.ok(bridgeCalls >= 1);
});

test("run service processes plain messages", async () => {
	let bridgeCalls = 0;
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "plain handled" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
		createStore: () => ({}) as ChannelStore,
	});

	const event: SlackEvent = {
		type: "mention",
		channel: "C1",
		ts: "1000.0",
		user: "U1",
		text: "hello",
	};

	await service.handleEvent(event, createSlackDouble(), false);
	assert.ok(bridgeCalls >= 1);
	assert.equal(service.isRunning("C1"), false);
});

test("run service processes attachment-only messages", async () => {
	let bridgeCalls = 0;
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "attachment handled" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
		createStore: () => ({}) as ChannelStore,
	});

	const event: SlackEvent = {
		type: "mention",
		channel: "C1",
		ts: "1000.0",
		user: "U1",
		text: "",
		attachments: [{ original: "report.pdf", local: "attachments/report.pdf" }],
	};

	await service.handleEvent(event, createSlackDouble(), false);
	assert.ok(bridgeCalls >= 1);
});

test("run service requires confirmation before high-risk execution", async () => {
	let bridgeCalls = 0;
	const messages: string[] = [];
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "confirmed execution done" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
		createStore: () => ({}) as ChannelStore,
		createConversationAgent: () => createConversationAgentDouble(true),
		createExecutionGateway: () => createExecutionGatewayDouble(),
	});

	await service.handleEvent(
		{
			type: "mention",
			channel: "C1",
			ts: "1000.0",
			user: "U1",
			text: "删除旧文件",
		},
		createSlackDouble(messages),
		false,
	);

	assert.equal(bridgeCalls, 0);
	const confirmationMessage = messages.find((message) => message.includes("需要确认"));
	assert.ok(confirmationMessage);
	const confirmationToken = confirmationMessage?.split(":").at(-1);
	assert.ok(confirmationToken);

	await service.handleEvent(
		{
			type: "mention",
			channel: "C1",
			ts: "1001.0",
			user: "U1",
			text: `确认 ${confirmationToken}`,
		},
		createSlackDouble(messages),
		false,
	);

	assert.ok(bridgeCalls >= 1);
	assert.ok(messages.some((message) => message.includes("confirmed execution done")));
});

test("run service rejects mismatched confirmation token", async () => {
	let bridgeCalls = 0;
	const messages: string[] = [];
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "should not run" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
		createStore: () => ({}) as ChannelStore,
		createConversationAgent: () => createConversationAgentDouble(true),
		createExecutionGateway: () => createExecutionGatewayDouble(),
	});

	await service.handleEvent(
		{
			type: "mention",
			channel: "C1",
			ts: "1000.0",
			user: "U1",
			text: "删除旧文件",
		},
		createSlackDouble(messages),
		false,
	);

	await service.handleEvent(
		{
			type: "mention",
			channel: "C1",
			ts: "1001.0",
			user: "U1",
			text: "确认 wrong-token",
		},
		createSlackDouble(messages),
		false,
	);

	assert.equal(bridgeCalls, 0);
	assert.ok(messages.some((message) => message.includes("确认码不匹配")));
});

test("run service clears expired confirmation requests", async () => {
	let bridgeCalls = 0;
	const messages: string[] = [];
	let nowMs = 0;
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "should not run" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
		createStore: () => ({}) as ChannelStore,
		createConversationAgent: () => createConversationAgentDouble(true),
		createExecutionGateway: () => createExecutionGatewayDouble(),
		now: () => nowMs,
	});

	await service.handleEvent(
		{
			type: "mention",
			channel: "C1",
			ts: "1000.0",
			user: "U1",
			text: "删除旧文件",
		},
		createSlackDouble(messages),
		false,
	);

	nowMs = 11 * 60 * 1000;

	await service.handleEvent(
		{
			type: "mention",
			channel: "C1",
			ts: "1001.0",
			user: "U1",
			text: "确认",
		},
		createSlackDouble(messages),
		false,
	);

	assert.equal(bridgeCalls, 0);
	assert.ok(messages.some((message) => message.includes("待确认任务已过期")));
});
