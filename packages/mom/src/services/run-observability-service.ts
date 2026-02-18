import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export interface RunTraceEvent {
	at: string;
	phase: string;
	detail: string;
	data?: Record<string, string>;
}

export interface RunTrace {
	runId: string;
	channelId: string;
	userId: string;
	startedAt: string;
	endedAt?: string;
	status?: "succeeded" | "failed" | "cancelled";
	clarificationTurns: number;
	confirmationTurns: number;
	roundTrips: number;
	conversationInputTokens: number;
	conversationOutputTokens: number;
	executionInputTokens: number;
	executionOutputTokens: number;
	events: RunTraceEvent[];
}

interface MetricsSnapshot {
	totalRuns: number;
	succeededRuns: number;
	failedRuns: number;
	cancelledRuns: number;
	totalClarificationTurns: number;
	totalConfirmationTurns: number;
	totalRoundTrips: number;
	totalConversationInputTokens: number;
	totalConversationOutputTokens: number;
	totalExecutionInputTokens: number;
	totalExecutionOutputTokens: number;
	totalDurationMs: number;
}

export interface RunObservability {
	startRun(runId: string, channelId: string, userId: string): void;
	event(runId: string, phase: string, detail: string, data?: Record<string, string>): void;
	markClarification(runId: string): void;
	markConfirmation(runId: string): void;
	recordRoundTrip(runId: string): void;
	recordTokenUsage(
		runId: string,
		scope: "conversation" | "execution",
		inputTokens: number,
		outputTokens: number,
	): void;
	finish(runId: string, status: "succeeded" | "failed" | "cancelled"): void;
}

function nowIso(): string {
	return new Date().toISOString();
}

export class FileRunObservability implements RunObservability {
	private readonly tracesDir: string;
	private readonly metricsFile: string;
	private readonly active = new Map<string, RunTrace>();

	constructor(workingDir: string) {
		const root = join(workingDir, "observability");
		this.tracesDir = join(root, "runs");
		this.metricsFile = join(root, "metrics.json");
		mkdirSync(this.tracesDir, { recursive: true });
	}

	startRun(runId: string, channelId: string, userId: string): void {
		this.active.set(runId, {
			runId,
			channelId,
			userId,
			startedAt: nowIso(),
			clarificationTurns: 0,
			confirmationTurns: 0,
			roundTrips: 0,
			conversationInputTokens: 0,
			conversationOutputTokens: 0,
			executionInputTokens: 0,
			executionOutputTokens: 0,
			events: [],
		});
		this.event(runId, "start", "run started");
	}

	event(runId: string, phase: string, detail: string, data?: Record<string, string>): void {
		const trace = this.active.get(runId);
		if (!trace) {
			return;
		}
		trace.events.push({
			at: nowIso(),
			phase,
			detail,
			data,
		});
		this.writeTrace(trace);
	}

	markClarification(runId: string): void {
		const trace = this.active.get(runId);
		if (!trace) {
			return;
		}
		trace.clarificationTurns += 1;
		this.event(runId, "clarification", "clarification requested");
	}

	markConfirmation(runId: string): void {
		const trace = this.active.get(runId);
		if (!trace) {
			return;
		}
		trace.confirmationTurns += 1;
		this.event(runId, "confirmation", "confirmation round updated");
	}

	recordRoundTrip(runId: string): void {
		const trace = this.active.get(runId);
		if (!trace) {
			return;
		}
		trace.roundTrips += 1;
	}

	recordTokenUsage(
		runId: string,
		scope: "conversation" | "execution",
		inputTokens: number,
		outputTokens: number,
	): void {
		const trace = this.active.get(runId);
		if (!trace) {
			return;
		}
		if (scope === "conversation") {
			trace.conversationInputTokens += inputTokens;
			trace.conversationOutputTokens += outputTokens;
		} else {
			trace.executionInputTokens += inputTokens;
			trace.executionOutputTokens += outputTokens;
		}
	}

	finish(runId: string, status: "succeeded" | "failed" | "cancelled"): void {
		const trace = this.active.get(runId);
		if (!trace) {
			return;
		}
		trace.status = status;
		trace.endedAt = nowIso();
		this.event(runId, "finish", `run ${status}`);
		this.writeTrace(trace);
		this.bumpMetrics(status, trace);
		this.active.delete(runId);
	}

	private writeTrace(trace: RunTrace): void {
		const path = join(this.tracesDir, `${trace.runId}.json`);
		writeFileSync(path, `${JSON.stringify(trace, null, 2)}\n`, "utf8");
	}

	private readMetrics(): MetricsSnapshot {
		if (!existsSync(this.metricsFile)) {
			return this.createEmptyMetrics();
		}
		try {
			const parsed = JSON.parse(readFileSync(this.metricsFile, "utf8")) as Partial<MetricsSnapshot>;
			return {
				totalRuns: parsed.totalRuns ?? 0,
				succeededRuns: parsed.succeededRuns ?? 0,
				failedRuns: parsed.failedRuns ?? 0,
				cancelledRuns: parsed.cancelledRuns ?? 0,
				totalClarificationTurns: parsed.totalClarificationTurns ?? 0,
				totalConfirmationTurns: parsed.totalConfirmationTurns ?? 0,
				totalRoundTrips: parsed.totalRoundTrips ?? 0,
				totalConversationInputTokens: parsed.totalConversationInputTokens ?? 0,
				totalConversationOutputTokens: parsed.totalConversationOutputTokens ?? 0,
				totalExecutionInputTokens: parsed.totalExecutionInputTokens ?? 0,
				totalExecutionOutputTokens: parsed.totalExecutionOutputTokens ?? 0,
				totalDurationMs: parsed.totalDurationMs ?? 0,
			};
		} catch {
			return this.createEmptyMetrics();
		}
	}

	private bumpMetrics(status: "succeeded" | "failed" | "cancelled", trace: RunTrace): void {
		const metrics = this.readMetrics();
		metrics.totalRuns += 1;
		if (status === "succeeded") {
			metrics.succeededRuns += 1;
		} else if (status === "failed") {
			metrics.failedRuns += 1;
		} else {
			metrics.cancelledRuns += 1;
		}
		metrics.totalClarificationTurns += trace.clarificationTurns;
		metrics.totalConfirmationTurns += trace.confirmationTurns;
		metrics.totalRoundTrips += trace.roundTrips;
		metrics.totalConversationInputTokens += trace.conversationInputTokens;
		metrics.totalConversationOutputTokens += trace.conversationOutputTokens;
		metrics.totalExecutionInputTokens += trace.executionInputTokens;
		metrics.totalExecutionOutputTokens += trace.executionOutputTokens;
		if (trace.endedAt) {
			const durationMs = new Date(trace.endedAt).getTime() - new Date(trace.startedAt).getTime();
			metrics.totalDurationMs += Math.max(0, durationMs);
		}
		writeFileSync(this.metricsFile, `${JSON.stringify(metrics, null, 2)}\n`, "utf8");
	}

	private createEmptyMetrics(): MetricsSnapshot {
		return {
			totalRuns: 0,
			succeededRuns: 0,
			failedRuns: 0,
			cancelledRuns: 0,
			totalClarificationTurns: 0,
			totalConfirmationTurns: 0,
			totalRoundTrips: 0,
			totalConversationInputTokens: 0,
			totalConversationOutputTokens: 0,
			totalExecutionInputTokens: 0,
			totalExecutionOutputTokens: 0,
			totalDurationMs: 0,
		};
	}
}
