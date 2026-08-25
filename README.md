# tcrs-derive

Batch-derives KoLmafia's **Two Crazy Random Summer** (TCRS) item-modifier data for
every class × sign permutation, and serves the results from a small website.

There are 54 dedicated KoL accounts, one per permutation, named `<classAbbr>_<sign>`
(e.g. `tt_wallaby`), each **already inside an active TCRS run** as the matching class
and sign. For each account the tool logs in, runs `tcrs reset`, `tcrs derive`,
`tcrs save`, and collects the three files KoLmafia writes:

- `TCRS_<Class>_<Sign>.txt`
- `TCRS_<Class>_<Sign>_cafe_booze.txt`
- `TCRS_<Class>_<Sign>_cafe_food.txt`

54 × 3 = 162 files, about 50 MB. A full run takes roughly 8 minutes.

The site lets anyone download the files (individually or as one zip), see when they
were last generated, and request a regeneration once every 12 hours — watching the
progress of whichever run is currently happening, whoever started it.

## Two ways to run it

```sh
yarn dev                 # the website, at http://localhost:3000
yarn tcrs run            # a one-off batch in the terminal, with a live chart
yarn tcrs attach         # watch a run happening on the server
yarn tcrs list --check-env
```

Both interfaces are thin layers over one shared core. In particular
`src/core/state.ts` — the reducer that turns the event stream into progress — runs
server-side, in the browser, *and* in the terminal, so the web page and the terminal
chart cannot drift apart.

## Requirements

- **Node 22+** (24 recommended; the server runs `server.ts` directly via Node's
  built-in type stripping).
- **A JVM (Java 21+)** on `PATH`, for KoLmafia itself.
- Yarn 4 (`corepack enable`).

No `curl`/`jq` needed any more — jar downloads use `fetch`.

## Setup

Each account has its own password variable, `PASSWORD_<CLASS>_<SIGN>` (e.g.
`PASSWORD_TT_WALLABY`). Copy the template and fill them in — if the accounts share a
password, set every line to the same value:

```sh
cp .env.example .env
# edit .env; if they share a password:  sed -i '' 's/=$/=thepassword/' .env
```

`.env` is gitignored. Check it before a long run:

```sh
yarn tcrs list --check-env
```

