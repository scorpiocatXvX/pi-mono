import assert from "node:assert/strict";
import test from "node:test";
import { MomRunService } from "../../src/services/mom-run-service.js";
import type { PiBridgeClient } from "../../src/services/pi-bridge-client.js";
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

test("run service processes event triggers", async () => {
	let bridgeCalls = 0;
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "event handled" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
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
	assert.equal(bridgeCalls, 1);
});

test("run service processes plain messages", async () => {
	let bridgeCalls = 0;
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "plain handled" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
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
	assert.equal(bridgeCalls, 1);
	assert.equal(service.isRunning("C1"), false);
});

test("run service processes attachment-only messages", async () => {
	let bridgeCalls = 0;
	const bridgeClient: PiBridgeClient = {
		request: async () => {
			bridgeCalls += 1;
			return { text: "attachment handled" };
		},
	};

	const service = new MomRunService({
		workingDir: "/tmp/mom-test",
		sandbox: { type: "host" },
		botToken: "token",
		createBridgeClient: () => bridgeClient,
		createStore: () => ({}) as ChannelStore,
	});

	const event: SlackEvent = {
		type: "mention",
		channel: "C1",
		ts: "1000.0",
		user: "U1",
		text: "",
		attachments: [{ original: "report.pdf", local: "attachments/report.pdf" }],
	};

	await service.handleEvent(event, createSlackDouble(), false);
	assert.equal(bridgeCalls, 1);
});
