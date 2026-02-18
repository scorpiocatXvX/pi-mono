import type {
	ConversationContext,
	ExecutionResult,
	ExecutionTaskCard,
	RiskLevel,
	UserMessageIntent,
} from "./conversation-types.js";
import type { ExecutionPlan } from "./orchestrator-service.js";
import type { PiBridgeRequest } from "./pi-bridge-client.js";

export interface ExecutionGateway {
	createTaskCard(intent: UserMessageIntent): ExecutionTaskCard;
	createBridgeRequest(
		intent: UserMessageIntent,
		taskCard: ExecutionTaskCard,
		plan: ExecutionPlan,
		context: ConversationContext,
		text: string,
		attachments: string[],
	): PiBridgeRequest;
	buildExecutionResult(responseText: string, taskCard: ExecutionTaskCard): ExecutionResult;
}

const HIGH_RISK_PATTERNS = [
	"删除",
	"重置",
	"覆盖",
	"清空",
	"drop",
	"reset",
	"rm ",
	"git reset",
	"kill-session",
	"kill ",
	"force",
];

const LOW_RISK_PATTERNS = ["查看", "查询", "状态", "日志", "explain", "review", "list"];

function inferRiskLevel(intent: UserMessageIntent): RiskLevel {
	if (intent.intentType === "status" || intent.intentType === "question") {
		return "low";
	}

	const loweredGoal = intent.goal.toLowerCase();
	if (HIGH_RISK_PATTERNS.some((pattern) => loweredGoal.includes(pattern))) {
		return "high";
	}
	if (LOW_RISK_PATTERNS.some((pattern) => loweredGoal.includes(pattern))) {
		return "low";
	}
	if (intent.constraints.includes("respect_negative_constraints")) {
		return "medium";
	}
	return "medium";
}

export class DefaultExecutionGateway implements ExecutionGateway {
	createTaskCard(intent: UserMessageIntent): ExecutionTaskCard {
		const riskLevel = inferRiskLevel(intent);
		const doneCriteria = ["给出明确结论或可执行结果", "失败时给出原因和下一步建议"];
		if (riskLevel === "high") {
			doneCriteria.push("输出关键风险和回滚建议");
		}
		return {
			objective: intent.goal,
			inputs: [intent.goal, ...intent.constraints],
			doneCriteria,
			riskLevel,
			budget: {
				tokenBudget: riskLevel === "low" ? 12_000 : riskLevel === "high" ? 20_000 : 30_000,
				timeoutMs: riskLevel === "low" ? 180_000 : 600_000,
			},
		};
	}

	createBridgeRequest(
		intent: UserMessageIntent,
		taskCard: ExecutionTaskCard,
		plan: ExecutionPlan,
		context: ConversationContext,
		text: string,
		attachments: string[],
	): PiBridgeRequest {
		return {
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
		};
	}

	buildExecutionResult(responseText: string, taskCard: ExecutionTaskCard): ExecutionResult {
		const normalized = responseText.trim();
		if (normalized.length === 0) {
			return {
				status: "failed",
				artifacts: [],
				evidence: ["pi returned empty response"],
				risks: ["missing_output"],
				nextActions: ["请重试，或缩小任务范围后再执行。"],
				rawResponse: "",
			};
		}

		return {
			status: "succeeded",
			artifacts: [],
			evidence: [`task=${taskCard.objective}`],
			risks: [],
			nextActions: [],
			rawResponse: normalized,
		};
	}
}
