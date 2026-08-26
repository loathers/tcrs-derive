import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
	loadSecrets,
	MissingPasswordError,
	minimalEnv,
	parseDotenv,
} from "#core/env.server";
import { ALL_PERMUTATIONS, permutationByUser } from "#core/permutations";
import { present } from "./helpers/present.ts";

const TT = present(permutationByUser("tt_wallaby"));

function tmpEnvFile(contents: string): string {
	const dir = mkdtempSync(join(tmpdir(), "tcrs-env-"));
	const path = join(dir, ".env");
	writeFileSync(path, contents);
	return path;
}

describe("parseDotenv", () => {
	it("reads simple assignments", () => {
		expect(parseDotenv("A=1\nB=two")).toEqual(
			new Map([
				["A", "1"],
				["B", "two"],
			]),
		);
	});

	it("skips comments and blank lines", () => {
		expect(parseDotenv("# a comment\n\n  \nA=1\n")).toEqual(
			new Map([["A", "1"]]),
		);
	});

	it("keeps '=' inside a value", () => {
		// Passwords can contain anything.
		expect(parseDotenv("A=a=b=c").get("A")).toBe("a=b=c");
	});

	it("handles CRLF line endings", () => {
		expect(parseDotenv("A=1\r\nB=2\r\n")).toEqual(
			new Map([
				["A", "1"],
				["B", "2"],
			]),
		);
	});

	it("strips one layer of matching quotes, preserving a hash inside", () => {
		expect(parseDotenv('A="a#b"').get("A")).toBe("a#b");
		expect(parseDotenv("A='a b'").get("A")).toBe("a b");
		expect(parseDotenv('A="unclosed').get("A")).toBe('"unclosed');
	});

	it("does not interpolate", () => {
		expect(parseDotenv("A=1\nB=$A").get("B")).toBe("$A");
	});

	it("ignores malformed keys and bare lines", () => {
		expect(parseDotenv("=novalue\nnoequals\n1BAD=x\nOK=y")).toEqual(
			new Map([["OK", "y"]]),
		);
	});

	it("never touches process.env", () => {
		parseDotenv("TCRS_PARSE_CANARY=leaked");
		expect(process.env.TCRS_PARSE_CANARY).toBeUndefined();
	});
});

describe("loadSecrets", () => {
	it("reads passwords from a .env file", () => {
		const path = tmpEnvFile("PASSWORD_TT_WALLABY=hunter2\n");
		const store = loadSecrets({ envPath: path, processEnv: {} });
		expect(store.passwordFor(TT)).toBe("hunter2");
	});

	it("lets the environment override a stale .env", () => {
		const path = tmpEnvFile("PASSWORD_TT_WALLABY=old\n");
		const store = loadSecrets({
			envPath: path,
			processEnv: { PASSWORD_TT_WALLABY: "new" },
		});
		expect(store.passwordFor(TT)).toBe("new");
	});

	it("treats a missing .env as normal", () => {
		const store = loadSecrets({
			envPath: "/nonexistent/.env",
			processEnv: { PASSWORD_TT_WALLABY: "x" },
		});
		expect(store.passwordFor(TT)).toBe("x");
	});

	it("ignores empty values, so a blank .env line is still 'missing'", () => {
		const path = tmpEnvFile("PASSWORD_TT_WALLABY=\n");
		const store = loadSecrets({ envPath: path, processEnv: {} });
		expect(store.missingFor([TT])).toEqual(["PASSWORD_TT_WALLABY"]);
	});

	it("throws a named error for a missing password", () => {
		const store = loadSecrets({ envPath: "/nonexistent", processEnv: {} });
		expect(() => store.passwordFor(TT)).toThrow(MissingPasswordError);
	});

	it("preflights the whole selection at once", () => {
		// Discovering this inside the worker instead means one typo fails one
		// permutation 40 minutes into a batch.
		const store = loadSecrets({
			envPath: "/nonexistent",
			processEnv: { PASSWORD_TT_WALLABY: "x" },
		});
		const missing = store.missingFor(ALL_PERMUTATIONS);
		expect(missing).toHaveLength(53);
		expect(missing).not.toContain("PASSWORD_TT_WALLABY");
	});

	it("scrubs PASSWORD_* from the environment it was given", () => {
		// Under Coolify the passwords arrive as container env vars, so this is the
		// step that stops a crash dump leaking all 54.
		const env: Record<string, string | undefined> = {
			PASSWORD_TT_WALLABY: "hunter2",
			PASSWORD_SC_VOLE: "hunter2",
			PATH: "/usr/bin",
		};
		const store = loadSecrets({ processEnv: env, scrubProcessEnv: true });
		expect(env.PASSWORD_TT_WALLABY).toBeUndefined();
		expect(env.PASSWORD_SC_VOLE).toBeUndefined();
		expect(env.PATH).toBe("/usr/bin");
		// The store still works: the only copy now lives in its closure.
		expect(store.passwordFor(TT)).toBe("hunter2");
	});

	it("does not scrub when told not to", () => {
		const env: Record<string, string | undefined> = {
			PASSWORD_TT_WALLABY: "x",
		};
		loadSecrets({ processEnv: env, scrubProcessEnv: false });
		expect(env.PASSWORD_TT_WALLABY).toBe("x");
	});
});

describe("minimalEnv", () => {
	it("passes only the allow-listed variables", () => {
		const out = minimalEnv({
			PATH: "/usr/bin",
			HOME: "/home/tcrs",
			JAVA_HOME: "/opt/java/openjdk",
			TZ: "UTC",
			PASSWORD_TT_WALLABY: "hunter2",
			AWS_SECRET_ACCESS_KEY: "nope",
			SOME_OTHER: "nope",
		});
		expect(out).toEqual({
			PATH: "/usr/bin",
			HOME: "/home/tcrs",
			JAVA_HOME: "/opt/java/openjdk",
			TZ: "UTC",
		});
	});

	it("never forwards a password, which is the whole point", () => {
		// A forwarded environment would put all 54 in /proc/<jvm-pid>/environ.
		const out = minimalEnv({ PASSWORD_TT_WALLABY: "hunter2", PATH: "/bin" });
		expect(Object.keys(out).some((k) => k.startsWith("PASSWORD_"))).toBe(false);
	});

	it("omits absent variables rather than setting them undefined", () => {
		expect(minimalEnv({ PATH: "/bin" })).toEqual({ PATH: "/bin" });
	});
});
