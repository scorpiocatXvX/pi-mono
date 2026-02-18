import type { ExecutionTaskCard } from "./conversation-types.js";
import type { ExecutionPlan, ExecutionPlanStep } from "./orchestrator-service.js";
import type { PiBridgeClient, PiBridgeRequest, PiBridgeStatus } from "./pi-bridge-client.js";

export interface StepExecutionResult {
	stepId: string;
	worker: string;
	text: string;
	inputTokens: number;
	outputTokens: number;
}

export interface PlanExecutionResult {
	finalText: string;
	stepResults: StepExecutionResult[];
	totalInputTokens: number;
	totalOutputTokens: number;
}

export interface ExecutionRunner {
	executePlan(
		baseRequest: PiBridgeRequest,
		plan: ExecutionPlan,
		taskCard: ExecutionTaskCard,
		signal: AbortSignal | undefined,
		onStepStatus: (step: ExecutionPlanStep, status: PiBridgeStatus) => Promise<void>,
	): Promise<PlanExecutionResult>;
}

function estimateTokens(text: string): number {
	return Math.max(1, Math.ceil(text.length / 4));
}

function buildStepPrompt(
	baseText: string,
	step: ExecutionPlanStep,
	taskCard: ExecutionTaskCard,
	priorResults: StepExecutionResult[],
): string {
	const prior = priorResults
		.slice(-4)
		.map((result) => `- [${result.worker}] ${result.text.slice(0, 800)}`)
		.join("\n");

	return [
		`[EXECUTION_STEP:${step.id}]`,
		`Worker: ${step.worker}`,
		`Summary: ${step.summary}`,
		`Objective: ${taskCard.objective}`,
		`Risk: ${taskCard.riskLevel}`,
		`Done Criteria: ${taskCard.doneCriteria.join(" | ")}`,
		"Base Request:",
		baseText,
		"Recent Step Outputs:",
		prior || "- (none)",
		"Return concise structured output with result and risks.",
	].join("\n");
}

function selectReadySteps(
	_completedPlan: ExecutionPlan,
	completed: Set<string>,
	remaining: Map<string, ExecutionPlanStep>,
): ExecutionPlanStep[] {
	const ready: ExecutionPlanStep[] = [];
	for (const step of remaining.values()) {
		if (step.dependsOn.every((dependency) => completed.has(dependency))) {
			ready.push(step);
		}
	}
	return ready;
}

function groupByParallelKey(steps: ExecutionPlanStep[]): ExecutionPlanStep[][] {
	const groups = new Map<string, ExecutionPlanStep[]>();
	for (const step of steps) {
		const key = step.parallelGroup || step.id;
		const list = groups.get(key) ?? [];
		list.push(step);
		groups.set(key, list);
	}
	return Array.from(groups.values());
}

export class DefaultExecutionRunner implements ExecutionRunner {
	constructor(private readonly bridgeClient: PiBridgeClient) {}

	async executePlan(
		baseRequest: PiBridgeRequest,
		plan: ExecutionPlan,
		taskCard: ExecutionTaskCard,
		signal: AbortSignal | undefined,
		onStepStatus: (step: ExecutionPlanStep, status: PiBridgeStatus) => Promise<void>,
	): Promise<PlanExecutionResult> {
		const effectivePlan =
			plan.steps.length > 0
				? plan
				: {
						...plan,
						steps: [
							{
								id: `${plan.runId}-synth`,
								worker: "synthesizer" as const,
								summary: "fallback synthesis",
								dependsOn: [],
							},
						],
					};
		const remaining = new Map(effectivePlan.steps.map((step) => [step.id, step]));
		const completed = new Set<string>();
		const results: StepExecutionResult[] = [];
		let totalInputTokens = 0;
		let totalOutputTokens = 0;

		while (remaining.size > 0) {
			const ready = selectReadySteps(effectivePlan, completed, remaining);
			if (ready.length === 0) {
				throw new Error("execution plan is stuck: unresolved dependencies");
			}
			const groups = groupByParallelKey(ready);

			for (const group of groups) {
				const groupResults = await Promise.all(
					group.map(async (step) => {
						const stepPrompt = buildStepPrompt(baseRequest.text, step, taskCard, results);
						const stepInputTokens = estimateTokens(stepPrompt);
						const projectedInput = totalInputTokens + stepInputTokens;
						if (projectedInput > taskCard.budget.tokenBudget) {
							throw new Error(`token budget exceeded before step ${step.worker}`);
						}

						const response = await this.bridgeClient.request(
							{
								...baseRequest,
								text: stepPrompt,
							},
							signal,
							async (status) => {
								await onStepStatus(step, status);
							},
							{ timeoutMs: taskCard.budget.timeoutMs },
						);

						const outputTokens = estimateTokens(response.text);
						if (projectedInput + totalOutputTokens + outputTokens > taskCard.budget.tokenBudget) {
							throw new Error(`token budget exceeded after step ${step.worker}`);
						}

						return {
							stepId: step.id,
							worker: step.worker,
							text: response.text,
							inputTokens: stepInputTokens,
							outputTokens,
						} satisfies StepExecutionResult;
					}),
				);

				for (const result of groupResults) {
					results.push(result);
					totalInputTokens += result.inputTokens;
					totalOutputTokens += result.outputTokens;
					completed.add(result.stepId);
					remaining.delete(result.stepId);
				}
			}
		}

		const finalStep =
			[...results].reverse().find((result) => result.worker === "synthesizer") ?? results[results.length - 1];
		return {
			finalText: finalStep?.text ?? "",
			stepResults: results,
			totalInputTokens,
			totalOutputTokens,
		};
	}
}
