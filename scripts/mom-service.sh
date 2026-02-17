#!/usr/bin/env bash

set -euo pipefail

action="${1:-}"
shift || true

if [[ -z "${action}" ]]; then
	echo "Usage: bash scripts/mom-service.sh <start|supervisor-start|restart|stop|status>"
	exit 1
fi

if [[ -f "${MOM_ENV_FILE:-.env}" ]]; then
	set -a
	# shellcheck disable=SC1090
	source "${MOM_ENV_FILE:-.env}"
	set +a
fi

export MOM_SLACK_APP_TOKEN="${MOM_SLACK_APP_TOKEN:-${PI_SLACK_APP_TOKEN:-${SLACK_APP_TOKEN:-}}}"
export MOM_SLACK_BOT_TOKEN="${MOM_SLACK_BOT_TOKEN:-${PI_SLACK_BOT_TOKEN:-${SLACK_BOT_TOKEN:-}}}"

slack_bridge_config_path="${PI_SLACK_BRIDGE_CONFIG:-${HOME}/.pi/agent/extensions/slack-bridge.json}"
if [[ -f "${slack_bridge_config_path}" ]]; then
	if [[ -z "${MOM_SLACK_APP_TOKEN:-}" ]]; then
		file_app_token="$(
			node -e 'const fs=require("node:fs");const p=process.argv[1];try{const raw=JSON.parse(fs.readFileSync(p,"utf8"));if(typeof raw.appToken==="string"&&raw.appToken){process.stdout.write(raw.appToken);}}catch{}' \
				"${slack_bridge_config_path}"
		)"
		export MOM_SLACK_APP_TOKEN="${MOM_SLACK_APP_TOKEN:-${file_app_token:-}}"
	fi

	if [[ -z "${MOM_SLACK_BOT_TOKEN:-}" ]]; then
		file_bot_token="$(
			node -e 'const fs=require("node:fs");const p=process.argv[1];try{const raw=JSON.parse(fs.readFileSync(p,"utf8"));if(typeof raw.botToken==="string"&&raw.botToken){process.stdout.write(raw.botToken);}}catch{}' \
				"${slack_bridge_config_path}"
		)"
		export MOM_SLACK_BOT_TOKEN="${MOM_SLACK_BOT_TOKEN:-${file_bot_token:-}}"
	fi
fi

workdir="${MOM_WORKDIR:-./data}"

case "${action}" in
start)
	npm --workspace @mariozechner/pi-mom run run:slack-service -- "$@" "${workdir}"
	;;
supervisor-start)
	npm --workspace @mariozechner/pi-mom run run:slack-supervisor -- "$@" "${workdir}"
	;;
restart)
	npm --workspace @mariozechner/pi-mom run restart:slack-service -- "${workdir}" "$@"
	;;
stop)
	npm --workspace @mariozechner/pi-mom run stop:slack-service -- "${workdir}" "$@"
	;;
status)
	npm --workspace @mariozechner/pi-mom run status:slack-service -- "${workdir}" "$@"
	;;
*)
	echo "Unknown action: ${action}"
	echo "Usage: bash scripts/mom-service.sh <start|supervisor-start|restart|stop|status>"
	exit 1
	;;
esac
