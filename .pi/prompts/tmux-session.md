---
description: Manage tmux sessions for workflow windows
---
Manage tmux sessions used by this project workflow.

Arguments: `$ARGUMENTS`

## Usage

- `/tmux-session list`
- `/tmux-session kill <session-name>`

## Execute

1. Parse action from arguments (`list` or `kill`).
2. Run from repository root (`/pi-mono`):

```bash
npm run workflow:sessions
```

or

```bash
npm run workflow:session:kill -- <session-name>
```

3. Return concise output:
   - For `list`: show sessions.
   - For `kill`: confirm session killed, or report not found.
