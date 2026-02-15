import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI, ExtensionCommandContext } from "@mariozechner/pi-coding-agent";

type NotifyLevel = "info" | "warning" | "error";

interface ServicePaths {
	stateDir: string;
	pidFile: string;
	logFile: string;
	requestsDir: string;
	responsesDir: string;
}

interface ServiceRequest {
	id: string;
	action: "create_pr" | "update_pr";
	payload: CreatePrPayload | UpdatePrPayload;
}

interface ServiceResponse<T> {
	ok: boolean;
	error?: string;
	data?: T;
}

interface CreatePrPayload {
	head: string;
	base: string;
	title?: string;
}

interface UpdatePrPayload {
	number: number;
	head: string;
	base: string;
}

interface PrMutationResult {
	number: number;
	url: string;
	title: string;
	existed?: boolean;
}

const SERVICE_SCRIPT_PATH = fileURLToPath(new URL("./gh-pr-service-daemon.mjs", import.meta.url));
const REQUEST_TIMEOUT_MS = 90_000;

function notify(ctx: ExtensionCommandContext, message: string, level: NotifyLevel): void {
	ctx.ui.notify(message, level);
}

function getPaths(cwd: string): ServicePaths {
	const stateDir = join(cwd, ".pi", "gh-pr-service");
	return {
		stateDir,
		pidFile: join(stateDir, "service.pid"),
		logFile: join(stateDir, "service.log"),
		requestsDir: join(stateDir, "requests"),
		responsesDir: join(stateDir, "responses"),
	};
}

function ensureStateDirs(paths: ServicePaths): void {
	mkdirSync(paths.requestsDir, { recursive: true });
	mkdirSync(paths.responsesDir, { recursive: true });
}

function sleep(ms: number): Promise<void> {
	return new Promise((resolve) => {
		setTimeout(resolve, ms);
	});
}

function readPid(pidFile: string): number | undefined {
	if (!existsSync(pidFile)) return undefined;
	try {
		const raw = readFileSync(pidFile, "utf8").trim();
		const pid = Number(raw);
		if (!Number.isFinite(pid) || pid <= 0) return undefined;
		return pid;
	} catch {
		return undefined;
	}
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function getRunningPid(paths: ServicePaths): number | undefined {
	const pid = readPid(paths.pidFile);
	if (!pid) return undefined;
	if (!isProcessAlive(pid)) return undefined;
	return pid;
}

async function waitForServiceStartup(paths: ServicePaths, timeoutMs = 3_000): Promise<number | undefined> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		const pid = getRunningPid(paths);
		if (pid) return pid;
		await sleep(100);
	}
	return undefined;
}

function startService(paths: ServicePaths, cwd: string): void {
	ensureStateDirs(paths);
	const logFd = openSync(paths.logFile, "a");
	try {
		const child = spawn(process.execPath, [SERVICE_SCRIPT_PATH, "--cwd", cwd], {
			cwd,
			env: process.env,
			detached: true,
			stdio: ["ignore", logFd, logFd],
		});
		child.unref();
	} finally {
		closeSync(logFd);
	}
}

function stopService(paths: ServicePaths): boolean {
	const pid = getRunningPid(paths);
	if (!pid) return false;
	process.kill(pid, "SIGTERM");
	return true;
}

async function ensureServiceRunning(paths: ServicePaths, cwd: string): Promise<number | undefined> {
	const existing = getRunningPid(paths);
	if (existing) return existing;
	startService(paths, cwd);
	return waitForServiceStartup(paths);
}

async function waitForResponseFile<T>(responseFile: string, timeoutMs: number): Promise<ServiceResponse<T>> {
	const start = Date.now();
	while (Date.now() - start < timeoutMs) {
		if (existsSync(responseFile)) {
			try {
				const raw = readFileSync(responseFile, "utf8");
				unlinkSync(responseFile);
				return JSON.parse(raw) as ServiceResponse<T>;
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				return { ok: false, error: `Failed to parse service response: ${message}` };
			}
		}
		await sleep(150);
	}
	return { ok: false, error: `Timed out after ${timeoutMs}ms waiting for service response` };
}

async function sendServiceRequest<T>(paths: ServicePaths, request: ServiceRequest): Promise<ServiceResponse<T>> {
	ensureStateDirs(paths);
	const requestFile = join(paths.requestsDir, `${request.id}.json`);
	const responseFile = join(paths.responsesDir, `${request.id}.json`);
	writeFileSync(requestFile, `${JSON.stringify(request)}\n`, "utf8");
	return waitForResponseFile<T>(responseFile, REQUEST_TIMEOUT_MS);
}

function usageForPrCommand(): string {
	return "Usage: /gh-pr create <head> [base] [title...] | /gh-pr update <number> <head> [base] | /gh-pr ship [base] [commit-message...]";
}

