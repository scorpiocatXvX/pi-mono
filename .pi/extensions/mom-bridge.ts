import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { AssistantMessage } from "@mariozechner/pi-agent-core";
import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

interface BridgeRequest {
	id: string;
	channelId: string;
	threadTs?: string;
	userId: string;
	userName?: string;
	text: string;
	attachments: string[];
	isEvent: boolean;
	ts: string;
	createdAt: string;
}

interface BridgeResponse {
	id: string;
	ok: boolean;
	text?: string;
	error?: string;
}

interface BridgePaths {
	root: string;
	requestsDir: string;
	responsesDir: string;
}

interface ActiveRequest {
	request: BridgeRequest;
	requestPath: string;
	prompt: string;
	runStarted: boolean;
	lastAssistantText: string;
	lastError?: string;
}

const POLL_INTERVAL_MS = 250;

function getPaths(cwd: string): BridgePaths {
	const root = join(cwd, ".pi", "mom-bridge");
	return {
		root,
		requestsDir: join(root, "requests"),
		responsesDir: join(root, "responses"),
	};
}

function ensurePaths(paths: BridgePaths): void {
	mkdirSync(paths.requestsDir, { recursive: true });
	mkdirSync(paths.responsesDir, { recursive: true });
}

function getMarker(id: string): string {
	return `[MOM_BRIDGE_REQUEST:${id}]`;
}

function formatBridgePrompt(request: BridgeRequest): string {
	const lines: string[] = [
		getMarker(request.id),
		`[channel:${request.channelId}] [user:${request.userName || request.userId}] [ts:${request.ts}]`,
		request.isEvent ? "[source:event]" : "[source:message]",
		request.text || "(empty message)",
	];

	if (request.attachments.length > 0) {
		lines.push("", "<slack_attachments>", ...request.attachments, "</slack_attachments>");
	}

	return lines.join("\n");
}

function readRequest(path: string): BridgeRequest | null {
	try {
		const raw = JSON.parse(readFileSync(path, "utf8")) as Partial<BridgeRequest>;
		if (
			typeof raw.id !== "string" ||
			typeof raw.channelId !== "string" ||
			typeof raw.userId !== "string" ||
			typeof raw.text !== "string" ||
			!Array.isArray(raw.attachments) ||
			typeof raw.isEvent !== "boolean" ||
			typeof raw.ts !== "string" ||
			typeof raw.createdAt !== "string"
		) {
			return null;
		}

		return {
			id: raw.id,
			channelId: raw.channelId,
			threadTs: typeof raw.threadTs === "string" ? raw.threadTs : undefined,
			userId: raw.userId,
			userName: typeof raw.userName === "string" ? raw.userName : undefined,
			text: raw.text,
			attachments: raw.attachments.filter((value): value is string => typeof value === "string"),
			isEvent: raw.isEvent,
			ts: raw.ts,
			createdAt: raw.createdAt,
		};
	} catch {
		return null;
	}
}

function writeResponse(paths: BridgePaths, response: BridgeResponse): void {
	const responseFile = join(paths.responsesDir, `${response.id}.json`);
	writeFileSync(responseFile, `${JSON.stringify(response)}\n`, "utf8");
}

function removeFileIfExists(path: string): void {
	if (existsSync(path)) {
		rmSync(path, { force: true });
	}
}

function extractAssistantText(message: AssistantMessage): string {
	const textParts: string[] = [];
	for (const part of message.content) {
		if (
			part.type === "text" &&
			"text" in part &&
			typeof part.text === "string"
		) {
			textParts.push(part.text);
		}
	}
	return textParts.join("\n");
}

export default function (pi: ExtensionAPI) {
	let extensionCtx: ExtensionContext | null = null;
	let pollTimer: NodeJS.Timeout | undefined;
	let pollRunning = false;
	let activeRequest: ActiveRequest | null = null;

	const finalizeRequest = (paths: BridgePaths, response: BridgeResponse): void => {
		writeResponse(paths, response);
		if (activeRequest) {
			removeFileIfExists(activeRequest.requestPath);
		}
		activeRequest = null;
	};

	const pollOnce = async (): Promise<void> => {
		if (pollRunning || !extensionCtx || activeRequest) {
			return;
		}

		if (!extensionCtx.isIdle() || extensionCtx.hasPendingMessages()) {
			return;
		}

		pollRunning = true;
		try {
			const paths = getPaths(extensionCtx.cwd);
			ensurePaths(paths);

			const entries = readdirSync(paths.requestsDir)
				.filter((entry) => entry.endsWith(".json"))
				.sort((a, b) => a.localeCompare(b));

			if (entries.length === 0) {
				return;
			}

			const requestPath = join(paths.requestsDir, entries[0]);
			const request = readRequest(requestPath);
			if (!request) {
				removeFileIfExists(requestPath);
				return;
			}

			const prompt = formatBridgePrompt(request);
			activeRequest = {
				request,
				requestPath,
				prompt,
				runStarted: false,
				lastAssistantText: "",
			};

			try {
				pi.sendUserMessage(prompt);
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				finalizeRequest(paths, {
					id: request.id,
					ok: false,
					error: `failed to enqueue prompt in pi: ${message}`,
				});
			}
		} finally {
			pollRunning = false;
		}
	};

	pi.on("session_start", async (_event, ctx) => {
		extensionCtx = ctx;
		const paths = getPaths(ctx.cwd);
		ensurePaths(paths);

		if (pollTimer) {
			clearInterval(pollTimer);
		}
		pollTimer = setInterval(() => {
			void pollOnce();
		}, POLL_INTERVAL_MS);
	});

	pi.on("before_agent_start", (event) => {
		if (!activeRequest) {
			return;
		}
		if (event.prompt.startsWith(getMarker(activeRequest.request.id))) {
			activeRequest.runStarted = true;
		}
	});

	pi.on("message_end", (event, ctx) => {
		if (!activeRequest || !activeRequest.runStarted) {
			return;
		}

		if (event.message.role !== "assistant") {
			return;
		}

		const assistantMessage = event.message as AssistantMessage;
		const text = extractAssistantText(assistantMessage).trim();
		if (text.length > 0) {
			activeRequest.lastAssistantText = text;
		}

		if (assistantMessage.stopReason === "error" && assistantMessage.errorMessage) {
			activeRequest.lastError = assistantMessage.errorMessage;
		}

		const paths = getPaths(ctx.cwd);
		ensurePaths(paths);
	});

	pi.on("agent_end", (_event, ctx) => {
		if (!activeRequest || !activeRequest.runStarted) {
			return;
		}

		const paths = getPaths(ctx.cwd);
		ensurePaths(paths);

		if (activeRequest.lastError) {
			finalizeRequest(paths, {
				id: activeRequest.request.id,
				ok: false,
				error: activeRequest.lastError,
			});
			return;
		}

		const text = activeRequest.lastAssistantText.trim();
		if (text.length === 0) {
			finalizeRequest(paths, {
				id: activeRequest.request.id,
				ok: false,
				error: "pi finished without a text response",
			});
			return;
		}

		finalizeRequest(paths, {
			id: activeRequest.request.id,
			ok: true,
			text,
		});
	});

	pi.on("session_shutdown", (_event, ctx) => {
		if (pollTimer) {
			clearInterval(pollTimer);
			pollTimer = undefined;
		}

		if (activeRequest) {
			const paths = getPaths(ctx.cwd);
			ensurePaths(paths);
			finalizeRequest(paths, {
				id: activeRequest.request.id,
				ok: false,
				error: "pi session shut down before completing bridge request",
			});
		}

		extensionCtx = null;
	});
}
