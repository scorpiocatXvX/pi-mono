import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import * as log from "../log.js";
import type {
	ConversationContext,
	ConversationProfile,
	ExecutionResult,
	ExecutionTaskCard,
	NarrativeResponse,
	UserMessageIntent,
} from "./conversation-types.js";
import type { PiBridgeStatus } from "./pi-bridge-client.js";

interface ConversationProfileFile {
	defaults?: Partial<ConversationProfile>;
	users?: Record<string, Partial<ConversationProfile>>;
	channels?: Record<string, Partial<ConversationProfile>>;
}

export interface ConfirmationDecision {
	decision: "confirm" | "cancel" | "unknown";
	token?: string;
}

export interface ConversationAgent {
	resolveProfile(context: ConversationContext): ConversationProfile;
	buildIntent(text: string, attachments: string[], profile: ConversationProfile): UserMessageIntent;
	buildAcknowledgement(intent: UserMessageIntent): string;
	buildStatusUpdate(status: PiBridgeStatus): string;
	buildNarrativeResponse(result: ExecutionResult, profile: ConversationProfile): NarrativeResponse;
	buildFailureMessage(errorMessage: string): string;
	requiresExecutionConfirmation(
		intent: UserMessageIntent,
		taskCard: ExecutionTaskCard,
		profile: ConversationProfile,
	): boolean;
	buildConfirmationPrompt(taskCard: ExecutionTaskCard, confirmationToken: string): string;
	readConfirmationDecision(text: string): ConfirmationDecision;
}

const DEFAULT_PROFILE: ConversationProfile = {
	id: "default",
	tone: "teammate",
	verbosity: "standard",
	interactionPolicy: "execute_then_report",
	lexicon: {},
};

const PROFILE_FILE = "conversation-profiles.json";
const CONFIRM_KEYWORDS = ["确认", "确定", "继续", "yes", "ok"];
const CANCEL_KEYWORDS = ["取消", "停止", "不用了", "no"];
const DANGEROUS_KEYWORDS = ["删除", "重置", "覆盖", "清空", "drop", "reset", "rm"];
const CONFIRM_TOKEN_PATTERN = /(?:确认|confirm|取消|cancel)\s*#?([a-z0-9-]{4,32})/i;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function validatePartialProfile(value: unknown, scope: string): value is Partial<ConversationProfile> {
	if (!isRecord(value)) {
		log.logWarning(`Invalid conversation profile at ${scope}`, "expected object");
		return false;
	}
	if ("tone" in value && value.tone !== undefined && typeof value.tone !== "string") {
		log.logWarning(`Invalid conversation profile at ${scope}`, "tone must be a string");
		return false;
	}
	if ("verbosity" in value && value.verbosity !== undefined && typeof value.verbosity !== "string") {
		log.logWarning(`Invalid conversation profile at ${scope}`, "verbosity must be a string");
		return false;
	}
	if (
		"interactionPolicy" in value &&
		value.interactionPolicy !== undefined &&
		typeof value.interactionPolicy !== "string"
	) {
		log.logWarning(`Invalid conversation profile at ${scope}`, "interactionPolicy must be a string");
		return false;
	}
	if ("lexicon" in value && value.lexicon !== undefined && !isRecord(value.lexicon)) {
		log.logWarning(`Invalid conversation profile at ${scope}`, "lexicon must be an object");
		return false;
	}
	return true;
}

function clampText(text: string): string {
	return text.replace(/\s+/g, " ").trim();
}

function escapeRegExp(text: string): string {
	return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasKeyword(text: string, keyword: string): boolean {
	if (/^[a-z0-9-]+$/i.test(keyword)) {
		const pattern = new RegExp(`\\b${escapeRegExp(keyword)}\\b`, "i");
		return pattern.test(text);
	}
	return text.includes(keyword);
}

function mapLexicon(text: string, lexicon: Record<string, string>): string {
	let output = text;
	for (const [from, to] of Object.entries(lexicon)) {
		if (!from.trim() || !to.trim()) {
			continue;
		}
		output = output.split(from).join(to);
	}
	return output;
}

function mergeProfile(
	base: ConversationProfile,
	patch?: Partial<ConversationProfile>,
	id?: string,
): ConversationProfile {
	if (!patch) {
		return base;
	}
	return {
		id: id ?? base.id,
		tone: patch.tone ?? base.tone,
		verbosity: patch.verbosity ?? base.verbosity,
		interactionPolicy: patch.interactionPolicy ?? base.interactionPolicy,
		lexicon: {
			...base.lexicon,
			...(patch.lexicon ?? {}),
		},
	};
}

function readProfileFile(workingDir: string): ConversationProfileFile {
	const path = join(workingDir, PROFILE_FILE);
	if (!existsSync(path)) {
		return {};
	}
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) {
			log.logWarning(`Invalid ${PROFILE_FILE}`, "top-level value must be an object");
			return {};
		}

		const output: ConversationProfileFile = {};
		if ("defaults" in parsed && validatePartialProfile(parsed.defaults, "defaults")) {
			output.defaults = parsed.defaults;
		}

		if ("channels" in parsed && isRecord(parsed.channels)) {
			output.channels = {};
			for (const [channelId, profile] of Object.entries(parsed.channels)) {
				if (validatePartialProfile(profile, `channels.${channelId}`)) {
					output.channels[channelId] = profile;
				}
			}
		}

		if ("users" in parsed && isRecord(parsed.users)) {
			output.users = {};
			for (const [userId, profile] of Object.entries(parsed.users)) {
				if (validatePartialProfile(profile, `users.${userId}`)) {
					output.users[userId] = profile;
				}
			}
		}

		return output;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		log.logWarning(`Failed to parse ${PROFILE_FILE}`, message);
		return {};
	}
}

