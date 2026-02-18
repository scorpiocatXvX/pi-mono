export type IntentType = "execute" | "question" | "status" | "chat";
export type RiskLevel = "low" | "medium" | "high";
export type ResponseDetailLevel = "brief" | "standard" | "detailed";

export interface UserMessageIntent {
	intentType: IntentType;
	goal: string;
	constraints: string[];
	clarificationsNeeded: string[];
	toneProfileId: string;
}

export interface ExecutionTaskCard {
	objective: string;
	inputs: string[];
	doneCriteria: string[];
	riskLevel: RiskLevel;
	budget: {
		tokenBudget: number;
		timeoutMs: number;
	};
}

export interface ExecutionResult {
	status: "succeeded" | "partial" | "failed";
	artifacts: string[];
	evidence: string[];
	risks: string[];
	nextActions: string[];
	rawResponse: string;
	usage?: {
		conversationInputTokens: number;
		conversationOutputTokens: number;
		executionInputTokens: number;
		executionOutputTokens: number;
	};
}

export interface NarrativeResponse {
	userSummary: string;
	detailLevel: ResponseDetailLevel;
	decisionRequired: boolean;
	followUpPrompt?: string;
}

export interface ConversationProfile {
	id: string;
	tone: "teammate" | "manager" | "support" | "technical";
	verbosity: ResponseDetailLevel;
	interactionPolicy: "execute_then_report" | "confirm_before_execute";
	lexicon: Record<string, string>;
}

export interface ModelRoute {
	conversationModel: "fast" | "balanced" | "quality";
	executionModel: "fast" | "balanced" | "quality";
	strategyVariant: "A" | "B";
}

export interface ConversationContext {
	channelId: string;
	userId: string;
	isEvent: boolean;
	messageTs: string;
}
