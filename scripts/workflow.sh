#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT_DIR="$(cd "$SCRIPT_DIR/.." && pwd)"

usage() {
	echo "Usage:"
	echo "  bash scripts/workflow.sh dev"
	echo "  bash scripts/workflow.sh build"
	echo "  bash scripts/workflow.sh release <patch|minor>"
	echo "  bash scripts/workflow.sh run <start|restart|stop|status|logs|attach>"
	echo "  bash scripts/workflow.sh kill <session>"
	echo "  bash scripts/workflow.sh list"
}

require_cmd() {
	local cmd="$1"
	if ! command -v "$cmd" >/dev/null 2>&1; then
		echo "Missing required command: $cmd" >&2
		exit 1
	fi
}

start_dev_session() {
	require_cmd tmux

	local session="${PI_DEV_SESSION:-pi-dev}"
	if tmux has-session -t "$session" 2>/dev/null; then
		echo "Session '$session' already exists."
	else
		tmux new-session -d -s "$session" -n "dev" -c "$ROOT_DIR"
		tmux send-keys -t "$session:dev" "pnpm dev" Enter
		tmux new-window -t "$session" -n "pi" -c "$ROOT_DIR"
		tmux send-keys -t "$session:pi" "./pi-test.sh --dist" Enter
	fi

	echo "Dev workflow is running in tmux session '$session'."
	echo "Attach with: tmux attach -t $session"
	tmux attach -t "$session"
}

start_build_session() {
	require_cmd tmux

	local timestamp session command
	timestamp="$(date +%Y%m%d-%H%M%S)"
	session="${PI_BUILD_SESSION:-pi-build-$timestamp}"
	command='set +e; pnpm build; code=$?; echo; echo "[build] exit code: $code"; exit "$code"'

	tmux new-session -d -s "$session" -c "$ROOT_DIR" "bash -lc '$command'"

	echo "Build started in detached tmux session '$session' (auto-exits when build finishes)."
	echo "Attach with: tmux attach -t $session"
}

start_release_session() {
	require_cmd tmux
	require_cmd git

	local bump="$1"
	if [[ "$bump" != "patch" && "$bump" != "minor" ]]; then
		echo "Release bump must be 'patch' or 'minor'." >&2
		exit 1
	fi

	local timestamp branch worktree_root worktree_dir session command
	timestamp="$(date +%Y%m%d-%H%M%S)"
	branch="${PI_RELEASE_BRANCH:-main}"
	worktree_root="${PI_RELEASE_WORKTREE_ROOT:-/tmp/pi-release-worktrees}"
	worktree_dir="$worktree_root/$timestamp-$bump"
	session="pi-release-$bump-$timestamp"

	mkdir -p "$worktree_root"

	if [[ "${PI_RELEASE_SKIP_FETCH:-0}" != "1" ]]; then
		git -C "$ROOT_DIR" fetch origin "$branch"
	fi

	git -C "$ROOT_DIR" worktree add "$worktree_dir" "origin/$branch"

	command="set -euo pipefail; pnpm install --frozen-lockfile; pnpm run release:$bump"
	tmux new-session -d -s "$session" -c "$worktree_dir" "bash -lc '$command'"

	echo "Release ($bump) started in detached tmux session '$session'."
	echo "Worktree: $worktree_dir"
	echo "Attach with: tmux attach -t $session"
	echo "Cleanup after completion:"
	echo "  git -C $ROOT_DIR worktree remove $worktree_dir"
}

manage_run_session() {
	require_cmd tmux

	local action="${1:-start}"
	local session="${PI_RUN_SESSION:-pi-run}"
	local command='set +e; ./pi-test.sh --dist; code=$?; echo; echo "[pi-run] exit code: $code"; exec bash'

	case "$action" in
	start)
		if tmux has-session -t "$session" 2>/dev/null; then
			echo "Session '$session' is already running."
			echo "Attach with: tmux attach -t $session"
			return
		fi
		tmux new-session -d -s "$session" -n "pi" -c "$ROOT_DIR" "bash -lc '$command'"
		echo "Compiled pi started in detached tmux session '$session'."
		echo "Attach with: tmux attach -t $session"
		;;
	restart)
		if tmux has-session -t "$session" 2>/dev/null; then
			tmux kill-session -t "$session"
		fi
		tmux new-session -d -s "$session" -n "pi" -c "$ROOT_DIR" "bash -lc '$command'"
		echo "Compiled pi restarted in detached tmux session '$session'."
		echo "Attach with: tmux attach -t $session"
		;;
	stop)
		if tmux has-session -t "$session" 2>/dev/null; then
			tmux kill-session -t "$session"
			echo "Stopped tmux session '$session'."
		else
			echo "Session '$session' is not running."
		fi
		;;
	status)
		if tmux has-session -t "$session" 2>/dev/null; then
			echo "Session '$session' is running."
		else
			echo "Session '$session' is not running."
		fi
		;;
	logs)
		if tmux has-session -t "$session" 2>/dev/null; then
			tmux capture-pane -p -t "$session:pi"
		else
			echo "Session '$session' is not running."
			exit 1
		fi
		;;
	attach)
		if tmux has-session -t "$session" 2>/dev/null; then
			tmux attach -t "$session"
		else
			echo "Session '$session' is not running."
			exit 1
		fi
		;;
	*)
		echo "Unknown run action: $action" >&2
		usage
		exit 1
		;;
	esac
}

list_sessions() {
	require_cmd tmux
	if ! tmux list-sessions 2>/dev/null; then
		echo "No tmux sessions are currently running."
	fi
}

kill_session() {
	require_cmd tmux

	local session="${1:-}"
	if [[ -z "$session" ]]; then
		echo "Missing session name. Usage: bash scripts/workflow.sh kill <session>" >&2
		exit 1
	fi

	if tmux has-session -t "$session" 2>/dev/null; then
		tmux kill-session -t "$session"
		echo "Killed tmux session '$session'."
	else
		echo "Session '$session' does not exist."
	fi
}

main() {
	local action="${1:-}"
	case "$action" in
	dev)
		start_dev_session
		;;
	build)
		start_build_session
		;;
	release)
		if [[ $# -lt 2 ]]; then
			usage
			exit 1
		fi
		start_release_session "$2"
		;;
	run)
		manage_run_session "${2:-start}"
		;;
	kill)
		kill_session "${2:-}"
		;;
	list)
		list_sessions
		;;
	*)
		usage
		exit 1
		;;
	esac
}

main "$@"
