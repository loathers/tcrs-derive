/**
 * Secret handling. NODE-ONLY.
 *
 * The obvious way to load 54 passwords is to export them into the environment, and
 * it leaks: the environment is inherited all the way down to each JVM, so
 * `/proc/<jvm-pid>/environ` exposes ALL 54 PASSWORDS to any process running as the
 * same user. On a shared box that is serious. Hence the rules below.
 *
 * Three rules, all enforced here:
 *   1. parseDotenv returns a Map and never touches process.env.
 *   2. loadSecrets copies PASSWORD_* out of process.env and then DELETES them, so
 *      no later error serialiser, crash dump or debug route can spill them. Under
 *      Coolify the passwords arrive as container env vars, which makes this the
 *      load-bearing step.
 *   3. runOne spawns with an explicit minimal env (see minimalEnv), never
 *      {...process.env}.
 */

import { readFileSync } from "node:fs";
import { type Permutation, passwordVarFor } from "./permutations.ts";

/**
 * Minimal `.env` parser. ~20 lines, and deliberately not `dotenv` or
 * `process.loadEnvFile()`: both mutate process.env, which is precisely what we are
 * trying to avoid. No variable interpolation, we do not want it.
 */
export function parseDotenv(text: string): Map<string, string> {
	const out = new Map<string, string>();
	for (const rawLine of text.split("\n")) {
		const line = rawLine.replace(/\r$/, "").trim();
		if (line === "" || line.startsWith("#")) continue;
		const eq = line.indexOf("=");
		if (eq <= 0) continue;
		const key = line.slice(0, eq).trim();
		if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
		let value = line.slice(eq + 1).trim();
		// Strip one layer of matching quotes, so `K="a#b"` keeps its hash.
		const quoted =
			value.length >= 2 &&
			((value.startsWith('"') && value.endsWith('"')) ||
				(value.startsWith("'") && value.endsWith("'")));
		if (quoted) value = value.slice(1, -1);
		out.set(key, value);
	}
	return out;
}

export class MissingPasswordError extends Error {
	readonly variable: string;
	constructor(variable: string) {
		super(`No password for ${variable}`);
		this.name = "MissingPasswordError";
		this.variable = variable;
	}
}

export interface SecretStore {
	passwordFor(p: Permutation): string;
	/** The passwordVar names that have no value. */
	missingFor(perms: readonly Permutation[]): string[];
	readonly size: number;
}

export interface LoadSecretsOptions {
	/** Defaults to `<cwd>/.env`. Missing file is not an error. */
	envPath?: string | undefined;
	/** Injectable for tests. Defaults to process.env. */
	processEnv?: Record<string, string | undefined> | undefined;
	/**
	 * Delete PASSWORD_* from the live process.env after copying. Defaults to true
	 * when reading the real process.env. This is what stops a crash dump leaking
	 * every password on a Coolify deploy, where they arrive as container env vars.
	 */
	scrubProcessEnv?: boolean | undefined;
}

export function loadSecrets(o: LoadSecretsOptions = {}): SecretStore {
	const usingRealEnv = o.processEnv === undefined;
	const env = o.processEnv ?? process.env;
	const scrub = o.scrubProcessEnv ?? usingRealEnv;

	const secrets = new Map<string, string>();

	// 1. `.env` first, for local development.
	const envPath = o.envPath ?? ".env";
	try {
		const text = readFileSync(envPath, "utf8");
		for (const [k, v] of parseDotenv(text)) {
			if (k.startsWith("PASSWORD_") && v !== "") secrets.set(k, v);
		}
	} catch {
		// No .env is normal in production. Secrets come from the environment.
	}

	// 2. The real environment wins, so a Coolify-set value overrides a stale .env.
	for (const key of Object.keys(env)) {
		if (!key.startsWith("PASSWORD_")) continue;
		const value = env[key];
		if (value !== undefined && value !== "") secrets.set(key, value);
	}

	// 3. Scrub. From here the only copy lives in this closure.
	if (scrub) {
		for (const key of Object.keys(env)) {
			if (key.startsWith("PASSWORD_")) delete env[key];
		}
	}

	return {
		passwordFor(p) {
			const key = passwordVarFor(p);
			const value = secrets.get(key);
			if (value === undefined) throw new MissingPasswordError(key);
			return value;
		},
		missingFor(perms) {
			return perms
				.map((p) => passwordVarFor(p))
				.filter((key) => !secrets.has(key));
		},
		get size() {
			return secrets.size;
		},
	};
}

/**
 * The environment handed to each KoLmafia JVM. Explicit allow-list, never a spread
 * of process.env, see the file header.
 *
 * JAVA_HOME matters in the container (the JRE is copied from eclipse-temurin into
 * /opt/java/openjdk). TZ and LANG keep mafia's date and text handling predictable.
 */
export function minimalEnv(
	base: Record<string, string | undefined> = process.env,
): Record<string, string> {
	const out: Record<string, string> = {};
	for (const key of ["PATH", "HOME", "LANG", "LC_ALL", "TZ", "JAVA_HOME"]) {
		const value = base[key];
		if (value !== undefined) out[key] = value;
	}
	return out;
}
