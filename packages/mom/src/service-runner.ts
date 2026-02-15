#!/usr/bin/env node

import { resolve } from "path";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
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

const service = new SlackService({
	workingDir: parsedArgs.workingDir,
	sandbox: parsedArgs.sandbox,
	appToken: MOM_SLACK_APP_TOKEN,
	botToken: MOM_SLACK_BOT_TOKEN,
});

process.on("SIGINT", () => {
	void service.stop().finally(() => process.exit(0));
});

process.on("SIGTERM", () => {
	void service.stop().finally(() => process.exit(0));
});

await service.start();
