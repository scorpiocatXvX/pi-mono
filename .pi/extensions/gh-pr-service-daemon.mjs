#!/usr/bin/env node

import { existsSync, mkdirSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { join, resolve } from "node:path";

function sleep(ms) {
	return new Promise((resolvePromise) => {
		setTimeout(resolvePromise, ms);
	});
}

function parseArgs() {
	const args = process.argv.slice(2);
	let cwd = process.cwd();
	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg === "--cwd") {
			const next = args[i + 1];
			if (next) {
				cwd = resolve(next);
				i++;
			}
			continue;
		}
		if (arg.startsWith("--cwd=")) {
			cwd = resolve(arg.slice("--cwd=".length));
		}
	}
	return { cwd };
}

function getPaths(cwd) {
	const stateDir = join(cwd, ".pi", "gh-pr-service");
	return {
		cwd,
		stateDir,
		pidFile: join(stateDir, "service.pid"),
		requestsDir: join(stateDir, "requests"),
		responsesDir: join(stateDir, "responses"),
	};
}

function ensureStateDirs(paths) {
	mkdirSync(paths.requestsDir, { recursive: true });
	mkdirSync(paths.responsesDir, { recursive: true });
}

function readPid(pidFile) {
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

function isProcessAlive(pid) {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

function claimPidFile(pidFile) {
	const existingPid = readPid(pidFile);
	if (existingPid && isProcessAlive(existingPid)) {
		throw new Error(`gh-pr-service already running (pid ${existingPid})`);
	}
	writeFileSync(pidFile, `${process.pid}\n`, "utf8");
}

function clearPidFile(pidFile) {
	if (existsSync(pidFile)) {
		unlinkSync(pidFile);
	}
}

function runGit(cwd, args) {
	const result = spawnSync("git", args, {
		cwd,
		encoding: "utf8",
	});
	if (result.error) {
		throw new Error(`git ${args.join(" ")} failed: ${result.error.message}`);
	}
	if (result.status !== 0) {
		const stderr = (result.stderr || "").trim();
		throw new Error(stderr || `git ${args.join(" ")} exited with code ${result.status}`);
	}
	return (result.stdout || "").trim();
}

function parseGithubRepoFromRemote(remoteUrl) {
	const trimmed = remoteUrl.trim();
	const sshMatch = /^git@github\.com:([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
	if (sshMatch) {
		return { owner: sshMatch[1], repo: sshMatch[2] };
	}
	const httpsMatch = /^https:\/\/github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
	if (httpsMatch) {
		return { owner: httpsMatch[1], repo: httpsMatch[2] };
	}
	const sshUrlMatch = /^ssh:\/\/git@github\.com\/([^/]+)\/(.+?)(?:\.git)?$/.exec(trimmed);
	if (sshUrlMatch) {
		return { owner: sshUrlMatch[1], repo: sshUrlMatch[2] };
	}
	throw new Error(`Unsupported origin remote URL: ${trimmed}`);
}

function readDotEnvToken(cwd) {
	const envPath = join(cwd, ".env");
	if (!existsSync(envPath)) return undefined;
	const lines = readFileSync(envPath, "utf8").split(/\r?\n/);
	for (const line of lines) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const index = trimmed.indexOf("=");
		if (index <= 0) continue;
		const key = trimmed.slice(0, index).trim();
		if (key !== "GITHUB_TOKEN" && key !== "GH_TOKEN") continue;
		let value = trimmed.slice(index + 1).trim();
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		if (value) return value;
	}
	return undefined;
}

function resolveGithubToken(cwd) {
	const token = process.env.GITHUB_TOKEN?.trim() || process.env.GH_TOKEN?.trim() || readDotEnvToken(cwd);
	if (!token) {
		throw new Error("Missing GITHUB_TOKEN/GH_TOKEN. Set env var or add GITHUB_TOKEN to .env");
	}
	return token;
}

async function githubRequest({ token, method, url, body }) {
	const response = await fetch(url, {
		method,
		headers: {
			Authorization: `token ${token}`,
			Accept: "application/vnd.github+json",
			"User-Agent": "pi-gh-pr-service",
			"Content-Type": "application/json",
		},
		body: body ? JSON.stringify(body) : undefined,
	});

	const text = await response.text();
	let data;
	try {
		data = text ? JSON.parse(text) : {};
	} catch {
		data = { raw: text };
	}

	if (!response.ok) {
		const message =
			typeof data?.message === "string"
				? data.message
				: `GitHub API request failed (${method} ${url})`;
		const detail =
			Array.isArray(data?.errors) && data.errors.length > 0
				? typeof data.errors[0] === "string"
					? data.errors[0]
					: typeof data.errors[0]?.message === "string"
						? data.errors[0].message
						: ""
				: "";
		throw new Error(`${detail ? `${message}: ${detail}` : message} (HTTP ${response.status})`);
	}
	return data;
}

async function findExistingOpenPr({ token, owner, repo, base, head }) {
	const pulls = await githubRequest({
		token,
		method: "GET",
		url: `https://api.github.com/repos/${owner}/${repo}/pulls?state=open&base=${encodeURIComponent(base)}&per_page=100`,
	});

	if (!Array.isArray(pulls)) return undefined;
	return pulls.find((pr) => pr?.head?.ref === head && pr?.base?.ref === base);
}

function generateSummaryBody(cwd, base, head) {
	runGit(cwd, ["fetch", "origin", "--prune"]);
	const commitRange = `origin/${base}..origin/${head}`;
	const diffRange = `origin/${base}...origin/${head}`;

	const commitLines = runGit(cwd, ["log", "--oneline", "--no-merges", commitRange])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
	const diffLines = runGit(cwd, ["diff", "--stat", diffRange])
		.split("\n")
		.map((line) => line.trimEnd())
		.filter(Boolean);

	const limitedDiffLines = diffLines.slice(0, 200);
	const hasMoreDiffLines = diffLines.length > limitedDiffLines.length;

	return [
		"## 变更说明",
		"",
		`- base: \`${base}\``,
		`- head: \`${head}\``,
		`- commits: ${commitLines.length}`,
		`- generated-at: ${new Date().toISOString()}`,
		"",
		"### 提交概览",
		...(commitLines.length > 0 ? commitLines.map((line) => `- ${line}`) : ["- (no commits found in range)"]),
		"",
		"### 文件变更统计 (`git diff --stat`)",
		"```",
		...(limitedDiffLines.length > 0 ? limitedDiffLines : ["(no file changes found in range)"]),
		...(hasMoreDiffLines ? ["... (truncated)"] : []),
		"```",
	].join("\n");
}

function generateDefaultTitle(cwd, base, head) {
	const subjects = runGit(cwd, ["log", "--pretty=%s", "--no-merges", `origin/${base}..origin/${head}`])
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);

	if (subjects.length === 0) return `Merge ${head} into ${base}`;
	if (subjects.length === 1) return subjects[0];

	return `${subjects[0]} (+${subjects.length - 1} commits)`;
}

function normalizeTitle(value, fallback) {
	const normalized = value.replace(/\s+/g, " ").trim();
	if (!normalized) return fallback;
	if (normalized.length <= 240) return normalized;
	return `${normalized.slice(0, 237)}...`;
}

async function handleCreatePr(paths, payload) {
	const { head, base, title } = payload;
	if (!head || !base) {
		throw new Error("create_pr requires head and base");
	}

	const token = resolveGithubToken(paths.cwd);
	const remote = runGit(paths.cwd, ["config", "--get", "remote.origin.url"]);
	const { owner, repo } = parseGithubRepoFromRemote(remote);
	const body = generateSummaryBody(paths.cwd, base, head);
	const autoTitle = generateDefaultTitle(paths.cwd, base, head);
	const prTitle = normalizeTitle(title || autoTitle, `Merge ${head} into ${base}`);

	const existing = await findExistingOpenPr({ token, owner, repo, base, head });
	if (existing) {
		return {
			number: existing.number,
			url: existing.html_url,
			title: existing.title,
			existed: true,
		};
	}

	let created;
	try {
		created = await githubRequest({
			token,
			method: "POST",
			url: `https://api.github.com/repos/${owner}/${repo}/pulls`,
			body: {
				title: prTitle,
				head,
				base,
				body,
			},
		});
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		if (message.toLowerCase().includes("pull request already exists")) {
			const alreadyOpen = await findExistingOpenPr({ token, owner, repo, base, head });
			if (alreadyOpen) {
				return {
					number: alreadyOpen.number,
					url: alreadyOpen.html_url,
					title: alreadyOpen.title,
					existed: true,
				};
			}
		}
		throw error;
	}

	return {
		number: created.number,
		url: created.html_url,
		title: created.title,
		existed: false,
	};
}

async function handleUpdatePr(paths, payload) {
	const { number, head, base } = payload;
	if (!Number.isInteger(number) || number <= 0 || !head || !base) {
		throw new Error("update_pr requires number, head, base");
	}

	const token = resolveGithubToken(paths.cwd);
	const remote = runGit(paths.cwd, ["config", "--get", "remote.origin.url"]);
	const { owner, repo } = parseGithubRepoFromRemote(remote);
	const body = generateSummaryBody(paths.cwd, base, head);

	const updated = await githubRequest({
		token,
		method: "PATCH",
		url: `https://api.github.com/repos/${owner}/${repo}/pulls/${number}`,
		body: { body },
	});

	return {
		number: updated.number,
		url: updated.html_url,
		title: updated.title,
		existed: false,
	};
}

async function processRequest(paths, request) {
	if (!request || typeof request !== "object") {
		throw new Error("Invalid request payload");
	}
	if (request.action === "create_pr") {
		return handleCreatePr(paths, request.payload);
	}
	if (request.action === "update_pr") {
		return handleUpdatePr(paths, request.payload);
	}
	throw new Error(`Unknown action: ${String(request.action)}`);
}

function readRequest(paths, fileName) {
	const path = join(paths.requestsDir, fileName);
	const raw = readFileSync(path, "utf8");
	const parsed = JSON.parse(raw);
	if (!parsed || typeof parsed.id !== "string") {
		throw new Error("Invalid request: missing id");
	}
	return parsed;
}

function writeResponse(paths, requestId, response) {
	const responsePath = join(paths.responsesDir, `${requestId}.json`);
	writeFileSync(responsePath, `${JSON.stringify(response)}\n`, "utf8");
}

async function processQueue(paths) {
	const entries = readdirSync(paths.requestsDir)
		.filter((name) => name.endsWith(".json"))
		.sort((a, b) => a.localeCompare(b));

	for (const entry of entries) {
		const requestPath = join(paths.requestsDir, entry);
		let request;
		try {
			request = readRequest(paths, entry);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			console.error(`[gh-pr-service] invalid request ${entry}: ${message}`);
			unlinkSync(requestPath);
			continue;
		}

		try {
			const data = await processRequest(paths, request);
			writeResponse(paths, request.id, { ok: true, data });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			writeResponse(paths, request.id, { ok: false, error: message });
		} finally {
			unlinkSync(requestPath);
		}
	}
}

const { cwd } = parseArgs();
const paths = getPaths(cwd);
ensureStateDirs(paths);
claimPidFile(paths.pidFile);

let shuttingDown = false;
const shutdown = () => {
	shuttingDown = true;
	clearPidFile(paths.pidFile);
};

process.on("SIGINT", () => {
	shutdown();
	process.exit(0);
});

process.on("SIGTERM", () => {
	shutdown();
	process.exit(0);
});

while (!shuttingDown) {
	try {
		await processQueue(paths);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		console.error(`[gh-pr-service] queue error: ${message}`);
	}
	await sleep(250);
}
