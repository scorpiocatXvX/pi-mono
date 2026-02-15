import { createEventsWatcher, type EventsWatcher } from "../events.js";
import * as log from "../log.js";
import type { SandboxConfig } from "../sandbox.js";
import { SlackBot, type SlackBot as SlackBotType } from "../slack.js";
import { ChannelStore } from "../store.js";
import { MomRunService } from "./mom-run-service.js";

export interface SlackServiceConfig {
	workingDir: string;
	sandbox: SandboxConfig;
	appToken: string;
	botToken: string;
}

export class SlackService {
	private readonly config: SlackServiceConfig;
	private readonly runService: MomRunService;
	private readonly sharedStore: ChannelStore;
	private readonly bot: SlackBotType;
	private readonly eventsWatcher: EventsWatcher;

	constructor(config: SlackServiceConfig) {
		this.config = config;
		this.runService = new MomRunService({
			workingDir: config.workingDir,
			sandbox: config.sandbox,
			botToken: config.botToken,
		});
		this.sharedStore = new ChannelStore({ workingDir: config.workingDir, botToken: config.botToken });
		this.bot = new SlackBot(this.runService, {
			appToken: config.appToken,
			botToken: config.botToken,
			workingDir: config.workingDir,
			store: this.sharedStore,
		});
		this.eventsWatcher = createEventsWatcher(config.workingDir, this.bot);
	}

	async start(): Promise<void> {
		log.logStartup(
			this.config.workingDir,
			this.config.sandbox.type === "host" ? "host" : `docker:${this.config.sandbox.container}`,
		);
		this.eventsWatcher.start();
		await this.bot.start();
	}

	async stop(timeoutMs = 5000): Promise<void> {
		log.logInfo("Shutting down...");
		this.eventsWatcher.stop();
		await this.runService.waitForIdle(timeoutMs);
		await this.bot.stop();
	}
}
