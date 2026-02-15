#!/usr/bin/env node

import { existsSync, readFileSync } from "fs";
import { join, resolve } from "path";

type Action = "restart" | "stop" | "status";

interface ParsedArgs {
	action?: Action;
	workingDir?: string;
}

function parseArgs(): ParsedArgs {
	const [actionArg, workingDirArg] = process.argv.slice(2);
	const action = actionArg as Action | undefined;
	return {
		action,
		workingDir: workingDirArg ? resolve(workingDirArg) : undefined,
	};
}

function usage(): never {
	console.error("Usage: mom-service-ctl <restart|stop|status> <working-directory>");
	process.exit(1);
}

function readSupervisorPid(pidFile: string): number | null {
	if (!existsSync(pidFile)) {
		return null;
	}

	const raw = readFileSync(pidFile, "utf-8").trim();
	const pid = Number(raw);
	if (!Number.isFinite(pid) || pid <= 0) {
		return null;
	}
	return pid;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

const parsed = parseArgs();
if (!parsed.action || !parsed.workingDir) {
	usage();
}

const pidFile = join(parsed.workingDir, ".mom-service-supervisor.pid");
const pid = readSupervisorPid(pidFile);

if (!pid) {
	if (parsed.action === "status") {
		console.log("stopped");
		process.exit(0);
	}
	console.error(`Supervisor pid file not found or invalid: ${pidFile}`);
	process.exit(1);
}

if (!isProcessAlive(pid)) {
	if (parsed.action === "status") {
		console.log("stopped");
		process.exit(0);
	}
	console.error(`Supervisor process is not running (pid ${pid})`);
	process.exit(1);
}

if (parsed.action === "status") {
	console.log(`running (pid ${pid})`);
	process.exit(0);
}

if (parsed.action === "restart") {
	process.kill(pid, "SIGUSR1");
	console.log(`restart requested (pid ${pid})`);
	process.exit(0);
}

process.kill(pid, "SIGTERM");
console.log(`stop requested (pid ${pid})`);
