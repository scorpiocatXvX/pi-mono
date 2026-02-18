import type { ModelRoute, UserMessageIntent } from "./conversation-types.js";

export interface ModelRouter {
	resolveRoute(intent: UserMessageIntent, seed: string): ModelRoute;
}

function hashSeed(seed: string): number {
	let hash = 0;
	for (let index = 0; index < seed.length; index += 1) {
		hash = (hash * 31 + seed.charCodeAt(index)) >>> 0;
	}
	return hash;
}

export class DefaultModelRouter implements ModelRouter {
	resolveRoute(intent: UserMessageIntent, seed: string): ModelRoute {
		const strategyVariant: ModelRoute["strategyVariant"] = hashSeed(seed) % 2 === 0 ? "A" : "B";

		if (intent.intentType === "status" || intent.intentType === "chat") {
			return {
				conversationModel: "fast",
				executionModel: "fast",
				strategyVariant,
			};
		}
		if (intent.intentType === "question") {
			return {
				conversationModel: "balanced",
				executionModel: "balanced",
				strategyVariant,
			};
		}
		if (intent.goal.includes("重构") || intent.goal.includes("架构") || intent.goal.includes("复杂")) {
			return {
				conversationModel: "balanced",
				executionModel: "quality",
				strategyVariant,
			};
		}
		return {
			conversationModel: "balanced",
			executionModel: "quality",
			strategyVariant,
		};
	}
}
