/**
 * The API contract, shared by the server and the browser.
 *
 * Lives under app/ so the web bundle can `import type` it with no risk of pulling
 * server code in. Every type here is erased at build time.
 */

import type { RunEvent } from "#core/events";
import type { FileKind } from "#core/permutations";
import type { RunOutcome } from "#core/staging.server";
import type { RunState } from "#core/state";

export interface DatasetSummary {
	runId: string;
	/** When the run that produced this data started. */
	generatedAt: string;
	outcome: "success" | "partial";
	fileCount: number;
	totalBytes: number;
	durationMs: number | null;
	mafiaBuild: string | null;
	/** Permutations whose files were carried forward from an earlier run. */
	stalePermutations: string[];
	zip: { url: string; bytes: number } | null;
}

export interface CooldownInfo {
	/** The configured policy, for "one run per Xh". The window actually in force is
	 *  expressed by nextAllowedAt / remainingMs / canGenerate. */
	hours: number;
	nextAllowedAt: string | null;
	remainingMs: number;
	canGenerate: boolean;
	reason: "ok" | "cooldown" | "running" | "misconfigured" | "low-disk";
}

export interface RunSnapshot {
	runId: string;
	startedAt: string;
	state: RunState;
}

export interface AttemptSummary {
	id: string;
	startedAt: string;
	finishedAt: string | null;
	outcome: RunOutcome | null;
}

export interface StatusResponse {
	/** Server time, so the client can correct for a mis-set local clock. */
	now: string;
	configOk: boolean;
	/** A count only, never which passwords are missing. */
	missingPasswordCount: number;
	dataset: DatasetSummary | null;
	cooldown: CooldownInfo;
	/** Non-null exactly when a run is in flight. */
	run: RunSnapshot | null;
	lastAttempt: AttemptSummary | null;
	permutationCount: number;
	/** True in a dev build. Gates the cooldown-reset control, whose route does not
	 *  exist in production. */
	dev: boolean;
}

export type GenerateResponse =
	| { accepted: true; runId: string; startedAt: string }
	| { accepted: false; error: "already_running"; runId: string }
	| {
			accepted: false;
			error: "cooldown";
			nextAllowedAt: string | null;
			remainingMs: number;
	  }
	| { accepted: false; error: "misconfigured"; detail: string }
	| { accepted: false; error: "insufficient_disk"; freeBytes: number | null };

export interface FileRef {
	kind: FileKind;
	name: string;
	bytes: number;
	url: string;
}

export interface PermutationFiles {
	user: string;
	classToken: string;
	classLabel: string;
	sign: string;
	/** false => carried forward from an earlier run. */
	fresh: boolean;
	sourceRunId: string;
	files: FileRef[];
}

export interface ClassGroup {
	classToken: string;
	classLabel: string;
	permutations: PermutationFiles[];
}

export interface FileListResponse {
	runId: string;
	generatedAt: string;
	groups: ClassGroup[];
	sums: { name: string; url: string } | null;
}

/**
 * Server-sent events.
 *
 * Every connection begins with a `snapshot`, including reconnects. That single
 * decision is what makes a late joiner correct, which matters because someone else
 * may have started the run. It also lets the server keep no replay buffer and
 * ignore Last-Event-ID entirely.
 */
export type ServerEvent =
	| {
			type: "snapshot";
			seq: number;
			status: StatusResponse;
			state: RunState | null;
	  }
	| { type: "patch"; seq: number; runId: string; event: RunEvent }
	| { type: "run-started"; seq: number; status: StatusResponse }
	| {
			type: "run-finished";
			seq: number;
			runId: string;
			outcome: RunOutcome;
			status: StatusResponse;
	  };
