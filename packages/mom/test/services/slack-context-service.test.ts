import assert from "node:assert/strict";
import test from "node:test";
import { createSlackContext } from "../../src/services/slack-context-service.js";
import type { SlackBot, SlackEvent } from "../../src/slack.js";
import type { ChannelStore } from "../../src/store.js";

test("context responds in main channel with quoted source", async () => {
	const posted: Array<{ channel: string; text: string }> = [];
	const updated: Array<{ channel: string; ts: string; text: string }> = [];
	const logged: Array<{ channel: string; text: string; ts: string }> = [];

	const slack = {
		getUser: () => ({ id: "U1", userName: "alice", displayName: "Alice" }),
		getChannel: () => ({ id: "C1", name: "general" }),
		getAllChannels: () => [{ id: "C1", name: "general" }],
		getAllUsers: () => [{ id: "U1", userName: "alice", displayName: "Alice" }],
		postMessage: async (channel: string, text: string) => {
			posted.push({ channel, text });
			return "1000.1";
		},
		postInThread: async () => "unused",
		updateMessage: async (channel: string, ts: string, text: string) => {
			updated.push({ channel, ts, text });
		},
		deleteMessage: async () => {},
		uploadFile: async () => {},
		logBotResponse: (channel: string, text: string, ts: string) => {
			logged.push({ channel, text, ts });
		},
	} as unknown as SlackBot;

	const event: SlackEvent = {
		type: "mention",
		channel: "C1",
		ts: "1000.0",
		user: "U1",
		text: "hello mom",
	};

	const context = createSlackContext(event, slack, { store: {} as ChannelStore }, false);

	await context.respond("got it");
	await context.setWorking(false);

	assert.equal(posted.length, 1);
	assert.match(posted[0].text, /> \*alice\*/);
	assert.match(posted[0].text, /got it/);
	assert.match(posted[0].text, /\.\.\.$/);
	assert.equal(updated.length, 1);
	assert.equal(logged.length, 1);
});

test("thread messages are replied to in the same thread", async () => {
	const threadedPosts: Array<{ channel: string; threadTs: string; text: string }> = [];
	const updated: Array<{ channel: string; ts: string; text: string }> = [];

	const slack = {
		getUser: () => ({ id: "U1", userName: "alice", displayName: "Alice" }),
		getChannel: () => ({ id: "C1", name: "general" }),
		getAllChannels: () => [{ id: "C1", name: "general" }],
		getAllUsers: () => [{ id: "U1", userName: "alice", displayName: "Alice" }],
		postMessage: async () => "unused",
		postInThread: async (channel: string, threadTs: string, text: string) => {
			threadedPosts.push({ channel, threadTs, text });
			return "2000.2";
		},
		updateMessage: async (channel: string, ts: string, text: string) => {
			updated.push({ channel, ts, text });
		},
		deleteMessage: async () => {},
		uploadFile: async () => {},
		logBotResponse: () => {},
	} as unknown as SlackBot;

	const event: SlackEvent = {
		type: "mention",
		channel: "C1",
		ts: "2000.1",
		threadTs: "1999.9",
		user: "U1",
		text: "follow up",
	};

	const context = createSlackContext(event, slack, { store: {} as ChannelStore }, false);
	await context.respond("reply in thread");
	await context.respondInThread("tool details");
	await context.setWorking(false);

	assert.equal(threadedPosts.length, 2);
	assert.equal(threadedPosts[0].threadTs, "1999.9");
	assert.match(threadedPosts[0].text, /reply in thread/);
	assert.equal(threadedPosts[1].threadTs, "1999.9");
	assert.match(threadedPosts[1].text, /tool details/);
	assert.equal(updated.length, 1);
});
