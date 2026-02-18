import { randomUUID } from "node:crypto";
import type { ExecutionTaskCard, UserMessageIntent } from "./conversation-types.js";

export type WorkerType = "planner" | "coder" | "reviewer" | "tester" | "docs" | "synthesizer";

export interface ExecutionPlanStep {
	id: string;
	worker: WorkerType;
	summary: string;
	dependsOn: string[];
	parallelGroup?: string;
}

export interface ExecutionPlan {
	runId: string;
	steps: ExecutionPlanStep[];
}

export interface Orchestrator {
	buildPlan(intent: UserMessageIntent, taskCard: ExecutionTaskCard): ExecutionPlan;
}

export class DefaultOrchestrator implements Orchestrator {
	buildPlan(intent: UserMessageIntent, taskCard: ExecutionTaskCard): ExecutionPlan {
		const runId = randomUUID();
		const plan: ExecutionPlanStep[] = [];

		const planner = this.createStep("planner", "拆解目标与约束");
		plan.push(planner);

		if (intent.intentType === "execute") {
			const coder = this.createStep("coder", "执行代码/命令修改", [planner.id]);
			const reviewer = this.createStep("reviewer", "审查风险与回归", [coder.id], "verify");
			const tester = this.createStep("tester", "执行验证与检查", [coder.id], "verify");
			const docs = this.createStep("docs", "生成变更说明", [reviewer.id, tester.id]);
			const synth = this.createStep("synthesizer", "汇总执行结果", [docs.id]);
			plan.push(coder, reviewer, tester, docs, synth);
		} else {
			const synth = this.createStep("synthesizer", `整理${taskCard.objective}的答复`, [planner.id]);
			plan.push(synth);
		}

		return {
			runId,
			steps: plan,
		};
	}

	private createStep(
		worker: WorkerType,
		summary: string,
		dependsOn: string[] = [],
		parallelGroup?: string,
	): ExecutionPlanStep {
		return {
			id: randomUUID(),
			worker,
			summary,
			dependsOn,
			parallelGroup,
		};
	}
}
