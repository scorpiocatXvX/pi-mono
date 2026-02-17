import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

function readDotEnvValue(key: string): string | undefined {
	const envPath = join(process.cwd(), ".env");
	if (!existsSync(envPath)) return undefined;

	const envText = readFileSync(envPath, "utf8");
	for (const rawLine of envText.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;
		const match = line.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
		if (!match || match[1] !== key) continue;
		const value = match[2].trim();
		return value.replace(/^['\"]|['\"]$/g, "").trim();
	}

	return undefined;
}

const PACKYCODE_DEFAULT_BASE_URL = "https://codex-api.packycode.com/v1";
const PACKYCODE_BASE_URL =
	process.env.PACKYCODE_BASE_URL?.trim() || readDotEnvValue("PACKYCODE_BASE_URL") || PACKYCODE_DEFAULT_BASE_URL;
const PACKYCODE_API_KEY =
	process.env.PACKYCODE_API_KEY?.trim() || readDotEnvValue("PACKYCODE_API_KEY") || "$PACKYCODE_API_KEY";

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
		apiKey: PACKYCODE_API_KEY,
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
