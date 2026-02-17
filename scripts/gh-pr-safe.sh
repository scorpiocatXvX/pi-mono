#!/usr/bin/env bash

set -euo pipefail

action="${1:-}"
if [[ -z "$action" ]]; then
	echo "Usage: bash scripts/gh-pr-safe.sh <status|start|stop|ship> [args...]"
	exit 1
fi
shift || true

repo_root="$(git rev-parse --show-toplevel 2>/dev/null || true)"
if [[ -z "$repo_root" ]]; then
	echo "Error: not inside a git repository" >&2
	exit 1
fi

daemon_script="$repo_root/.pi/extensions/gh-pr-service-daemon.mjs"
state_dir="$repo_root/.pi/gh-pr-service"
pid_file="$state_dir/service.pid"
log_file="$state_dir/service.log"
requests_dir="$state_dir/requests"
responses_dir="$state_dir/responses"
request_timeout_ms="${GH_PR_REQUEST_TIMEOUT_MS:-90000}"

ensure_state_dirs() {
	mkdir -p "$requests_dir" "$responses_dir"
}

read_pid() {
	if [[ ! -f "$pid_file" ]]; then
		return 1
	fi
	local raw
	raw="$(tr -d '[:space:]' < "$pid_file" || true)"
	if [[ -z "$raw" || ! "$raw" =~ ^[0-9]+$ ]]; then
		return 1
	fi
	printf "%s" "$raw"
}

running_pid() {
	local pid
	pid="$(read_pid || true)"
	if [[ -z "$pid" ]]; then
		return 1
	fi
	if kill -0 "$pid" 2>/dev/null; then
		printf "%s" "$pid"
		return 0
	fi
	rm -f "$pid_file"
	return 1
}

start_daemon() {
	if [[ ! -f "$daemon_script" ]]; then
		echo "Error: missing daemon script at $daemon_script" >&2
		exit 1
	fi

	local pid
	pid="$(running_pid || true)"
	if [[ -n "$pid" ]]; then
		echo "gh-pr-service already running (pid $pid)"
		return
	fi

	ensure_state_dirs

	node "$daemon_script" --cwd "$repo_root" >>"$log_file" 2>&1 &
	local child_pid=$!
	disown "$child_pid" 2>/dev/null || true

	for _ in $(seq 1 50); do
		pid="$(running_pid || true)"
		if [[ -n "$pid" ]]; then
			echo "gh-pr-service started (pid $pid)"
			return
		fi
		if ! kill -0 "$child_pid" 2>/dev/null; then
			break
		fi
		sleep 0.1
	done

	echo "Error: failed to start gh-pr-service (check $log_file)" >&2
	exit 1
}

stop_daemon() {
	local pid
	pid="$(running_pid || true)"
	if [[ -z "$pid" ]]; then
		echo "gh-pr-service is not running"
		return
	fi

	kill -TERM "$pid" 2>/dev/null || true
	for _ in $(seq 1 50); do
		if ! kill -0 "$pid" 2>/dev/null; then
			rm -f "$pid_file"
			echo "gh-pr-service stopped"
			return
		fi
		sleep 0.1
	done

	kill -KILL "$pid" 2>/dev/null || true
	rm -f "$pid_file"
	echo "gh-pr-service stopped (forced)"
}

status_daemon() {
	local pid
	pid="$(running_pid || true)"
	if [[ -z "$pid" ]]; then
		echo "gh-pr-service is not running"
		return
	fi
	echo "gh-pr-service running (pid $pid, log=$log_file)"
}

json_payload() {
	local mode="$1"
	shift || true
	node -e 'const mode=process.argv[1];const args=process.argv.slice(2);if(mode==="create"){const [head,base]=args;process.stdout.write(JSON.stringify({head,base}));return;}if(mode==="update"){const [num,head,base]=args;process.stdout.write(JSON.stringify({number:Number(num),head,base}));return;}process.exit(1);' "$mode" "$@"
}

