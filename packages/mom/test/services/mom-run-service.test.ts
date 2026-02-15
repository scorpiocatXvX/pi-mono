import assert from "node:assert/strict";
import test from "node:test";
import type { AgentRunner } from "../../src/agent.js";
import { MomRunService } from "../../src/services/mom-run-service.js";
import type { SlackBot, SlackEvent } from "../../src/slack.js";
import type { ChannelStore } from "../../src/store.js";

function createSlackDouble(): SlackBot {
	return {
		getUser: () => ({ id: "U1", userName: "alice", displayName: "Alice" }),
		getChannel: () => ({ id: "C1", name: "general" }),
		getAllChannels: () => [{ id: "C1", name: "general" }],
		getAllUsers: () => [{ id: "U1", userName: "alice", displayName: "Alice" }],
		postMessage: async () => "1000.2",
		updateMessage: async () => {},
		deleteMessage: async () => {},
		uploadFile: async () => {},
		logBotResponse: () => {},
	} as unknown as SlackBot;
}

test("run service ignores non-message event triggers", async () => {
	let runCalls = 0;
	const runner: AgentRunner = {
		run: async () => {
			runCalls += 1;
			return { stopReason: "stop" };
		},
		abort: () => {},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createRunner: () => runner,
		createStore: () => ({}) as ChannelStore,
	});

	const event: SlackEvent = {
		type: "mention",
		channel: "C1",
		ts: "1000.0",
		user: "U1",
		text: "[EVENT:foo:immediate:none] ping",
	};

	await service.handleEvent(event, createSlackDouble(), true);
	assert.equal(runCalls, 0);
});

test("run service processes plain messages", async () => {
	let runCalls = 0;
	const runner: AgentRunner = {
		run: async () => {
			runCalls += 1;
			return { stopReason: "stop" };
		},
		abort: () => {},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createRunner: () => runner,
		createStore: () => ({}) as ChannelStore,
	});

	const event: SlackEvent = {
		type: "mention",
		channel: "C1",
		ts: "1000.0",
		user: "U1",
		text: "hello",
	};

	await service.handleEvent(event, createSlackDouble(), false);
	assert.equal(runCalls, 1);
	assert.equal(service.isRunning("C1"), false);
});