export class FileConversationAgent implements ConversationAgent {
	constructor(private readonly workingDir: string) {}

	resolveProfile(context: ConversationContext): ConversationProfile {
		const profileFile = readProfileFile(this.workingDir);
		let profile = mergeProfile(DEFAULT_PROFILE, profileFile.defaults);
		profile = mergeProfile(profile, profileFile.channels?.[context.channelId], `channel:${context.channelId}`);
		profile = mergeProfile(profile, profileFile.users?.[context.userId], `user:${context.userId}`);
		return profile;
	}

	buildIntent(text: string, attachments: string[], profile: ConversationProfile): UserMessageIntent {
		const normalizedText = clampText(text);
		const lowered = normalizedText.toLowerCase();
		let intentType: UserMessageIntent["intentType"] = "execute";
		if (lowered.startsWith("为什么") || lowered.startsWith("为啥") || lowered.includes("怎么")) {
			intentType = "question";
		}
		if (lowered.includes("状态") || lowered.includes("进度") || lowered.includes("好了吗")) {
			intentType = "status";
		}
		if (normalizedText.length <= 4 && attachments.length === 0) {
			intentType = "chat";
		}

		const constraints: string[] = [];
		if (lowered.includes("不要")) {
			constraints.push("respect_negative_constraints");
		}
		if (lowered.includes("优先")) {
			constraints.push("prioritize_requested_scope");
		}

		const clarificationsNeeded: string[] = [];
		if (intentType === "execute" && normalizedText.length === 0 && attachments.length === 0) {
			clarificationsNeeded.push("请告诉我你希望我完成什么任务。");
		}

		return {
			intentType,
			goal: normalizedText || "处理用户请求",
			constraints,
			clarificationsNeeded,
			toneProfileId: profile.id,
		};
	}

	buildAcknowledgement(intent: UserMessageIntent): string {
		if (intent.intentType === "status") {
			return "收到，我先帮你核对当前状态。";
		}
		if (intent.intentType === "question") {
			return "收到，我先梳理问题并给你明确结论。";
		}
		return "收到，我开始处理了。";
	}

	buildStatusUpdate(status: PiBridgeStatus): string {
		const text = status.text.trim();
		if (text.length > 0) {
			return text;
		}

		switch (status.phase) {
			case "received":
				return "我收到了你的消息，正在准备执行。";
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

	buildNarrativeResponse(result: ExecutionResult, profile: ConversationProfile): NarrativeResponse {
		const mappedText = mapLexicon(result.rawResponse.trim(), profile.lexicon);
		const userSummary = mappedText.length > 0 ? mappedText : "已处理完成，但没有可展示的文本结果。";
		return {
			userSummary,
			detailLevel: profile.verbosity,
			decisionRequired: result.status !== "succeeded" && result.nextActions.length > 0,
			followUpPrompt: result.nextActions.length > 0 ? result.nextActions[0] : undefined,
		};
	}

	requiresExecutionConfirmation(
		intent: UserMessageIntent,
		taskCard: ExecutionTaskCard,
		profile: ConversationProfile,
	): boolean {
		if (intent.intentType !== "execute") {
			return false;
		}
		if (profile.interactionPolicy === "confirm_before_execute") {
			return true;
		}
		if (taskCard.riskLevel === "high") {
			return true;
		}
		const loweredGoal = intent.goal.toLowerCase();
		return DANGEROUS_KEYWORDS.some((keyword) => loweredGoal.includes(keyword));
	}

	buildConfirmationPrompt(taskCard: ExecutionTaskCard, confirmationToken: string): string {
		const topInputs = taskCard.inputs.slice(0, 3).map((input) => `- ${input}`);
		const topCriteria = taskCard.doneCriteria.slice(0, 3).map((criteria) => `- ${criteria}`);
		return [
			`这次操作风险等级是 ${taskCard.riskLevel}。`,
			`任务目标：${taskCard.objective}`,
			"关键输入：",
			...(topInputs.length > 0 ? topInputs : ["- (无)"]),
			"验收标准：",
			...(topCriteria.length > 0 ? topCriteria : ["- (无)"]),
			`请回复“确认 ${confirmationToken}”继续，或回复“取消 ${confirmationToken}”终止。`,
		].join("\n");
	}

	readConfirmationDecision(text: string): ConfirmationDecision {
		const normalized = clampText(text);
		if (CANCEL_KEYWORDS.some((keyword) => hasKeyword(normalized, keyword))) {
			const tokenMatch = CONFIRM_TOKEN_PATTERN.exec(normalized);
			return {
				decision: "cancel",
				token: tokenMatch?.[1]?.toLowerCase(),
			};
		}
		if (CONFIRM_KEYWORDS.some((keyword) => hasKeyword(normalized, keyword))) {
			const tokenMatch = CONFIRM_TOKEN_PATTERN.exec(normalized);
			return {
				decision: "confirm",
				token: tokenMatch?.[1]?.toLowerCase(),
			};
		}
		return { decision: "unknown" };
	}

	buildFailureMessage(errorMessage: string): string {
		const message = clampText(errorMessage);
		return `_处理失败: ${message || "发生未知错误"}_`;
	}
}
