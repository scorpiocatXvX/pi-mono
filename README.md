# 🏖️ OSS Vacation

**Issue tracker and PRs reopen February 16, 2026.**

All PRs will be auto-closed until then. Approved contributors can submit PRs after vacation without reapproval. For support, join [Discord](https://discord.com/invite/3cU7Bz4UPx).

---

<p align="center">
  <a href="https://shittycodingagent.ai">
    <img src="https://shittycodingagent.ai/logo.svg" alt="pi logo" width="128">
  </a>
</p>
<p align="center">
  <a href="https://discord.com/invite/3cU7Bz4UPx"><img alt="Discord" src="https://img.shields.io/badge/discord-community-5865F2?style=flat-square&logo=discord&logoColor=white" /></a>
  <a href="https://github.com/badlogic/pi-mono/actions/workflows/ci.yml"><img alt="Build status" src="https://img.shields.io/github/actions/workflow/status/badlogic/pi-mono/ci.yml?style=flat-square&branch=main" /></a>
</p>
<p align="center">
  <a href="https://pi.dev">pi.dev</a> domain graciously donated by
  <br /><br />
  <a href="https://exe.dev"><img src="packages/coding-agent/docs/images/exy.png" alt="Exy mascot" width="48" /><br />exe.dev</a>
</p>

# Pi Monorepo

> **Looking for the pi coding agent?** See **[packages/coding-agent](packages/coding-agent)** for installation and usage.

Tools for building AI agents and managing LLM deployments.

## Packages

| Package | Description |
|---------|-------------|
| **[@mariozechner/pi-ai](packages/ai)** | Unified multi-provider LLM API (OpenAI, Anthropic, Google, etc.) |
| **[@mariozechner/pi-agent-core](packages/agent)** | Agent runtime with tool calling and state management |
| **[@mariozechner/pi-coding-agent](packages/coding-agent)** | Interactive coding agent CLI |
| **[@mariozechner/pi-mom](packages/mom)** | Slack bot that delegates messages to the pi coding agent |
| **[@mariozechner/pi-tui](packages/tui)** | Terminal UI library with differential rendering |
| **[@mariozechner/pi-web-ui](packages/web-ui)** | Web components for AI chat interfaces |
| **[@mariozechner/pi-pods](packages/pods)** | CLI for managing vLLM deployments on GPU pods |

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for contribution guidelines and [AGENTS.md](AGENTS.md) for project-specific rules (for both humans and agents).

## Development

```bash
npm install          # Install all dependencies
npm run build        # Build all packages
npm run check        # Lint, format, and type check
./test.sh            # Run tests (skips LLM-dependent tests without API keys)
./pi-test.sh         # Run pi from sources (must be run from repo root)
./pi-test.sh --dist  # Run compiled pi (requires npm run build first)
```

> **Note:** `npm run check` requires `npm run build` to be run first. The web-ui package uses `tsc` which needs compiled `.d.ts` files from dependencies.

## Non-Blocking Workflow

Use the workflow helper to isolate long-running tasks in tmux sessions:

```bash
pnpm workflow:dev              # Window 1: pnpm dev (watch build), Window 2: ./pi-test.sh --dist
pnpm workflow:build            # Detached one-off pnpm build
pnpm workflow:release:patch    # Detached release in isolated git worktree
pnpm workflow:release:minor    # Detached release in isolated git worktree
pnpm workflow:run              # Detached run for compiled pi (--dist)
pnpm workflow:run:restart      # Restart compiled pi in background
pnpm workflow:run:stop         # Stop background compiled pi
pnpm workflow:run:status       # Check whether compiled pi is running
pnpm workflow:run:logs         # Show current tmux pane output
pnpm workflow:run:attach       # Attach to compiled pi session
pnpm workflow:sessions         # List tmux sessions
```

`workflow:release:*` runs in a separate worktree under `/tmp/pi-release-worktrees`, so development in `/pi-mono` can continue without interruption.

## Local pi Commands

This repository includes a local extension with two project-scoped commands:

```text
/gh-pr-service start|stop|restart|status
/gh-pr create <head> [base] [title...]
/gh-pr update <number> <head> [base]
/gh-pr ship [base] [commit-message...]
```

- `/gh-pr-service` manages a detached standalone process that handles GitHub PR operations.
- `/gh-pr create` creates a PR from `<head>` into `[base]` (default `main`) and writes an auto-generated change summary.
- If `/gh-pr create` omits `[title]`, the service auto-generates a PR title from commit subjects between `origin/[base]..origin/[head]`.
- `/gh-pr update` refreshes an existing PR description with the current change summary for `<head>` vs `[base]`.
- `/gh-pr ship` is the one-click flow: detect local changes, stage+commit (auto message if omitted), push current branch, then create or update the PR.
- The service reads `GITHUB_TOKEN` (or `GH_TOKEN`) from environment first, then falls back to the project-local `.env`.
- Service state is stored in `.pi/gh-pr-service/` (pid, log, request/response queue).

## License

MIT