send_request() {
	local req_action="$1"
	local payload_json="$2"
	node -e 'const fs=require("node:fs");const {join}=require("node:path");const {randomUUID}=require("node:crypto");
const [requestsDir,responsesDir,action,payloadJson,timeoutRaw]=process.argv.slice(1);
const timeoutMs=Number(timeoutRaw)||90000;
const payload=JSON.parse(payloadJson);
const id=randomUUID();
const requestFile=join(requestsDir,`${id}.json`);
const responseFile=join(responsesDir,`${id}.json`);
fs.writeFileSync(requestFile,`${JSON.stringify({id,action,payload})}\n`,"utf8");
const deadline=Date.now()+timeoutMs;
function sleep(ms){return new Promise((resolve)=>setTimeout(resolve,ms));}
(async()=>{
while(Date.now()<deadline){
if(fs.existsSync(responseFile)){
const response=JSON.parse(fs.readFileSync(responseFile,"utf8"));
fs.rmSync(responseFile,{force:true});
if(!response.ok){console.error(response.error||"Service request failed");process.exit(1);}
process.stdout.write(JSON.stringify(response.data||{}));
return;
}
await sleep(150);
}
console.error(`Timed out after ${timeoutMs}ms waiting for service response`);
process.exit(1);
})();' "$requests_dir" "$responses_dir" "$req_action" "$payload_json" "$request_timeout_ms"
}

ship_changes() {
	local base="${1:-main}"
	shift || true
	local manual_commit_message="${*:-}"

	start_daemon

	local head
	head="$(git -C "$repo_root" rev-parse --abbrev-ref HEAD)"
	if [[ -z "$head" || "$head" == "HEAD" ]]; then
		echo "Error: unable to determine current branch (detached HEAD)" >&2
		exit 1
	fi

	mapfile -t changed_paths < <(
		{
			git -C "$repo_root" diff --name-only
			git -C "$repo_root" diff --cached --name-only
			git -C "$repo_root" ls-files --others --exclude-standard
		} | awk 'NF && !seen[$0]++'
	)

	if (( ${#changed_paths[@]} > 0 )); then
		git -C "$repo_root" add -- "${changed_paths[@]}"

		local commit_message="$manual_commit_message"
		if [[ -z "$commit_message" ]]; then
			if (( ${#changed_paths[@]} == 1 )); then
				commit_message="chore: update $(basename "${changed_paths[0]}")"
			else
				commit_message="chore: update ${#changed_paths[@]} files"
			fi
		fi

		local commit_output
		if ! commit_output="$(git -C "$repo_root" commit -m "$commit_message" 2>&1)"; then
			local lowered
			lowered="$(printf "%s" "$commit_output" | tr '[:upper:]' '[:lower:]')"
			if [[ "$lowered" != *"nothing to commit"* && "$lowered" != *"no changes added to commit"* ]]; then
				printf "%s\n" "$commit_output" >&2
				exit 1
			fi
			echo "No staged changes to commit; continuing with push/PR"
		else
			printf "%s\n" "$commit_output"
		fi
	else
		echo "No local file changes detected; continuing with push/PR"
	fi

	git -C "$repo_root" push -u origin "$head"

	local create_payload
	create_payload="$(json_payload create "$head" "$base")"
	local create_data
	create_data="$(send_request create_pr "$create_payload")"

	local existed
	existed="$(node -e 'const data=JSON.parse(process.argv[1]);process.stdout.write(data.existed ? "1" : "0");' "$create_data")"
	if [[ "$existed" == "0" ]]; then
		node -e 'const data=JSON.parse(process.argv[1]);console.log(`PR created: #${data.number} ${data.url}`);' "$create_data"
		return
	fi

	local number
	number="$(node -e 'const data=JSON.parse(process.argv[1]);process.stdout.write(String(data.number));' "$create_data")"
	local update_payload
	update_payload="$(json_payload update "$number" "$head" "$base")"
	local update_data
	update_data="$(send_request update_pr "$update_payload")"
	node -e 'const data=JSON.parse(process.argv[1]);console.log(`PR updated: #${data.number} ${data.url}`);' "$update_data"
}

case "$action" in
status)
	status_daemon
	;;
start)
	start_daemon
	;;
stop)
	stop_daemon
	;;
ship)
	ship_changes "$@"
	;;
*)
	echo "Unknown action: $action" >&2
	echo "Usage: bash scripts/gh-pr-safe.sh <status|start|stop|ship> [args...]"
	exit 1
	;;
esac