Unlike the old shell version you do **not** export these into your shell. They are
read into memory and deliberately removed from `process.env`, and each JVM is spawned
with an explicit minimal environment — see [Security](#security).

## How it works

- Each permutation is its own isolated KoLmafia JVM, launched with
  `-DuseCWDasROOT=true` in a private working directory so concurrent runs never clash
  (TCRS files land in `<workdir>/data/`), fanned out `CONCURRENCY` at a time.
- KoLmafia runs pure-headless (`-Djava.awt.headless=true`). Headless is load-bearing:
  it makes mafia read the login-time "derive TCRS data?" yes/no prompts from stdin
  instead of popping modal Swing dialogs that would block forever.
- Login and commands go in on stdin: `username`, `password`, `no`, `no`,
  `tcrs reset`, `tcrs derive`, `tcrs save`, `exit`.
- Progress comes from **reading each child's stdout directly**. The shell version
  re-derived all state every 1.5 s by `tr | awk | grep`-ing 54 growing log files —
  about 65,000 processes and 80 MB of re-reading per batch, just to draw bars.
- A one-time warm-up populates a shared data template so common startup downloads
  aren't repeated 54 times.

### Publishing is atomic

A run writes into `data/runs/<timestamp>/` and only becomes visible by swapping one
symlink:

```
data/
  state.json                      cooldown + attempt history
  current -> runs/2026-08-24T09-15-03-123Z
  runs/<runId>/
    data/         162 TCRS_*.txt + SHA256SUMS.txt
    logs/         one log per permutation
    manifest.json
    tcrs-data.zip
  work/           per-JVM scratch (cleared between runs)
```

This matters for the website: the old script copied each file into the live output
directory as that account finished, so mid-run a visitor would have downloaded a mix
of old and new data. Now the previous dataset is served untouched until the new one
is complete.

If a permutation fails, its files are **carried forward** from the previous run rather
than disappearing — 53 fresh files plus one stale beats a broken link — and the site
marks those rows `stale`. A run is only published if it covers at least as many
permutations as the one before it.

## Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `PASSWORD_<CLASS>_<SIGN>` | — (required) | Password for one account, e.g. `PASSWORD_TT_WALLABY`. |
| `CONCURRENCY` | `3` | Permutations in parallel. Each is a full JVM and a login from one IP. |
| `TIMEOUT` | `1800` | Per-account seconds before the JVM is killed. |
| `LOGIN_TIMEOUT` | `180` | Seconds to wait for deriving to start before treating a login as stuck. |
| `MAX_ATTEMPTS` | `3` | Login attempts per permutation. |
| `RETRY_BACKOFF` | `15` | Base seconds between attempts (multiplied by attempt number). |
| `STALL_TIMEOUT` | (unset) | Kill a derive that reports no progress for this many seconds. |
| `DATA_DIR` | `./data` | Data root (runs, state, scratch). |
| `JAR` | `./KoLmafia.jar` | KoLmafia jar. |
| `JAVA_OPTS` | — | Extra JVM flags, e.g. `-Xmx512m`. |
| `ONLY` / `EXCLUDE` | (unset) | Comma-separated permutation filters. |
| `RESUME` | (unset) | `1` to skip permutations the published manifest records as complete. |
| `COOLDOWN_HOURS` | `12` | Minimum gap between runs. |
| `FAILED_COOLDOWN_HOURS` | `1` | Shorter gap after a run in which nothing succeeded. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Web server bind. |

Every one is also a CLI flag — `yarn tcrs run --help`.

## Login retries

KoL logins are occasionally flaky: KoLmafia's Java client can hit an intermittent
`HTTP connect timed out` on `login.php` even when the network is fine (more likely
with high `CONCURRENCY`, since many logins come from one IP). Left alone, such an
account would burn its full `TIMEOUT` doing nothing.

Each permutation therefore:

- **fails fast** — a connection timeout, or deriving not starting within
  `LOGIN_TIMEOUT`, kills that attempt rather than waiting out `TIMEOUT`;
- **retries** transient failures up to `MAX_ATTEMPTS` with growing backoff. A
  non-transient failure (e.g. the account genuinely isn't in a TCRS run) is *not*
  retried;
- **discards partial output.** A parallel derive can bail out but still print `Done!`
  and save a truncated file, so file existence is not enough: the run must have
  reported progress within 150 items of the total.

If you see lots of retries, lower `CONCURRENCY`.

## The terminal chart

On an interactive terminal, `yarn tcrs run` draws one bar per permutation:

```
sc_mongoose  [█████████░]  91% items
sc_wallaby   [██░░░░░░░░]  18% items
tt_mongoose  [██████████] done
tt_vole      [░░░░░░░░░░] queued
...
Overall: 12/54 done  (4 running, 0 failed, 38 queued)
```

Percentages come from KoLmafia's own `Progress: x/y` output. Only the real-items
phase reports progress, so the two cafe phases show a full bar labelled `cafe booze`
/ `cafe food` rather than a stale percentage. The items percentage caps at 99%
because mafia announces every 100 items and the total isn't a multiple of 100.

Piped or non-interactive output switches to one line per state transition; `--json`
emits NDJSON of the raw event stream.

## Security

The shell version told you to `export $(grep -v '^#' .env | xargs)`. That environment
was inherited all the way down to every JVM, so `/proc/<jvm-pid>/environ` exposed
**all 54 passwords** to any process running as the same user. Now:

1. passwords are read into a `Map` and **deleted from `process.env`** at boot, so no
   later crash dump or error serialiser can spill them;
2. each JVM is spawned with an explicit allow-list environment, never a copy of the
   parent's;
3. the password goes in on **stdin**, never argv.

Downloads are traversal-proof by construction: a requested filename is looked up in a
closed set generated from the permutation table and is never used to build a path
until it has been found there.

## Deployment (Docker → Coolify)

```sh
docker build -t tcrs .
docker run -p 3000:3000 -v tcrs-data:/data --env-file .env --memory 4g tcrs
```

Coolify settings that matter:

| Setting | Value | Why |
|---|---|---|
| **Persistent volume** | `/data` | Holds the dataset, the zip and `state.json`. **Without it every redeploy loses the data and the cooldown history.** |
| Environment | the 54 `PASSWORD_*`, plus any overrides | Runtime, not build-time. |
| Healthcheck | `GET /healthz` | Stays 200 *during* a run — an 8-minute derive is not unhealthy. |
| **Deploy strategy** | **stop-then-start, not rolling** | See below. |
| Stop grace period | **60s** | A run needs up to ~45s to abort cleanly and record itself; Docker's default is 10s. |
| Memory | ≥4 GB | `CONCURRENCY=3` × ~400–500 MB per mafia JVM, plus Node. |

**Rolling deploys must be off.** They start the new container before stopping the old
one, and both would mount the same `/data`. The single-instance lock means the new
container exits with a clear message rather than corrupting anything — but that
presents as a failed deploy. (The lock identifies its holder by hostname plus a
heartbeat, not by pid, precisely because two containers have separate PID namespaces
and a pid recorded by one is meaningless to the other.)

**`tini` is the image ENTRYPOINT and that is not cosmetic.** Every JVM is spawned
detached, so one that outlives its parent is reparented to PID 1 — and Node as PID 1
does not reap children. They would accumulate as zombies across runs. `tini` reaps
them and forwards signals.

**The KoLmafia jar tracks the latest release** and is baked into the image at build
time, so the container never downloads at boot. Pin one with
`--build-arg MAFIA_TAG=r29183` if you need to. Whichever build a run used is recorded
in that run's `manifest.json` and shown on the site, so a bad batch can always be
traced back to a jar.

If you do pin, do not pin at or below `r29131`: it has a race in
`TCRSDatabase.save`, which iterates the TCRS map while the derive's own worker
threads are still mutating it, throwing `ConcurrentModificationException`. The
observed effect was **every one of the 54 permutations failing**, at a random point
between 900 and 9200 items, on all three attempts. Fixed by `r29183`.

> **Apple Silicon note:** this applies to *local* Docker only. A containerised JVM
> under Docker Desktop on Apple Silicon suffers pathologically slow first-TLS-handshake
> times (tens of seconds per JVM, past KoLmafia's connect timeout), because Docker
> Desktop runs a Linux VM. On a Linux x86-64 host — including the Coolify target —
> Docker is namespaces with no VM and no such problem. For local development just run
> `yarn dev` natively; there is no need for Docker at all.

## Tests

```sh
yarn test        # 240+ tests, no JVM, no network, no KoL account
yarn typecheck
```

The suite runs entirely offline. `tests/fixtures/fake-java.mjs` impersonates the JVM
by replaying real captured logs, which exercises the actual spawn/pipe plumbing,
both watchdogs, process-group killing, partial-output discarding, retries and
cancellation.

The committed fixtures under `tests/fixtures/logs/` are real output from a successful
54-permutation run, and several tests exist only because of what they revealed — for
example, `Error during session initialization` appears in **every successful run**, and
`Unable to invoke no` appears 108 times, so a slightly-too-broad "does this look like
an error?" pattern would burn all three retries on all 54 permutations.
`tests/parser.falsePositives.test.ts` guards exactly that.

## Notes

- `tcrs derive`/`save`/`reset` require the character to be in a TCRS run. An account
  that isn't shows "You are not in a Two Crazy Random Summer run" in its log and is
  marked failed — and is *not* retried, since retrying cannot help.
- `tcrs derive` fetches every item's description from KoL, so each account takes a
  while; the parallel fan-out is what keeps the whole batch tractable.
