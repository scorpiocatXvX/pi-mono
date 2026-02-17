import assert from "node:assert/strict";
import test from "node:test";
import { shouldProcessAppMention, shouldProcessMessageEvent } from "../../src/services/slack-event-routing-service.js";

test("app mentions are ignored", () => {
	assert.equal(shouldProcessAppMention(), false);
});

test("channel messages and DMs are processed", () => {
	assert.equal(shouldProcessMessageEvent(false, false), true);
	assert.equal(shouldProcessMessageEvent(false, true), true);
	assert.equal(shouldProcessMessageEvent(true, false), true);
	assert.equal(shouldProcessMessageEvent(true, true), true);
});
