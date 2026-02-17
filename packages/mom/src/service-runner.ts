#!/usr/bin/env node

import { existsSync, unlinkSync, writeFileSync } from "fs";
import { resolve } from "path";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { detectRunningMomService } from "./service-state.js";
import { SlackService } from "./services/slack-service.js";

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
	console.error("Usage: mom-service [--sandbox=host|docker:<name>] <working-directory>");
	process.exit(1);
}

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN) {
	console.error("Missing env: MOM_SLACK_APP_TOKEN, MOM_SLACK_BOT_TOKEN");
	process.exit(1);
}

await validateSandbox(parsedArgs.sandbox);

const runningService = detectRunningMomService(parsedArgs.workingDir);
if (runningService) {
	console.log(`mom service already running via ${runningService.source} (pid ${runningService.pid})`);
	process.exit(0);
}

const stateFile = `${parsedArgs.workingDir}/.mom-service.state.json`;
let cleanedUp = false;

function writeStateFile(): void {
	writeFileSync(stateFile, `${JSON.stringify({ pid: process.pid })}\n`, "utf-8");
}

function cleanupStateFile(): void {
	if (cleanedUp) {
		return;
	}
	cleanedUp = true;
	if (existsSync(stateFile)) {
		unlinkSync(stateFile);
	}
}

const service = new SlackService({
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
});

writeStateFile();
process.on("exit", cleanupStateFile);

process.on("SIGINT", () => {
	void service.stop().finally(() => {
		cleanupStateFile();
		process.exit(0);
	});
});

process.on("SIGTERM", () => {
	void service.stop().finally(() => {
		cleanupStateFile();
		process.exit(0);
	});
});

await service.start();
