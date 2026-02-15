# Slack Bridge Extension

Connects pi to Slack via Socket Mode so you can chat with pi from Slack.

## What it does

- Accepts direct messages to the bot
- Accepts all non-bot channel messages in channels where the bot is present
- Shows inbound Slack messages in the current pi conversation panel
- Sends the cleaned message text into pi as a user message
- Posts pi's final assistant response back to the same Slack thread

## Setup

1. Create a Slack app and enable Socket Mode.
2. Grant bot scopes: `app_mentions:read`, `channels:history`, `chat:write`, `im:history`, `im:read`.
3. Install the app to your workspace.
4. Configure tokens (pick one):

- Environment variables:

```bash
export PI_SLACK_APP_TOKEN="xapp-..."
export PI_SLACK_BOT_TOKEN="xoxb-..."
```

- Or inside pi via extension command:

```text
/slack-token set
/slack-service start
```

This stores tokens in `~/.pi/agent/extensions/slack-bridge.json` with `0600` permissions.

## Run

```bash
cd packages/coding-agent/examples/extensions/slack-bridge
npm install
pi -e ./index.ts
```

## Notes

- Replies are posted in thread (`thread_ts`).
- If the assistant output is very long, it is truncated before posting to Slack.
- This extension processes Slack messages sequentially (single conversation queue).
- Token command helpers: `/slack-token status`, `/slack-token clear`.
- Service command helpers: `/slack-service status`, `/slack-service stop`, `/slack-service restart`.
