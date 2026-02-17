# Services

This directory contains the Slack message pipeline split into focused services so each part can be changed, built, and validated independently.

## Modules

- `slack-event-routing-service.ts`
  - Pure routing rules for inbound Slack events.
  - Current policy: process all channel messages and DMs.
- `slack-context-service.ts`
  - Builds the runtime Slack context used by the runner.
  - Handles quote prefix generation and main-message update/send behavior.
- `mom-run-service.ts`
  - Orchestrates per-channel execution lifecycle (`run`, `stop`, state, filtering).
  - Implements `MomHandler` and is injected into `SlackBot` by `slack-service.ts`.
- `slack-service.ts`
  - Composes `SlackBot`, `MomRunService`, and event watcher into a standalone runtime unit.

## Why This Split

- Keeps Slack transport (`src/slack.ts`) separate from runtime behavior.
- Enables targeted tests for routing, context rendering, and run orchestration.
- Allows iterative changes without touching the active chat loop wiring.

## Service-Level Tests

From `packages/mom`:

```bash
npm run test:services
```

Or run one service test at a time:

```bash
npm run test:services:routing
npm run test:services:context
npm run test:services:run
```

Tests live under `test/services/` and are designed to be fast and isolated.

## Standalone Service Runner

Use the standalone Slack service process for isolated iteration:

```bash
npm run run:slack-service -- --sandbox=docker:mom-sandbox ./data
```

Use supervisor mode with manual restarts:

```bash
npm run run:slack-supervisor -- --sandbox=docker:mom-sandbox ./data
```

Control the running supervisor explicitly:

```bash
npm run restart:slack-service -- ./data
npm run stop:slack-service -- ./data
npm run status:slack-service -- ./data
```

This uses `src/service-supervisor.ts` + `src/service-control.ts` and never auto-restarts on file changes.
