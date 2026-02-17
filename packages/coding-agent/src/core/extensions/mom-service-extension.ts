import { spawn } from "node:child_process";
import { closeSync, existsSync, mkdirSync, openSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { ExtensionCommandContext, ExtensionContext, ExtensionFactory } from "./types.js";

type MomServiceAction = "start" | "restart" | "stop" | "status";

interface MomServiceCommand {
	action: MomServiceAction;
	workingDir?: string;
	sandbox?: string;
}

interface MomServiceState {
	pid: number;
	workingDir: string;
	sandbox: string;
	logFile: string;
	startedAt: string;
}

const DEFAULT_SANDBOX = "host";
const DEFAULT_WORKING_DIR = ".mom";
const STATE_FILE_NAME = ".mom-service.state.json";
const SUPERVISOR_PID_FILE_NAME = ".mom-service-supervisor.pid";
const LOG_FILE_NAME = "mom-service.log";

interface RunningMomService {
	source: "mom-service" | "mom-service-supervisor";
	pid: number;
	workingDir: string;
	sandbox?: string;
	logFile?: string;
}

function parseMomServiceArgs(rawArgs: string): { command?: MomServiceCommand; error?: string } {
	const tokens = rawArgs.trim().length === 0 ? [] : rawArgs.trim().split(/\s+/);
	if (tokens.length === 0) {
		return { command: { action: "status" } };
	}

	const actionToken = tokens[0];
	if (actionToken === "help" || actionToken === "--help" || actionToken === "-h") {
		return { error: "help" };
	}
	if (actionToken !== "start" && actionToken !== "restart" && actionToken !== "stop" && actionToken !== "status") {
		return { error: `Unknown action "${actionToken}"` };
	}

	let sandbox: string | undefined;
	let workingDir: string | undefined;

	for (let i = 1; i < tokens.length; i++) {
		const token = tokens[i];
		if (token === "--sandbox") {
			sandbox = tokens[i + 1];
			i++;
			continue;
		}
		if (token.startsWith("--sandbox=")) {
			sandbox = token.slice("--sandbox=".length);
			continue;
		}
		if (!workingDir) {
			workingDir = token;
			continue;
		}
		return { error: `Unexpected argument "${token}"` };
	}

	if ((actionToken === "start" || actionToken === "restart") && sandbox !== undefined && sandbox.length === 0) {
		return { error: "Missing value for --sandbox" };
	}

	return {
		command: {
			action: actionToken,
			workingDir,
			sandbox,
		},
	};
}

function getStateFilePath(workingDir: string): string {
	return join(workingDir, STATE_FILE_NAME);
}

function getSupervisorPidFilePath(workingDir: string): string {
	return join(workingDir, SUPERVISOR_PID_FILE_NAME);
}

function readState(workingDir: string): MomServiceState | null {
	const stateFile = getStateFilePath(workingDir);
	if (!existsSync(stateFile)) {
		return null;
	}

	try {
		const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<MomServiceState>;
		if (
			typeof raw.pid !== "number" ||
			!Number.isFinite(raw.pid) ||
			typeof raw.workingDir !== "string" ||
			typeof raw.sandbox !== "string" ||
			typeof raw.logFile !== "string" ||
			typeof raw.startedAt !== "string"
		) {
			return null;
		}

		return {
			pid: raw.pid,
			workingDir: raw.workingDir,
			sandbox: raw.sandbox,
			logFile: raw.logFile,
			startedAt: raw.startedAt,
		};
	} catch {
		return null;
	}
}

function writeState(state: MomServiceState): void {
	const stateFile = getStateFilePath(state.workingDir);
	mkdirSync(state.workingDir, { recursive: true });
	writeFileSync(stateFile, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

function removeState(workingDir: string): void {
	const stateFile = getStateFilePath(workingDir);
	if (existsSync(stateFile)) {
		unlinkSync(stateFile);
	}
}

function readSupervisorPid(workingDir: string): number | null {
	const pidFile = getSupervisorPidFilePath(workingDir);
	if (!existsSync(pidFile)) {
		return null;
	}

	const raw = readFileSync(pidFile, "utf8").trim();
	const pid = Number(raw);
	if (!Number.isFinite(pid) || pid <= 0) {
		return null;
	}
	return pid;
}

function removeSupervisorPid(workingDir: string): void {
	const pidFile = getSupervisorPidFilePath(workingDir);
	if (!existsSync(pidFile)) {
		return;
	}
	try {
		unlinkSync(pidFile);
	} catch {
		// Ignore cleanup errors.
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

async function waitForProcessExit(pid: number, timeoutMs: number): Promise<boolean> {
	const deadline = Date.now() + timeoutMs;
	while (Date.now() < deadline) {
		if (!isProcessAlive(pid)) {
			return true;
		}
		await new Promise<void>((resolve) => setTimeout(resolve, 100));
	}
	return !isProcessAlive(pid);
}

function getRunningMomService(workingDir: string): RunningMomService | null {
	const state = readState(workingDir);
	if (state && isProcessAlive(state.pid)) {
		return {
			source: "mom-service",
			pid: state.pid,
			workingDir: state.workingDir,
			sandbox: state.sandbox,
			logFile: state.logFile,
		};
	}
	if (state) {
		removeState(workingDir);
	}

	const supervisorPid = readSupervisorPid(workingDir);
	if (supervisorPid && isProcessAlive(supervisorPid)) {
		return {
			source: "mom-service-supervisor",
			pid: supervisorPid,
			workingDir,
		};
	}
	if (supervisorPid) {
		removeSupervisorPid(workingDir);
	}

	return null;
}

function notify(ctx: ExtensionCommandContext, message: string, type: "info" | "warning" | "error" = "info"): void {
	if (ctx.hasUI) {
		ctx.ui.notify(message, type);
		return;
	}
	const logger = type === "error" ? console.error : console.log;
	logger(message);
}

function resolveWorkingDir(ctx: ExtensionContext, maybePath?: string): string {
	const target = maybePath && maybePath.length > 0 ? maybePath : join(ctx.cwd, DEFAULT_WORKING_DIR);
	return resolve(ctx.cwd, target);
}

async function startMomService(ctx: ExtensionContext, workingDir: string, sandbox: string): Promise<string> {
	if (!process.env.MOM_SLACK_APP_TOKEN || !process.env.MOM_SLACK_BOT_TOKEN) {
		throw new Error("Missing MOM_SLACK_APP_TOKEN or MOM_SLACK_BOT_TOKEN");
	}

	const running = getRunningMomService(workingDir);
	if (running) {
		throw new Error(`mom service is already running via ${running.source} (pid ${running.pid})`);
	}

	mkdirSync(workingDir, { recursive: true });
	const logFile = join(workingDir, LOG_FILE_NAME);
	const outFd = openSync(logFile, "a");

	const child = spawn("mom-service", [`--sandbox=${sandbox}`, workingDir], {
		cwd: ctx.cwd,
		detached: true,
		env: process.env,
		stdio: ["ignore", outFd, outFd],
	});
	closeSync(outFd);

	const started = await new Promise<{ ok: boolean; error?: string }>((resolvePromise) => {
		let settled = false;
		const settle = (result: { ok: boolean; error?: string }) => {
			if (!settled) {
				settled = true;
				resolvePromise(result);
			}
		};

		child.once("error", (error) => {
			settle({ ok: false, error: error.message });
		});

		child.once("spawn", () => {
			child.unref();
			setTimeout(() => {
				if (!child.pid || !isProcessAlive(child.pid)) {
					settle({ ok: false, error: "mom-service exited immediately. Check log file." });
					return;
				}
				settle({ ok: true });
			}, 250);
		});
	});

	if (!started.ok || !child.pid) {
		throw new Error(started.error ?? "Failed to start mom-service");
	}

	const state: MomServiceState = {
		pid: child.pid,
		workingDir,
		sandbox,
		logFile,
		startedAt: new Date().toISOString(),
	};
	writeState(state);
	return `started (pid ${state.pid}, sandbox=${sandbox}, dir=${workingDir})`;
}

async function stopMomService(workingDir: string): Promise<string> {
	const running = getRunningMomService(workingDir);
	if (!running) {
		return `stopped (no running service at ${workingDir})`;
	}

	process.kill(running.pid, "SIGTERM");
	const exited = await waitForProcessExit(running.pid, 5000);
	if (!exited) {
		process.kill(running.pid, "SIGKILL");
		await waitForProcessExit(running.pid, 2000);
	}

	if (running.source === "mom-service") {
		removeState(workingDir);
	} else {
		removeSupervisorPid(workingDir);
	}

	return `stopped (pid ${running.pid}, source=${running.source})`;
}

function statusMomService(workingDir: string): string {
	const running = getRunningMomService(workingDir);
	if (!running) {
		return `stopped (no running service at ${workingDir})`;
	}

	if (running.source === "mom-service") {
		return `running (pid ${running.pid}, source=${running.source}, sandbox=${running.sandbox}, dir=${running.workingDir}, log=${running.logFile})`;
	}

	return `running (pid ${running.pid}, source=${running.source}, dir=${running.workingDir})`;
}

function getUsage(): string {
	return "Usage: /mom-service start|restart|stop|status [working-dir] [--sandbox=host|docker:<name>]";
}

export const momServiceExtension: ExtensionFactory = (pi) => {
	let autoStartAttempted = false;

	pi.on("session_start", async (_event, ctx) => {
		if (autoStartAttempted) {
			return;
		}
		autoStartAttempted = true;

		const workingDir = resolveWorkingDir(ctx);
		try {
			await startMomService(ctx, workingDir, DEFAULT_SANDBOX);
		} catch {
			// Auto-start is best-effort; ignore missing env or startup failures.
		}
	});

	pi.registerCommand("mom-service", {
		description: "Manage mom service process (/mom-service start|restart|stop|status)",
		handler: async (args, ctx) => {
			const parsed = parseMomServiceArgs(args);
			if (parsed.error === "help") {
				notify(ctx, getUsage(), "info");
				return;
			}
			if (parsed.error || !parsed.command) {
				notify(ctx, `${parsed.error ?? "Invalid arguments"}. ${getUsage()}`, "error");
				return;
			}

			const command = parsed.command;
			const workingDir = resolveWorkingDir(ctx, command.workingDir);
			const resolvedSandbox = command.sandbox ?? DEFAULT_SANDBOX;

			try {
				if (command.action === "status") {
					notify(ctx, `mom-service: ${statusMomService(workingDir)}`, "info");
					return;
				}

				if (command.action === "stop") {
					const message = await stopMomService(workingDir);
					notify(ctx, `mom-service: ${message}`, "info");
					return;
				}

				if (command.action === "start") {
					const message = await startMomService(ctx, workingDir, resolvedSandbox);
					notify(ctx, `mom-service: ${message}`, "info");
					return;
				}

				const running = getRunningMomService(workingDir);
				if (running?.source === "mom-service-supervisor") {
					process.kill(running.pid, "SIGUSR1");
					notify(ctx, `mom-service: restarted (pid ${running.pid}, source=${running.source})`, "info");
					return;
				}

				const restartSandbox = command.sandbox ?? running?.sandbox ?? DEFAULT_SANDBOX;
				await stopMomService(workingDir);
				const message = await startMomService(ctx, workingDir, restartSandbox);
				notify(ctx, `mom-service: ${message}`, "info");
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				notify(ctx, `mom-service error: ${message}`, "error");
			}
		},
	});
};
