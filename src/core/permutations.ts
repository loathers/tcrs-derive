/**
 * The class x sign permutation table and the TCRS filename scheme.
 *
 * PURE: no `node:` imports, ever. Imported by the browser bundle, the ink CLI and
 * the server alike. See tests/core.purity.test.ts.
 *
 * Ported from run-all.sh:58-65 (class_token / CLASS_ORDER / SIGNS) and
 * common.sh:32-35 (tcrs_files). The bash `to_lower`/`to_upper` helpers are gone, * they existed only because macOS ships bash 3.2, which lacks ${x,,}/${x^^}.
 */

/** Class abbreviations, in the order the progress chart lists them. */
export const CLASS_ORDER = ["sc", "tt", "pm", "sa", "db", "at"] as const;
export type ClassAbbr = (typeof CLASS_ORDER)[number];

/** Abbreviation -> class name as it appears in the TCRS filename. */
export const CLASS_TOKENS = {
	sc: "Seal_Clubber",
	tt: "Turtle_Tamer",
	pm: "Pastamancer",
	sa: "Sauceror",
	db: "Disco_Bandit",
	at: "Accordion_Thief",
} as const satisfies Record<ClassAbbr, string>;
export type ClassToken = (typeof CLASS_TOKENS)[ClassAbbr];

/** Human-facing class names, for the web UI's row headers. */
export const CLASS_LABELS = {
	sc: "Seal Clubber",
	tt: "Turtle Tamer",
	pm: "Pastamancer",
	sa: "Sauceror",
	db: "Disco Bandit",
	at: "Accordion Thief",
} as const satisfies Record<ClassAbbr, string>;

export const SIGNS = [
	"Mongoose",
	"Wallaby",
	"Vole",
	"Platypus",
	"Opossum",
	"Marmot",
	"Wombat",
	"Blender",
	"Packrat",
] as const;
export type Sign = (typeof SIGNS)[number];

/** The three data files KoLmafia writes per permutation (common.sh:14). */
export const TCRS_SUFFIXES = ["", "_cafe_booze", "_cafe_food"] as const;

/** Which of the three files a name refers to. */
export type FileKind = "items" | "cafe_booze" | "cafe_food";
export const FILE_KINDS = ["items", "cafe_booze", "cafe_food"] as const;

/** Human-facing file-kind labels, for the web UI's column headers. */
export const FILE_KIND_LABELS = {
	items: "items",
	cafe_booze: "cafe booze",
	cafe_food: "cafe food",
} as const satisfies Record<FileKind, string>;

export interface Permutation {
	/** Account name, e.g. "tt_wallaby". Also the chart's row label. */
	readonly user: string;
	readonly abbr: ClassAbbr;
	readonly classToken: ClassToken;
	readonly classLabel: string;
	readonly signCap: Sign;
	readonly signLower: Lowercase<Sign>;
	/** The three output basenames, in TCRS_SUFFIXES order. */
	readonly files: readonly [string, string, string];
}

/**
 * The three TCRS output basenames for a permutation, the single source of truth
 * for the filename scheme the whole tool is built around (common.sh:32-35).
 */
/**
 * The env var holding a permutation's password, e.g. "PASSWORD_TT_WALLABY".
 *
 * A free function rather than a field on Permutation, deliberately: Permutation is
 * imported by the BROWSER bundle (the progress grid needs the class/sign tables),
 * and the browser has no business carrying password variable names. Keeping them
 * out also keeps a `grep PASSWORD_ build/client` leak-scan meaningful.
 */
export function passwordVarFor(p: { readonly user: string }): string {
	return `PASSWORD_${p.user.toUpperCase()}`;
}

export function tcrsFiles(
	classToken: string,
	signCap: string,
): readonly [string, string, string] {
	return [
		`TCRS_${classToken}_${signCap}.txt`,
		`TCRS_${classToken}_${signCap}_cafe_booze.txt`,
		`TCRS_${classToken}_${signCap}_cafe_food.txt`,
	];
}

