import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

const RESPONSE_POLL_INTERVAL_MS = 150;
const DEFAULT_REQUEST_TIMEOUT_MS = 600_000;

export interface PiBridgeRequest {
	channelId: string;
	threadTs?: string;
	userId: string;
	userName?: string;
	text: string;
	attachments: string[];
	isEvent: boolean;
	ts: string;
}

export interface PiBridgeResponse {
	text: string;
}

interface PiBridgeQueuedRequest extends PiBridgeRequest {
	id: string;
	createdAt: string;
}

interface PiBridgeQueuedResponse {
	id: string;
	ok: boolean;
	text?: string;
	error?: string;
}

export interface PiBridgeClient {
	request(request: PiBridgeRequest, signal?: AbortSignal): Promise<PiBridgeResponse>;
}

interface BridgePaths {
	root: string;
	requestsDir: string;
	responsesDir: string;
}

function isAbortError(error: unknown): boolean {
	if (error instanceof Error && error.name === "AbortError") {
		return true;
	}
	return false;
}

function createAbortError(): Error {
	const error = new Error("Bridge request aborted");
	error.name = "AbortError";
	return error;
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

function findWorkspaceRoot(startDir: string): string {
	let current = resolve(startDir);

	while (true) {
		if (existsSync(join(current, ".pi"))) {
			return current;
		}
		const parent = dirname(current);
		if (parent === current) {
			return resolve(startDir);
		}
		current = parent;
	}
}

function getBridgePaths(workspaceRoot: string): BridgePaths {
	const root = join(workspaceRoot, ".pi", "mom-bridge");
	return {
		root,
		requestsDir: join(root, "requests"),
		responsesDir: join(root, "responses"),
	};
}

function ensureBridgePaths(paths: BridgePaths): void {
	mkdirSync(paths.requestsDir, { recursive: true });
	mkdirSync(paths.responsesDir, { recursive: true });
}

async function waitForResponse(
	responseFile: string,
	timeoutMs: number,
	signal?: AbortSignal,
): Promise<PiBridgeQueuedResponse> {
	const start = Date.now();

	while (Date.now() - start < timeoutMs) {
		if (signal?.aborted) {
			throw createAbortError();
		}

		if (existsSync(responseFile)) {
			const raw = readFileSync(responseFile, "utf8");
			return JSON.parse(raw) as PiBridgeQueuedResponse;
		}

		await sleep(RESPONSE_POLL_INTERVAL_MS);
	}

	throw new Error(`Timed out after ${timeoutMs}ms waiting for pi bridge response`);
}

export class FileQueuePiBridgeClient implements PiBridgeClient {
	constructor(
		private readonly workspaceRoot: string,
		private readonly timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
	) {}

	static fromWorkingDir(workingDir: string, timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS): FileQueuePiBridgeClient {
		const workspaceRoot = findWorkspaceRoot(workingDir);
		return new FileQueuePiBridgeClient(workspaceRoot, timeoutMs);
	}

	async request(request: PiBridgeRequest, signal?: AbortSignal): Promise<PiBridgeResponse> {
		const paths = getBridgePaths(this.workspaceRoot);
		ensureBridgePaths(paths);

		const id = randomUUID();
		const requestFile = join(paths.requestsDir, `${id}.json`);
		const responseFile = join(paths.responsesDir, `${id}.json`);

		const payload: PiBridgeQueuedRequest = {
			id,
			createdAt: new Date().toISOString(),
			...request,
		};

		writeFileSync(requestFile, `${JSON.stringify(payload)}\n`, "utf8");

		try {
			const response = await waitForResponse(responseFile, this.timeoutMs, signal);
			if (!response.ok) {
				throw new Error(response.error ?? "pi bridge request failed");
			}

			return {
				text: response.text ?? "",
			};
		} catch (error) {
			if (isAbortError(error)) {
				throw error;
			}
			throw error instanceof Error ? error : new Error(String(error));
		} finally {
			if (existsSync(requestFile)) {
				rmSync(requestFile, { force: true });
			}
			if (existsSync(responseFile)) {
				rmSync(responseFile, { force: true });
			}
		}
	}
}
