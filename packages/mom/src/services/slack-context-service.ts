import type { SlackBot, SlackEvent } from "../slack.js";
import type { ChannelStore } from "../store.js";

export interface SlackContextState {
	store: ChannelStore;
}

export function createSlackContext(event: SlackEvent, slack: SlackBot, state: SlackContextState, isEvent?: boolean) {
	let messageTs: string | null = null;
	let accumulatedText = "";
	let isWorking = true;
	const workingIndicator = " ...";
	let updatePromise = Promise.resolve();

	const user = slack.getUser(event.user);

	const sender = user?.userName || event.user;
	const targetThreadTs = !isEvent && event.threadTs ? event.threadTs : undefined;
	const quotePrefix =
		!isEvent && event.text.trim() ? `> *${sender}*\n> ${event.text.trim().replace(/\n/g, "\n> ")}\n\n` : "";

	const getDisplayText = (): string => {
		const body = `${quotePrefix}${accumulatedText}`.trimEnd();
		const withFallback = body || "_Thinking_";
		return isWorking ? withFallback + workingIndicator : withFallback;
	};

	const eventFilename = isEvent ? event.text.match(/^\[EVENT:([^:]+):/)?.[1] : undefined;

	return {
		message: {
			text: event.text,
			rawText: event.text,
			user: event.user,
			userName: sender,
			channel: event.channel,
			ts: event.ts,
			attachments: (event.attachments || []).map((a) => ({ local: a.local })),
		},
		channelName: slack.getChannel(event.channel)?.name,
		store: state.store,
		channels: slack.getAllChannels().map((c) => ({ id: c.id, name: c.name })),
		users: slack.getAllUsers().map((u) => ({ id: u.id, userName: u.userName, displayName: u.displayName })),

		respond: async (text: string, shouldLog = true) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = accumulatedText ? `${accumulatedText}\n${text}` : text;

				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, getDisplayText());
				} else if (targetThreadTs) {
					messageTs = await slack.postInThread(event.channel, targetThreadTs, getDisplayText());
				} else {
					messageTs = await slack.postMessage(event.channel, getDisplayText());
				}

				if (shouldLog && messageTs) {
					slack.logBotResponse(event.channel, text, messageTs);
				}
			});
			await updatePromise;
		},

		replaceMessage: async (text: string) => {
			updatePromise = updatePromise.then(async () => {
				accumulatedText = text;
				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, getDisplayText());
				} else if (targetThreadTs) {
					messageTs = await slack.postInThread(event.channel, targetThreadTs, getDisplayText());
				} else {
					messageTs = await slack.postMessage(event.channel, getDisplayText());
				}
			});
			await updatePromise;
		},

		respondInThread: async (text: string) => {
			if (!targetThreadTs) {
				return;
			}
			await slack.postInThread(event.channel, targetThreadTs, text);
		},

		setTyping: async (isTyping: boolean) => {
			if (isTyping && !messageTs) {
				updatePromise = updatePromise.then(async () => {
					if (!messageTs) {
						accumulatedText = eventFilename ? `_Starting event: ${eventFilename}_` : "";
						if (targetThreadTs) {
							messageTs = await slack.postInThread(event.channel, targetThreadTs, getDisplayText());
						} else {
							messageTs = await slack.postMessage(event.channel, getDisplayText());
						}
					}
				});
				await updatePromise;
			}
		},

		uploadFile: async (filePath: string, title?: string) => {
			await slack.uploadFile(event.channel, filePath, title);
		},

		setWorking: async (working: boolean) => {
			updatePromise = updatePromise.then(async () => {
				isWorking = working;
				if (messageTs) {
					await slack.updateMessage(event.channel, messageTs, getDisplayText());
				}
			});
			await updatePromise;
		},

		deleteMessage: async () => {
			updatePromise = updatePromise.then(async () => {
				if (messageTs) {
					await slack.deleteMessage(event.channel, messageTs);
					messageTs = null;
				}
			});
			await updatePromise;
		},
	};
}