/**
 * ASCII-only, so the non-locale case methods are provably safe. `toLocaleUpperCase`
 * would map Turkish `I` to `ı` and produce a password var that matches nothing.
 */
function lower(s: string): string {
	return s.toLowerCase();
}

/**
 * The account name for a permutation. Exported so nothing rebuilds it inline: a
 * caller that gets it wrong looks up an absent key and silently renders nothing,
 * which is exactly the failure a shared table exists to prevent.
 */
export function userFor(abbr: ClassAbbr, signCap: Sign): string {
	return `${abbr}_${lower(signCap)}`;
}

function makePermutation(abbr: ClassAbbr, signCap: Sign): Permutation {
	const classToken = CLASS_TOKENS[abbr];
	const signLower = lower(signCap) as Lowercase<Sign>;
	const user = userFor(abbr, signCap);
	return {
		user,
		abbr,
		classToken,
		classLabel: CLASS_LABELS[abbr],
		signCap,
		signLower,
		files: tcrsFiles(classToken, signCap),
	};
}

/**
 * All 54 permutations in CLASS_ORDER x SIGNS order, NOT alphabetical. This is the
 * progress chart's row order and the web grid's cell order, so it is load-bearing.
 */
export const ALL_PERMUTATIONS: readonly Permutation[] = CLASS_ORDER.flatMap(
	(abbr) => SIGNS.map((signCap) => makePermutation(abbr, signCap)),
);

/** All 162 output basenames, the download allow-list (see the server's routes). */
export const ALL_FILE_NAMES: readonly string[] = ALL_PERMUTATIONS.flatMap(
	(p) => p.files,
);

const BY_USER = new Map(ALL_PERMUTATIONS.map((p) => [p.user, p]));

export function permutationByUser(user: string): Permutation | undefined {
	return BY_USER.get(user);
}

const BY_FILE = new Map<string, { permutation: Permutation; kind: FileKind }>(
	ALL_PERMUTATIONS.flatMap((permutation) =>
		permutation.files.flatMap((name, i) => {
			const kind = FILE_KINDS[i];
			return kind === undefined ? [] : [[name, { permutation, kind }] as const];
		}),
	),
);

/** Resolve an output basename back to its permutation. Returns undefined for
 *  anything not in the closed set of 162, which is what makes the download route
 *  traversal-proof by construction. */
export function permutationForFile(
	name: string,
): { permutation: Permutation; kind: FileKind } | undefined {
	return BY_FILE.get(name);
}

export interface SelectOptions {
	readonly only?: readonly string[] | undefined;
	readonly exclude?: readonly string[] | undefined;
}

export interface Selection {
	readonly selected: Permutation[];
	readonly excluded: Permutation[];
	/** Names in `only`/`exclude` matching no permutation. The bash silently ignored
	 *  these: `ONLY=tt_walaby` ran zero permutations and printed "Nothing to do". */
	readonly unknown: string[];
}

/**
 * Apply the ONLY/EXCLUDE filters. EXCLUDE is applied first, then ONLY as an
 * allow-list, the order run-all.sh's want_user() used (run-all.sh:87-91).
 */
export function selectPermutations(o: SelectOptions = {}): Selection {
	// An empty list must mean "no filter", not "allow nothing", ONLY="" is how the
	// bash spelled unset, and a list of only blanks reduces to the same thing.
	const onlyList = o.only?.filter((s) => s.length > 0) ?? [];
	const only = onlyList.length > 0 ? onlyList : undefined;
	const exclude = new Set(o.exclude?.filter((s) => s.length > 0) ?? []);

	const unknown = [...new Set([...(only ?? []), ...exclude])]
		.filter((name) => !BY_USER.has(name))
		.sort();

	const selected: Permutation[] = [];
	const excluded: Permutation[] = [];
	for (const p of ALL_PERMUTATIONS) {
		const keep =
			!exclude.has(p.user) && (only === undefined || only.includes(p.user));
		(keep ? selected : excluded).push(p);
	}
	return { selected, excluded, unknown };
}
