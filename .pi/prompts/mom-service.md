---
description: Control mom Slack supervisor (status/restart/stop)
---
Manage the mom Slack supervisor.

Arguments: `$ARGUMENTS`

## Usage

- `/mom-service status <working-dir>`
- `/mom-service restart <working-dir>`
- `/mom-service stop <working-dir>`

If no working directory is provided, default to `./data`.

## Execute

1. Validate action is one of `status`, `restart`, `stop`.
2. Run from `packages/mom`:

```bash
npm run <action-script> -- <working-dir>
```

Script mapping:
- `status` -> `status:slack-service`
- `restart` -> `restart:slack-service`
- `stop` -> `stop:slack-service`

3. Return a concise result and next step suggestion only on failure.
