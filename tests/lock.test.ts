import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { rm, utimes } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { acquireLock, LockHeldError } from "#core/lock.server";
import { present } from "./helpers/present.ts";

const dirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), "tcrs-lock-"));
	dirs.push(d);
	return d;
}
afterEach(async () => {
	while (dirs.length)
		await rm(present(dirs.pop()), { recursive: true, force: true });
});

describe("acquireLock", () => {
	it("grants an uncontended lock and releases it", async () => {
		const path = join(tmp(), ".lock");
		const lock = await acquireLock(path);
		expect(readFileSync(path, "utf8")).toContain(String(process.pid));
		await lock.release();
		// Released, so the next acquire succeeds.
		await (await acquireLock(path)).release();
	});

	it("refuses a second acquire from the same live process", async () => {
		const path = join(tmp(), ".lock");
		const held = await acquireLock(path);
		await expect(acquireLock(path)).rejects.toThrow(LockHeldError);
		await held.release();
	});

	it("is idempotent on release", async () => {
		const path = join(tmp(), ".lock");
		const lock = await acquireLock(path);
		await lock.release();
		await expect(lock.release()).resolves.toBeUndefined();
	});
});

describe("cross-namespace safety", () => {
	it("does NOT trust a pid recorded by a different host", async () => {
		// THE BUG THIS EXISTS TO PREVENT: two containers share one volume but have
		// separate PID namespaces, so the other container's pid means nothing here.
		// Our own pid is definitely alive, so a naive pid check would see "alive" and
		// could equally see "dead" for a real holder, it fails open.
		const path = join(tmp(), ".lock");
		writeFileSync(
			path,
			`other-container ${process.pid} ${new Date().toISOString()}\n`,
		);
		// Fresh mtime => the other host is heartbeating => must be treated as held.
		await expect(acquireLock(path)).rejects.toThrow(LockHeldError);
	});

	it("reclaims another host's lock once its heartbeat goes quiet", async () => {
		const path = join(tmp(), ".lock");
		writeFileSync(path, `other-container 7 ${new Date().toISOString()}\n`);
		// Backdate the mtime past the staleness window: that container is gone.
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(path, old, old);

		const lock = await acquireLock(path);
		expect(readFileSync(path, "utf8")).toContain(String(process.pid));
		await lock.release();
	});

	it("holds another host's lock while the heartbeat is recent", async () => {
		const path = join(tmp(), ".lock");
		writeFileSync(path, `other-container 7 ${new Date().toISOString()}\n`);
		const recent = new Date(Date.now() - 5_000);
		await utimes(path, recent, recent);
		await expect(acquireLock(path)).rejects.toThrow(LockHeldError);
	});

	it("reclaims a lock left by a dead process on the SAME host", async () => {
		// A SIGKILLed process must not wedge the next boot for a whole staleness window
		// when we can prove locally that its pid is gone.
		const path = join(tmp(), ".lock");
		writeFileSync(path, `${hostname()} 999999 ${new Date().toISOString()}\n`);
		const lock = await acquireLock(path);
		await lock.release();
	});

	it("tolerates a corrupt lock file", async () => {
		const path = join(tmp(), ".lock");
		writeFileSync(path, "garbage-without-fields");
		const old = new Date(Date.now() - 10 * 60_000);
		await utimes(path, old, old);
		await (await acquireLock(path)).release();
	});

	it("refreshes its own mtime while held", async () => {
		const path = join(tmp(), ".lock");
		const lock = await acquireLock(path, { heartbeatMs: 20 });
		const before = statSync(path).mtimeMs;
		await new Promise((r) => setTimeout(r, 80));
		const after = statSync(path).mtimeMs;
		expect(after).toBeGreaterThan(before);
		await lock.release();
	});
});
