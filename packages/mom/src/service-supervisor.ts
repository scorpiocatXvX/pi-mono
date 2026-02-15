#!/usr/bin/env node

import { type ChildProcess, spawn } from "child_process";
import { existsSync, unlinkSync, writeFileSync } from "fs";
import { join, resolve } from "path";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;

interface ParsedArgs {
	workingDir?: string;
	sandbox: SandboxConfig;
}

function parseArgs(): ParsedArgs {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			sandbox = parseSandboxArg(args[++i] || "");
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		}
	}

	return {
		workingDir: workingDir ? resolve(workingDir) : undefined,
		sandbox,
	};
}

const parsedArgs = parseArgs();
if (!parsedArgs.workingDir) {
	console.error("Usage: mom-service-supervisor [--sandbox=host|docker:<name>] <working-directory>");
	process.exit(1);
}

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

await validateSandbox(parsedArgs.sandbox);

const workingDir = parsedArgs.workingDir;
const sandboxArg = parsedArgs.sandbox.type === "host" ? "host" : `docker:${parsedArgs.sandbox.container}`;
const supervisorPidFile = join(workingDir, ".mom-service-supervisor.pid");

const childArgs = ["--import", "tsx", "src/service-runner.ts", `--sandbox=${sandboxArg}`, workingDir];

let child: ChildProcess | null = null;
let shuttingDown = false;
let restarting = false;

function writePidFile(): void {
	writeFileSync(supervisorPidFile, `${process.pid}\n`, "utf-8");
}

function removePidFile(): void {
	if (existsSync(supervisorPidFile)) {
		unlinkSync(supervisorPidFile);
	}
}

function startChild(): void {
	child = spawn(process.execPath, childArgs, {
		cwd: process.cwd(),
		env: process.env,
		stdio: "inherit",
	});

	child.on("exit", (code, signal) => {
		child = null;
		if (!shuttingDown && !restarting) {
			console.error(`[mom-service-supervisor] child exited (code=${code ?? "null"}, signal=${signal ?? "null"})`);
		}
	});
}

async function stopChild(timeoutMs = 8000): Promise<void> {
	if (!child) {
		return;
	}

	const currentChild = child;
	await new Promise<void>((resolvePromise) => {
		const killTimeout = setTimeout(() => {
			if (currentChild.exitCode === null && currentChild.signalCode === null) {
				currentChild.kill("SIGKILL");
			}
		}, timeoutMs);

		currentChild.once("exit", () => {
			clearTimeout(killTimeout);
			resolvePromise();
		});

		currentChild.kill("SIGTERM");
	});
}

async function restartChild(): Promise<void> {
	if (shuttingDown || restarting) {
		return;
	}
	restarting = true;
	await stopChild();
	if (!shuttingDown) {
		startChild();
	}
	restarting = false;
}

async function shutdown(): Promise<void> {
	shuttingDown = true;
	await stopChild(5000);
	removePidFile();
}

process.on("SIGUSR1", () => {
	void restartChild();
});

process.on("SIGINT", () => {
	void shutdown().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
	void shutdown().finally(() => process.exit(0));
});

writePidFile();
startChild();
