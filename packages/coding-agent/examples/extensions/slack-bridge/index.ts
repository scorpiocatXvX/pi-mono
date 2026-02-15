/**
 * Slack Bridge Extension
 *
 * Bridges Slack messages into pi and posts assistant replies back to Slack.
 *
 * Supported inbound messages:
 * - Direct messages to the bot
 * - All non-bot channel messages in channels the bot is in
 */

import { chmodSync, existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentMessage } from "@mariozechner/pi-agent-core";
import type { AssistantMessage, TextContent } from "@mariozechner/pi-ai";
import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { SocketModeClient } from "@slack/socket-mode";
import { LogLevel, WebClient } from "@slack/web-api";

interface SlackMessageEvent {
	type: string;
	user?: string;
	text?: string;
	channel?: string;
	ts?: string;
	thread_ts?: string;
	subtype?: string;
	bot_id?: string;
	channel_type?: string;
}

interface SlackEventEnvelope {
	ack: () => Promise<void> | void;
	event: SlackMessageEvent;
}

interface SlackRequest {
	channel: string;
	threadTs?: string;
	text: string;
	userId: string;
}

interface SlackBridgeConfig {
	appToken: string;
	botToken: string;
}

const CONFIG_PATH = join(homedir(), ".pi", "agent", "extensions", "slack-bridge.json");

function isAssistantMessage(message: AgentMessage): message is AssistantMessage {
	return message.role === "assistant" && Array.isArray(message.content);
}

function extractAssistantText(messages: AgentMessage[]): string {
	for (let i = messages.length - 1; i >= 0; i--) {
		const message = messages[i];
		if (!isAssistantMessage(message)) continue;
		const text = message.content
			.filter((block): block is TextContent => block.type === "text")
			.map((block) => block.text)
			.join("\n")
			.trim();
		if (text.length > 0) return text;
	}
	return "_(No assistant text output.)_";
}

