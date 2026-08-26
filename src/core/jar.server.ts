/**
 * KoLmafia jar resolution. NODE-ONLY. Port of common.sh:59-66 and run-all.sh:21-34.
 *
 * Two improvements over the bash:
 *  - No `curl` or `jq` required: global fetch parses the GitHub release JSON. That
 *    is a genuine reduction in external dependencies.
 *  - A release can be PINNED. download_latest_jar had no pinning and no checksum,
 *    so it could silently pick up a mafia release whose output strings changed,
 *    breaking the parser mid-batch with no diagnosis. In production the jar is
 *    baked into the image at a pinned MAFIA_TAG and this path is never taken.
 */

import { readdir, rename, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";

const RELEASES = "https://api.github.com/repos/kolmafia/kolmafia/releases";

export class JarUnavailableError extends Error {
	readonly detail: string;
	constructor(detail: string) {
		super(detail);
		this.name = "JarUnavailableError";
		this.detail = detail;
	}
}

/**
 * Resolve the jar, downloading a pinned release if there is not one already.
 *
 * Shared by BOTH entry points. It used to live only in the CLI, which meant the
 * server handed an unresolved path straight to spawn(): on a machine without a jar
 * every permutation failed with a confusing spawn error instead of the site either
 * fetching it or saying plainly that it could not.
 *
 * In the container this is a no-op, the jar is baked in at a pinned MAFIA_TAG, * but it is what makes a fresh dev checkout or a fresh volume work unattended.
 *
 * ALWAYS RETURNS AN ABSOLUTE PATH, and that is a correctness requirement rather
 * than tidiness: each JVM is spawned with cwd set to its own private work dir, so a
 * relative `-jar KoLmafia.jar` would be resolved against THAT directory and every
 * permutation would die instantly with "unable to open file KoLmafia.jar".
 */
export async function ensureJar(o: {
	/** The configured path, e.g. $JAR. Also the download destination. */
	configured: string;
	/** Where to look for an existing KoLmafia*.jar. */
	searchDir: string;
	/** Pin a release, e.g. "r29131". Unset means latest. */
	tag?: string | undefined;
	/** Set false to fail rather than reach out to the network. */
	allowDownload?: boolean;
	onProgress?: ((message: string) => void) | undefined;
}): Promise<string> {
	const found = await resolveJar({
		explicit: o.configured,
		searchDir: o.searchDir,
	});
	if (found !== null) return found;

	if (o.allowDownload === false) {
		throw new JarUnavailableError(
			`No KoLmafia jar at ${o.configured} and downloading is disabled`,
		);
	}

	try {
		const asset = await findReleaseJar(o.tag);
		o.onProgress?.(
			`No KoLmafia jar found; downloading ${asset.name} (${asset.tag})...`,
		);
		await downloadJar(asset.url, o.configured);
		o.onProgress?.(`Downloaded ${asset.name} to ${o.configured}`);
		return absolute(o.configured);
	} catch (e) {
		throw new JarUnavailableError(
			`Could not obtain a KoLmafia jar: ${e instanceof Error ? e.message : String(e)}`,
		);
	}
}

/** Locate an existing jar. Returns an ABSOLUTE path, or null, see ensureJar. */
export async function resolveJar(o: {
	explicit?: string | undefined;
	searchDir: string;
}): Promise<string | null> {
	if (o.explicit) {
		// A relative $JAR is resolved against the process cwd here, once, rather than
		// against each child's work dir later.
		const candidate = absolute(o.explicit, o.searchDir);
		return (await isFile(candidate)) ? candidate : null;
	}
	let names: string[];
	try {
		names = await readdir(o.searchDir);
	} catch {
		return null;
	}
	const jar = names
		.filter((n) => /^kolmafia.*\.jar$/i.test(n))
		.sort()
		.at(-1);
	if (jar === undefined) return null;
	const path = absolute(join(o.searchDir, jar));
	return (await isFile(path)) ? path : null;
}

/** Make a path absolute, relative to `base` (default: the process cwd). */
function absolute(p: string, base = process.cwd()): string {
	return isAbsolute(p) ? p : resolve(base, p);
}

export interface ReleaseAsset {
	tag: string;
	url: string;
	name: string;
}

/** Find a release asset, a specific tag when given, else the latest. */
export async function findReleaseJar(tag?: string): Promise<ReleaseAsset> {
	const url =
		tag === undefined ? `${RELEASES}/latest` : `${RELEASES}/tags/${tag}`;
	const res = await fetch(url, {
		headers: { accept: "application/vnd.github+json" },
	});
	if (!res.ok) {
		throw new Error(`GitHub returned ${res.status} for ${url}`);
	}
	const body = (await res.json()) as {
		tag_name?: string;
		assets?: { name: string; browser_download_url: string }[];
	};
	const asset = body.assets?.find((a) => a.name.endsWith(".jar"));
	if (!asset) throw new Error(`No .jar asset in release ${tag ?? "latest"}`);
	return {
		tag: body.tag_name ?? tag ?? "latest",
		url: asset.browser_download_url,
		name: asset.name,
	};
}

export async function downloadJar(url: string, dest: string): Promise<void> {
	const res = await fetch(url, { redirect: "follow" });
	if (!res.ok) throw new Error(`Download failed: ${res.status} ${url}`);

	// Buffered rather than streamed: the jar is ~34MB, this runs at most once, and
	// in production the jar is baked into the image at a pinned MAFIA_TAG so this
	// path is never taken at all. Streaming would need a Node/DOM ReadableStream
	// cast for no real benefit.
	const bytes = Buffer.from(await res.arrayBuffer());
	if (bytes.byteLength === 0) throw new Error(`Empty download from ${url}`);

	// Temp path then rename, so an interrupted download never leaves a truncated jar
	// that looks usable.
	const tmp = `${dest}.part`;
	await writeFile(tmp, bytes);
	await rename(tmp, dest);
}

async function isFile(path: string): Promise<boolean> {
	try {
		const st = await stat(path);
		return st.isFile() && st.size > 0;
	} catch {
		return false;
	}
}
