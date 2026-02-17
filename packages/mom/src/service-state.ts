import { existsSync, readFileSync, unlinkSync } from "fs";
import { join } from "path";

interface MomServiceState {
	pid: number;
}

export interface RunningMomService {
	source: "mom-service" | "mom-service-supervisor";
	pid: number;
}

function isProcessAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return !isZombieProcess(pid);
	} catch {
		return false;
	}
}

function isZombieProcess(pid: number): boolean {
	const statPath = `/proc/${pid}/stat`;
	if (!existsSync(statPath)) {
		return false;
	}

	try {
		const stat = readFileSync(statPath, "utf8");
		const markerIndex = stat.lastIndexOf(") ");
		if (markerIndex === -1 || markerIndex + 2 >= stat.length) {
			return false;
		}
		const state = stat.charAt(markerIndex + 2);
		return state === "Z";
	} catch {
		return false;
	}
}

function removeFileIfExists(path: string): void {
	if (!existsSync(path)) {
		return;
	}
	try {
		unlinkSync(path);
	} catch {
		// Ignore cleanup failures, detection is still best effort.
	}
}

function readPidFromStateFile(workingDir: string): number | undefined {
	const stateFile = join(workingDir, ".mom-service.state.json");
	if (!existsSync(stateFile)) return undefined;

	try {
		const raw = JSON.parse(readFileSync(stateFile, "utf8")) as Partial<MomServiceState>;
		if (typeof raw.pid !== "number" || !Number.isFinite(raw.pid) || raw.pid <= 0) {
			return undefined;
		}
		return raw.pid;
	} catch {
		return undefined;
	}
}

function readPidFromSupervisorFile(workingDir: string): number | undefined {
	const supervisorPidFile = join(workingDir, ".mom-service-supervisor.pid");
	if (!existsSync(supervisorPidFile)) return undefined;

	const raw = readFileSync(supervisorPidFile, "utf8").trim();
	const pid = Number(raw);
	if (!Number.isFinite(pid) || pid <= 0) {
		return undefined;
	}
	return pid;
}

export function detectRunningMomService(workingDir: string): RunningMomService | undefined {
	const stateFile = join(workingDir, ".mom-service.state.json");
	const servicePid = readPidFromStateFile(workingDir);
	if (servicePid && isProcessAlive(servicePid)) {
		return { source: "mom-service", pid: servicePid };
	}
	if (servicePid) {
		removeFileIfExists(stateFile);
	}

	const supervisorPidFile = join(workingDir, ".mom-service-supervisor.pid");
	const supervisorPid = readPidFromSupervisorFile(workingDir);
	if (supervisorPid && isProcessAlive(supervisorPid)) {
		return { source: "mom-service-supervisor", pid: supervisorPid };
	}
	if (supervisorPid) {
		removeFileIfExists(supervisorPidFile);
	}

	return undefined;
}