async function runGitStrict(pi: ExtensionAPI, cwd: string, args: string[]): Promise<string> {
	const result = await pi.exec("git", args, { cwd });
	if (result.code !== 0) {
		const output = result.stderr.trim() || result.stdout.trim() || `git ${args.join(" ")} failed`;
		throw new Error(output);
	}
	return result.stdout;
}

function collectUniqueLines(...values: string[]): string[] {
	const set = new Set<string>();
	for (const value of values) {
		const lines = value
			.split(/\r?\n/)
			.map((line) => line.trim())
			.filter(Boolean);
		for (const line of lines) set.add(line);
	}
	return Array.from(set);
}

async function listChangedPaths(pi: ExtensionAPI, cwd: string): Promise<string[]> {
	const [unstaged, staged, untracked] = await Promise.all([
		runGitStrict(pi, cwd, ["diff", "--name-only"]),
		runGitStrict(pi, cwd, ["diff", "--cached", "--name-only"]),
		runGitStrict(pi, cwd, ["ls-files", "--others", "--exclude-standard"]),
	]);
	return collectUniqueLines(unstaged, staged, untracked);
}

function suggestCommitMessage(paths: string[]): string {
	if (paths.length === 0) return "chore: update project files";

	const packageNames = Array.from(
		new Set(
			paths
				.map((path) => /^packages\/([^/]+)\//.exec(path)?.[1])
				.filter((value): value is string => typeof value === "string"),
		),
	);

	if (packageNames.length === 1) {
		if (paths.length === 1) {
			return `chore(${packageNames[0]}): update ${basename(paths[0])}`;
		}
		return `chore(${packageNames[0]}): update ${paths.length} files`;
	}

	if (paths.every((path) => path.startsWith(".pi/"))) {
		return paths.length === 1
			? `chore(pi): update ${basename(paths[0])}`
			: "chore(pi): update local pi automation";
	}

	if (paths.length === 1) {
		return `chore: update ${basename(paths[0])}`;
	}

	return `chore: update ${paths.length} files`;
}

async function stagePaths(pi: ExtensionAPI, cwd: string, paths: string[]): Promise<void> {
	const chunkSize = 100;
	for (let i = 0; i < paths.length; i += chunkSize) {
		const chunk = paths.slice(i, i + chunkSize);
		await runGitStrict(pi, cwd, ["add", "--", ...chunk]);
	}
}

async function getCurrentBranch(pi: ExtensionAPI, cwd: string): Promise<string> {
	const branch = (await runGitStrict(pi, cwd, ["rev-parse", "--abbrev-ref", "HEAD"])).trim();
	if (!branch || branch === "HEAD") {
		throw new Error("Unable to determine current branch (detached HEAD)");
	}
	return branch;
}

async function commitStagedChanges(
	pi: ExtensionAPI,
	cwd: string,
	commitMessage: string,
): Promise<"committed" | "no_changes"> {
	const result = await pi.exec("git", ["commit", "-m", commitMessage], { cwd });
	if (result.code === 0) return "committed";

	const combined = `${result.stdout}\n${result.stderr}`.toLowerCase();
	if (combined.includes("nothing to commit") || combined.includes("no changes added to commit")) {
		return "no_changes";
	}

	throw new Error(result.stderr.trim() || result.stdout.trim() || "git commit failed");
}

export default function (pi: ExtensionAPI) {
	pi.registerCommand("gh-pr-service", {
		description: "Manage standalone GitHub PR service (/gh-pr-service start|stop|restart|status)",
		handler: async (args, ctx) => {
			const command = args.trim() || "status";
			const paths = getPaths(ctx.cwd);

			if (command === "status") {
				const pid = getRunningPid(paths);
				if (!pid) {
					notify(ctx, "gh-pr-service is stopped", "info");
					return;
				}
				notify(ctx, `gh-pr-service is running (pid ${pid})`, "info");
				return;
			}

			if (command === "start") {
				const pid = await ensureServiceRunning(paths, ctx.cwd);
				if (!pid) {
					notify(ctx, `Failed to start gh-pr-service (check ${paths.logFile})`, "error");
					return;
				}
				notify(ctx, `gh-pr-service started (pid ${pid})`, "info");
				return;
			}

			if (command === "stop") {
				const stopped = stopService(paths);
				if (!stopped) {
					notify(ctx, "gh-pr-service is not running", "info");
					return;
				}
				notify(ctx, "gh-pr-service stop requested", "info");
				return;
			}

			if (command === "restart") {
				stopService(paths);
				const pid = await ensureServiceRunning(paths, ctx.cwd);
				if (!pid) {
					notify(ctx, `Failed to restart gh-pr-service (check ${paths.logFile})`, "error");
					return;
				}
				notify(ctx, `gh-pr-service restarted (pid ${pid})`, "info");
				return;
			}

			notify(ctx, "Usage: /gh-pr-service start|stop|restart|status", "error");
		},
	});

	pi.registerCommand("gh-pr", {
		description: "Create/update PR with generated change summary via standalone service",
		handler: async (args, ctx) => {
			const trimmed = args.trim();
			if (!trimmed) {
				notify(ctx, usageForPrCommand(), "error");
				return;
			}

			const parts = trimmed.split(/\s+/);
			const action = parts[0];
			const paths = getPaths(ctx.cwd);
			const pid = await ensureServiceRunning(paths, ctx.cwd);
			if (!pid) {
				notify(ctx, `gh-pr-service is unavailable (check ${paths.logFile})`, "error");
				return;
			}

			if (action === "create") {
				const head = parts[1];
				const base = parts[2] ?? "main";
				const title = parts.slice(3).join(" ").trim() || undefined;
				if (!head) {
					notify(ctx, usageForPrCommand(), "error");
					return;
				}

				const request: ServiceRequest = {
					id: randomUUID(),
					action: "create_pr",
					payload: { head, base, title } satisfies CreatePrPayload,
				};
				const response = await sendServiceRequest<PrMutationResult>(paths, request);
				if (!response.ok || !response.data) {
					notify(ctx, response.error ?? "Failed to create PR", "error");
					return;
				}
				if (response.data.existed) {
					notify(ctx, `PR already exists: #${response.data.number} ${response.data.url}`, "info");
					return;
				}
				notify(ctx, `PR created: #${response.data.number} ${response.data.url}`, "info");
				return;
			}

			if (action === "update") {
				const number = Number(parts[1]);
				const head = parts[2];
				const base = parts[3] ?? "main";
				if (!Number.isInteger(number) || number <= 0 || !head) {
					notify(ctx, usageForPrCommand(), "error");
					return;
				}

				const request: ServiceRequest = {
					id: randomUUID(),
					action: "update_pr",
					payload: { number, head, base } satisfies UpdatePrPayload,
				};
				const response = await sendServiceRequest<PrMutationResult>(paths, request);
				if (!response.ok || !response.data) {
					notify(ctx, response.error ?? "Failed to update PR", "error");
					return;
				}
				notify(ctx, `PR updated: #${response.data.number} ${response.data.url}`, "info");
				return;
			}

			if (action === "ship") {
				try {
					const base = parts[1] ?? "main";
					const manualCommitMessage = parts.slice(2).join(" ").trim();
					const head = await getCurrentBranch(pi, ctx.cwd);

					const changedPaths = await listChangedPaths(pi, ctx.cwd);
					if (changedPaths.length > 0) {
						await stagePaths(pi, ctx.cwd, changedPaths);
						const commitMessage = manualCommitMessage || suggestCommitMessage(changedPaths);
						const commitResult = await commitStagedChanges(pi, ctx.cwd, commitMessage);
						if (commitResult === "committed") {
							notify(ctx, `Committed changes on ${head}: ${commitMessage}`, "info");
						} else {
							notify(ctx, "No staged changes to commit; continuing with push/PR", "info");
						}
					} else {
						notify(ctx, "No local file changes detected; continuing with push/PR", "info");
					}

					await runGitStrict(pi, ctx.cwd, ["push", "-u", "origin", head]);

					const createRequest: ServiceRequest = {
						id: randomUUID(),
						action: "create_pr",
						payload: { head, base } satisfies CreatePrPayload,
					};
					const createResponse = await sendServiceRequest<PrMutationResult>(paths, createRequest);
					if (!createResponse.ok || !createResponse.data) {
						notify(ctx, createResponse.error ?? "Failed to create PR", "error");
						return;
					}

					if (!createResponse.data.existed) {
						notify(ctx, `PR created: #${createResponse.data.number} ${createResponse.data.url}`, "info");
						return;
					}

					const updateRequest: ServiceRequest = {
						id: randomUUID(),
						action: "update_pr",
						payload: {
							number: createResponse.data.number,
							head,
							base,
						} satisfies UpdatePrPayload,
					};
					const updateResponse = await sendServiceRequest<PrMutationResult>(paths, updateRequest);
					if (!updateResponse.ok || !updateResponse.data) {
						notify(
							ctx,
							`PR already exists (#${createResponse.data.number}) but description update failed: ${updateResponse.error ?? "unknown error"}`,
							"warning",
						);
						return;
					}

					notify(
						ctx,
						`PR already existed and was updated: #${updateResponse.data.number} ${updateResponse.data.url}`,
						"info",
					);
					return;
				} catch (error) {
					const message = error instanceof Error ? error.message : String(error);
					notify(ctx, `ship failed: ${message}`, "error");
				}
				return;
			}

			notify(ctx, usageForPrCommand(), "error");
		},
	});
}
