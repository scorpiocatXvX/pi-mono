import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

const PACKYCODE_DEFAULT_BASE_URL = "https://codex-api.packycode.com/v1";
const PACKYCODE_BASE_URL = process.env.PACKYCODE_BASE_URL?.trim() || PACKYCODE_DEFAULT_BASE_URL;

function model(
	id: string,
	name: string,
	contextWindow: number,
	maxTokens: number,
	input: ("text" | "image")[] = ["text", "image"],
) {
	return {
		id,
		name,
		reasoning: true,
		input,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow,
		maxTokens,
	};
}

export default function (pi: ExtensionAPI) {
	pi.registerProvider("packycode", {
		baseUrl: PACKYCODE_BASE_URL,
		apiKey: "sk-xENwzlC1Lg9kNn4kSixnQbj1vlJD9zWo",
		api: "openai-responses",
		models: [
			model("gpt-5.1", "GPT-5.1", 272000, 128000),
			model("gpt-5.1-codex", "GPT-5.1 Codex", 272000, 128000),
			model("gpt-5.1-codex-mini", "GPT-5.1 Codex Mini", 272000, 128000),
			model("gpt-5.1-codex-max", "GPT-5.1 Codex Max", 272000, 128000),
			model("gpt-5.2", "GPT-5.2", 272000, 128000),
			model("gpt-5.2-codex", "GPT-5.2 Codex", 272000, 128000),
			model("gpt-5.3-codex", "GPT-5.3 Codex", 272000, 128000),
			model("gpt-5.3-codex-spark", "GPT-5.3 Codex Spark", 128000, 128000, ["text"]),
		],
	});
}
