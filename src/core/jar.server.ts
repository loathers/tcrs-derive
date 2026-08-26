/**
 * KoLmafia jar resolution. NODE-ONLY.
 *
 * Two things worth knowing:
 *  - No `curl` or `jq` required: global fetch parses the GitHub release JSON.
 *  - A release can be PINNED. Always taking the latest, with no checksum, could
 *    silently pick up a mafia release whose output strings changed, breaking the
 *    parser mid-batch with no diagnosis. MAFIA_TAG is how you stop that, and
 *    updateJar() honours it by refusing to upgrade past it.
 *
 * The tag a jar came from is recorded in a `<jar>.tag` sidecar, which is what lets
 * updateJar() tell "already current" from "never checked". The image writes one for
 * the jar it bakes in, so a fresh container does not re-download what it shipped.
 */

import {
	mkdir,
	readdir,
	readFile,
	rename,
	stat,
	writeFile,
} from "node:fs/promises";
import { isAbsolute, join, resolve } from "node:path";
import type { TcrsCommand } from "./runOne.server.ts";

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

	// Buffered rather than streamed: the jar is ~34MB and this runs at most once per
	// mafia release. Streaming would need a Node/DOM ReadableStream cast for no real
	// benefit at that size.
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

/** The release tag a jar came from, from its sidecar. Null when unrecorded. */
export async function readJarTag(jarPath: string): Promise<string | null> {
	try {
		const tag = (await readFile(`${jarPath}.tag`, "utf8")).trim();
		return tag === "" ? null : tag;
	} catch {
		// No sidecar means an unknown provenance, which updateJar treats as "stale".
		return null;
	}
}

export interface JarUpdate {
	path: string;
	tag: string;
	/** False when that release was already on disk and only the path changed. */
	downloaded: boolean;
}

/**
 * Check for a newer KoLmafia release, fetching it if there is one.
 *
 * Returns null when nothing should change, which is the common case: a pinned tag,
 * or the latest release is already the one in use.
 *
 * THROWS on a failed check, and the caller is expected to carry on with the jar it
 * already has. GitHub being unreachable is not a reason to abandon a derive.
 */
export async function updateJar(o: {
	/** Path to the jar in use. Its sidecar says which release it came from. */
	current: string;
	/** Where fetched jars live. Wants to be on persistent storage. */
	dir: string;
	/** MAFIA_TAG. Set means the operator chose a build, so do not move off it. */
	pinnedTag?: string | undefined;
	onProgress?: ((message: string) => void) | undefined;
}): Promise<JarUpdate | null> {
	// A pin is a deliberate choice about which build derives the dataset. Upgrading
	// past it would make MAFIA_TAG mean nothing.
	if (o.pinnedTag !== undefined && o.pinnedTag !== "") return null;

	const currentTag = await readJarTag(o.current);
	const asset = await findReleaseJar();
	if (asset.tag === currentTag) return null;

	const dest = join(o.dir, asset.name);
	if (await isFile(dest)) {
		// Already fetched by an earlier run, so only the sidecar needs catching up.
		await writeFile(`${dest}.tag`, asset.tag);
		return { path: absolute(dest), tag: asset.tag, downloaded: false };
	}

	o.onProgress?.(
		`KoLmafia ${asset.tag} supersedes ${currentTag ?? "the bundled jar"}, fetching it`,
	);
	await mkdir(o.dir, { recursive: true });
	await downloadJar(asset.url, dest);
	await writeFile(`${dest}.tag`, asset.tag);
	return { path: absolute(dest), tag: asset.tag, downloaded: true };
}

/**
 * Markers for the class that runs a full three-phase pass.
 *
 * A jar is a zip, and zip stores entry NAMES uncompressed, so the inner class name
 * is readable straight out of the file with no unzip and no JVM. Each appears twice,
 * once in the local header and once in the central directory.
 */
const INTROSPECT_MARKER = "TCRSIntrospectRunnable";
const DERIVE_MARKER = "TCRSDeriveRunnable";

export interface TcrsCommandProbe {
	command: TcrsCommand;
	/**
	 * False when neither marker was found, which means the jar reorganised again and
	 * `command` is a guess. Worth surfacing rather than silently deriving.
	 */
	recognised: boolean;
}

/**
 * Work out which command performs the full run for a given jar.
 *
 * r29189 and earlier: `tcrs derive` is the full pass. Later builds rename it to
 * `tcrs introspect` and give `derive` a NARROWER job, introspecting only the items
 * missing from items.txt. Sending the wrong one either fails outright, on an old
 * jar, or quietly produces a different dataset, on a new one, so it cannot be a
 * fixed default once runs fetch their own jars.
 *
 * Falls back to `derive` when neither marker is present: it is the one every jar
 * released so far has, and a failed run beats a silently partial dataset.
 */
export async function detectTcrsCommand(
	jarPath: string,
): Promise<TcrsCommandProbe> {
	const bytes = await readFile(jarPath);
	if (bytes.includes(INTROSPECT_MARKER)) {
		return { command: "introspect", recognised: true };
	}
	if (bytes.includes(DERIVE_MARKER)) {
		return { command: "derive", recognised: true };
	}
	return { command: "derive", recognised: false };
}