function truncateForSlack(text: string, maxChars = 39000): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n\n_(truncated)_`;
}

function stripBotMention(text: string, botUserId: string | undefined): string {
	if (!botUserId) return text.trim();
	const mention = new RegExp(`<@${botUserId}>`, "g");
	return text.replace(mention, "").trim();
}

function formatInboundMessage(request: SlackRequest): string {
	return `[Slack ${request.channel} <@${request.userId}>]\n${request.text}`;
}

const MAX_RECENT_EVENT_KEYS = 200;

function readConfig(): SlackBridgeConfig | undefined {
	if (!existsSync(CONFIG_PATH)) return undefined;
	try {
		const raw = JSON.parse(readFileSync(CONFIG_PATH, "utf-8")) as Partial<SlackBridgeConfig>;
		if (typeof raw.appToken !== "string" || typeof raw.botToken !== "string") return undefined;
		if (!raw.appToken || !raw.botToken) return undefined;
		return { appToken: raw.appToken, botToken: raw.botToken };
	} catch {
		return undefined;
	}
}

function writeConfig(config: SlackBridgeConfig): void {
	mkdirSync(dirname(CONFIG_PATH), { recursive: true });
	writeFileSync(CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf-8", mode: 0o600 });
	chmodSync(CONFIG_PATH, 0o600);
}

function clearConfig(): void {
	if (existsSync(CONFIG_PATH)) {
		unlinkSync(CONFIG_PATH);
	}
}

export default function (pi: ExtensionAPI) {
	const envAppToken = process.env.PI_SLACK_APP_TOKEN ?? process.env.SLACK_APP_TOKEN;
	const envBotToken = process.env.PI_SLACK_BOT_TOKEN ?? process.env.SLACK_BOT_TOKEN;
	const fileConfig = readConfig();

	let appToken = envAppToken ?? fileConfig?.appToken;
	let botToken = envBotToken ?? fileConfig?.botToken;
	let tokenSource: "env" | "file" | "none" =
		appToken && botToken ? (envAppToken && envBotToken ? "env" : "file") : "none";
	let serviceEnabled = true;

	let socketClient: SocketModeClient | undefined;
	let webClient: WebClient | undefined;
	let botUserId: string | undefined;
	let isAgentBusy = false;

	const queue: SlackRequest[] = [];
	let activeRequest: SlackRequest | undefined;
	const recentEventKeys: string[] = [];
	const recentEventKeySet = new Set<string>();

	function isDuplicateEvent(channel: string, ts: string): boolean {
		const key = `${channel}:${ts}`;
		if (recentEventKeySet.has(key)) return true;
		recentEventKeySet.add(key);
		recentEventKeys.push(key);
		if (recentEventKeys.length > MAX_RECENT_EVENT_KEYS) {
			const oldestKey = recentEventKeys.shift();
			if (oldestKey) recentEventKeySet.delete(oldestKey);
		}
		return false;
	}

	function dispatchNext(): void {
		if (isAgentBusy || activeRequest || queue.length === 0) return;
		const next = queue.shift();
		if (!next) return;
		activeRequest = next;
		isAgentBusy = true;
		pi.sendUserMessage(next.text);
	}

	async function postReply(req: SlackRequest, replyText: string): Promise<void> {
		if (!webClient) return;
		await webClient.chat.postMessage({
			channel: req.channel,
			text: truncateForSlack(replyText),
			thread_ts: req.threadTs,
		});
	}

	async function disconnectSlack(): Promise<void> {
		await socketClient?.disconnect();
		socketClient = undefined;
		webClient = undefined;
		botUserId = undefined;
		queue.length = 0;
		recentEventKeys.length = 0;
		recentEventKeySet.clear();
		activeRequest = undefined;
		isAgentBusy = false;
	}

	async function connectSlack(_ctx: ExtensionContext): Promise<boolean> {
		if (!appToken || !botToken) return false;
		if (socketClient && webClient) return true;

		const nextWebClient = new WebClient(botToken, { logLevel: LogLevel.ERROR });
		const nextSocketClient = new SocketModeClient({
			appToken,
			logLevel: LogLevel.ERROR,
		});

		const handleIncomingMessage = async (envelope: SlackEventEnvelope): Promise<void> => {
			try {
				await envelope.ack();
			} catch {
				return;
			}

			const { event } = envelope;
			if (event.type !== "message" && event.type !== "app_mention") return;
			if (!event.user || !event.channel) return;
			if (event.subtype || event.bot_id) return;
			if (event.user === botUserId) return;
			if (!event.ts || isDuplicateEvent(event.channel, event.ts)) return;

			const normalized = stripBotMention(event.text ?? "", botUserId);
			if (!normalized) return;

			const request: SlackRequest = {
				channel: event.channel,
				threadTs: event.thread_ts ?? event.ts,
				text: normalized,
				userId: event.user,
			};

			pi.sendMessage({
				customType: "slack-bridge-inbound",
				content: formatInboundMessage(request),
				display: true,
				details: {
					channel: request.channel,
					threadTs: request.threadTs,
					userId: request.userId,
				},
			});

			queue.push(request);
			dispatchNext();
		};

		nextSocketClient.on("message", handleIncomingMessage);
		nextSocketClient.on("app_mention", handleIncomingMessage);

		try {
			const auth = await nextWebClient.auth.test();
			botUserId = auth.user_id;
			await nextSocketClient.start();
			webClient = nextWebClient;
			socketClient = nextSocketClient;
			return true;
		} catch {
			await nextSocketClient.disconnect();
			botUserId = undefined;
			return false;
		}
	}

	async function promptForTokens(ctx: ExtensionCommandContext): Promise<SlackBridgeConfig | undefined> {
		const app = await ctx.ui.input("Slack app token", "xapp-...");
		if (!app) return undefined;
		const bot = await ctx.ui.input("Slack bot token", "xoxb-...");
		if (!bot) return undefined;
		return { appToken: app.trim(), botToken: bot.trim() };
	}

	function getServiceStatus(): string {
		const connected = socketClient ? "connected" : "disconnected";
		const configured = appToken && botToken ? "configured" : "not configured";
		const mode = serviceEnabled ? "enabled" : "stopped";
		const active = activeRequest ? "busy" : "idle";
		return `Slack bridge: ${configured}, ${connected}, mode=${mode}, source=${tokenSource}, queue=${queue.length}, agent=${active}`;
	}

	pi.registerCommand("slack-token", {
		description: "Configure Slack bridge tokens (/slack-token set|status|clear)",
		handler: async (args, ctx) => {
			const trimmed = args.trim();

			if (!trimmed || trimmed === "status") {
				const connected = socketClient ? "connected" : "disconnected";
				const configured = appToken && botToken ? "configured" : "not configured";
				ctx.ui.notify(`Slack bridge: ${configured}, ${connected}, source=${tokenSource}`, "info");
				return;
			}

			if (trimmed === "clear") {
				appToken = undefined;
				botToken = undefined;
				tokenSource = "none";
				clearConfig();
				await disconnectSlack();
				ctx.ui.notify("Slack bridge tokens cleared and disconnected", "info");
				return;
			}

			if (trimmed === "set") {
				if (!ctx.hasUI) {
					ctx.ui.notify("No interactive UI. Use: /slack-token set <xapp-token> <xoxb-token>", "error");
					return;
				}
				const tokens = await promptForTokens(ctx);
				if (!tokens?.appToken || !tokens.botToken) {
					ctx.ui.notify("Slack token update cancelled", "info");
					return;
				}

				appToken = tokens.appToken;
				botToken = tokens.botToken;
				tokenSource = "file";
				writeConfig(tokens);
				await disconnectSlack();
				if (!serviceEnabled) {
					ctx.ui.notify("Slack bridge tokens saved (service is stopped; run /slack-service start)", "info");
					return;
				}
				const connected = await connectSlack(ctx);
				ctx.ui.notify(
					connected
						? "Slack bridge tokens saved and connected"
						: "Slack bridge tokens saved but connect failed (check tokens and app scopes)",
					connected ? "info" : "error",
				);
				return;
			}

			if (trimmed.startsWith("set ")) {
				const values = trimmed.slice(4).trim().split(/\s+/);
				if (values.length !== 2) {
					ctx.ui.notify("Usage: /slack-token set <xapp-token> <xoxb-token>", "error");
					return;
				}
				const [nextAppToken, nextBotToken] = values;
				appToken = nextAppToken;
				botToken = nextBotToken;
				tokenSource = "file";
				writeConfig({ appToken: nextAppToken, botToken: nextBotToken });
				await disconnectSlack();
				if (!serviceEnabled) {
					ctx.ui.notify("Slack bridge tokens saved (service is stopped; run /slack-service start)", "info");
					return;
				}
				const connected = await connectSlack(ctx);
				ctx.ui.notify(
					connected
						? "Slack bridge tokens saved and connected"
						: "Slack bridge tokens saved but connect failed (check tokens and app scopes)",
					connected ? "info" : "error",
				);
				return;
			}

			ctx.ui.notify("Usage: /slack-token set|status|clear", "error");
		},
	});

	pi.registerCommand("slack-service", {
		description: "Manage Slack bridge service (/slack-service start|stop|restart|status)",
		handler: async (args, ctx) => {
			const command = args.trim() || "status";

			if (command === "status") {
				ctx.ui.notify(getServiceStatus(), "info");
				return;
			}

			if (command === "stop") {
				serviceEnabled = false;
				await disconnectSlack();
				ctx.ui.notify("Slack bridge service stopped", "info");
				return;
			}

			if (command === "start") {
				serviceEnabled = true;
				if (!appToken || !botToken) {
					ctx.ui.notify("Slack bridge is not configured. Run /slack-token set first.", "error");
					return;
				}
				const connected = await connectSlack(ctx);
				ctx.ui.notify(
					connected ? "Slack bridge service started" : "Slack bridge start failed (check tokens/scopes)",
					connected ? "info" : "error",
				);
				return;
			}

			if (command === "restart") {
				serviceEnabled = true;
				await disconnectSlack();
				if (!appToken || !botToken) {
					ctx.ui.notify("Slack bridge is not configured. Run /slack-token set first.", "error");
					return;
				}
				const connected = await connectSlack(ctx);
				ctx.ui.notify(
					connected ? "Slack bridge service restarted" : "Slack bridge restart failed (check tokens/scopes)",
					connected ? "info" : "error",
				);
				return;
			}

			ctx.ui.notify("Usage: /slack-service start|stop|restart|status", "error");
		},
	});

	pi.on("session_start", async (_event, ctx) => {
		if (!serviceEnabled) {
			if (ctx.hasUI) ctx.ui.notify("Slack bridge service is stopped (/slack-service start)", "info");
			return;
		}

		if (!appToken || !botToken) {
			if (ctx.hasUI) {
				ctx.ui.notify(
					"Slack bridge disabled: run /slack-token set (or set PI_SLACK_APP_TOKEN and PI_SLACK_BOT_TOKEN)",
					"warning",
				);
			}
			return;
		}

		const connected = await connectSlack(ctx);
		if (ctx.hasUI) {
			ctx.ui.notify(
				connected ? "Slack bridge connected" : "Slack bridge failed to connect",
				connected ? "info" : "error",
			);
		}
	});

	pi.on("agent_start", async () => {
		isAgentBusy = true;
	});

	pi.on("agent_end", async (event) => {
		isAgentBusy = false;

		const req = activeRequest;
		if (!req) {
			dispatchNext();
			return;
		}
		activeRequest = undefined;

		try {
			const reply = extractAssistantText(event.messages);
			await postReply(req, reply);
		} catch (error) {
			console.error("Slack bridge failed to post reply:", error);
		}

		dispatchNext();
	});

	pi.on("session_shutdown", async () => {
		await disconnectSlack();
	});
}
