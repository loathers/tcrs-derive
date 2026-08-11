# tcrs-derive

Batch-derives KoLmafia's **Two Crazy Random Summer** (TCRS) item-modifier data files for
every class × sign permutation.

There are 54 dedicated KoL accounts, one per permutation, each named `<classAbbr>_<sign>`
(e.g. `tt_wallaby`) and each **already inside an active TCRS run** as the matching class and
sign. For each account this tool logs in, runs `tcrs reset`, `tcrs derive`, `tcrs save`, and
collects the three files KoLmafia writes:

- `TCRS_<Class>_<Sign>.txt`
- `TCRS_<Class>_<Sign>_cafe_booze.txt`
- `TCRS_<Class>_<Sign>_cafe_food.txt`

All 54 × 3 = 162 files land in a single clean data directory (`./out` by default); the
per-account logs go separately to `./logs`.

## Requirements

- A JVM (Java 21+) on `PATH`.
- `curl` and `jq`, only if you want the script to auto-download the KoLmafia jar.
- Works with the stock macOS `/bin/bash` (3.2) — no extra tooling to install.

## How it works

- Each permutation is its own isolated KoLmafia JVM, launched with `-DuseCWDasROOT=true` in a
  private working directory so concurrent runs never clash (TCRS files are written to
  `<workdir>/data/`), fanned out `CONCURRENCY` at a time.
- KoLmafia runs pure-headless (`-Djava.awt.headless=true`) on every platform — no framebuffer
  or `xvfb` needed. Headless makes mafia read the login-time "derive TCRS data?" yes/no prompts
  from stdin instead of popping modal Swing dialogs that would block forever.
- Login and commands are piped to `--CLI` on stdin: `username`, `password`, `no`, `no`,
  `tcrs reset`, `tcrs derive`, `tcrs save`, `exit`.
- A one-time warm-up populates a shared data template so common startup downloads aren't
  repeated 54 times.
- The KoLmafia jar is resolved as: `$JAR`, else a `KoLmafia*.jar` next to the scripts, else the
  latest published GitHub release (downloaded once).

> **Apple Silicon note:** run natively, not in a container — a containerised JVM under Docker
> Desktop on Apple Silicon suffers pathologically slow first-TLS-handshake times (tens of
> seconds per JVM, blowing past KoLmafia's connect timeout). A native JVM does not.

## Setup

Each multi has its own password variable, `PASSWORD_<CLASS>_<SIGN>` (e.g.
`PASSWORD_TT_WALLABY`). Copy the template and fill them in — if the multis share one password,
set every line to the same value:

```sh
cp .env.example .env
# edit .env; if they share a password:  sed -i '' 's/=$/=thepassword/' .env
```

`.env` is gitignored, so real passwords never get committed.

## Run

```sh
export $(grep -v '^#' .env | xargs)          # load the PASSWORD_* vars from .env
JAR=/path/to/KoLmafia.jar ./run-all.sh        # or omit JAR to auto-download the latest release
```

Data appears in `./out/`; per-account console logs in `./logs/`. The run ends with a summary
table and a non-zero exit code if any permutation is missing files.

### Smoke test (one permutation)

```sh
ONLY=tt_wallaby ./run-all.sh
```

Expect `out/TCRS_Turtle_Tamer_Wallaby.txt` plus the two `_cafe_*` files, and a successful
login / "Deriving TCRS item adjustments…" in `logs/tt_wallaby.log`.

## Configuration (env vars)

| Var | Default | Meaning |
|-----|---------|---------|
| `PASSWORD_<CLASS>_<SIGN>` | — (required) | Password for that one multi, e.g. `PASSWORD_TT_WALLABY`. |
| `CONCURRENCY` | `4` | Permutations run in parallel. Each is a full JVM and a login from one IP — keep it modest to avoid KoL rate-limiting and memory pressure. |
| `TIMEOUT` | `1800` | Per-account seconds before the JVM is killed. |
| `OUTPUT_DIR` | `./out` | Where the derived data files are collected. |
| `LOG_DIR` | `./logs` | Where per-account logs and completion sentinels go. |
| `ONLY` | (unset) | Comma-separated usernames to run a subset, e.g. `ONLY=tt_wallaby,sc_vole`. |
| `EXCLUDE` | (unset) | Comma-separated usernames to skip. |
| `RESUME` | (unset) | Set to `1` to skip permutations whose 3 output files already exist. |
| `NO_PROGRESS` | (unset) | Set to `1` to disable the live progress chart (see below). |
| `MAX_ATTEMPTS` | `3` | Login attempts per permutation before giving up (see "Login retries"). |
| `LOGIN_TIMEOUT` | `180` | Seconds to wait for deriving to start before treating a login as stuck. |
| `RETRY_BACKOFF` | `15` | Base seconds between attempts (multiplied by the attempt number). |

## Login retries

KoL logins are occasionally flaky — KoLmafia's Java client can hit an intermittent
`HTTP connect timed out` on `login.php` even when the network is fine (more likely with high
`CONCURRENCY`, since many logins come from one IP). Left alone, such an account would burn its
full `TIMEOUT` doing nothing and be marked `FAIL`.

Each permutation therefore watches its own log and:

- **fails fast** — if it sees a connection timeout, or deriving hasn't started within
  `LOGIN_TIMEOUT`, it kills that attempt instead of waiting out the full `TIMEOUT`;
- **retries** — transient login failures are retried up to `MAX_ATTEMPTS` times with a growing
  backoff. A non-transient failure (e.g. the account genuinely isn't in a TCRS run) is *not*
  retried.

In the progress chart, retried accounts show their attempt number, e.g. `12% real try 2/3`;
an account stuck reconnecting shows `stalled`.

If you see lots of retries, lower `CONCURRENCY` (e.g. `CONCURRENCY=2`).

## Progress display

When run on an interactive terminal, the orchestrator draws a live bar chart — one row per
permutation — that redraws in place as the batch runs:

```
sc_mongoose  [█████████░]  91% real
sc_wallaby   [██░░░░░░░░]  18% real
tt_mongoose  [██████████] done
tt_vole      [░░░░░░░░░░] queued
...
Overall: 12/54 done  (4 running, 0 failed, 38 queued)
```

Each bar's percentage comes from KoLmafia's own `Progress: x/y` output for the current derive
phase (`real` items, then cafe `booze`, then cafe `food`); finished permutations show `done`
or `FAIL n/3`. The per-account logs in `./logs/` still contain the full output.

The chart is skipped automatically when output isn't a terminal (e.g. piped to a file or CI),
falling back to the per-account status lines. Set `NO_PROGRESS=1` to force that fallback.

## Notes

- `tcrs derive`/`save`/`reset` require the character to be in a TCRS run. Any account that
  isn't will show "You are not in a Two Crazy Random Summer run" in its log and be flagged
  `FAIL` in the summary rather than failing silently.
- `tcrs derive` fetches every item's description from KoL, so each account takes a while —
  the parallel fan-out is what keeps the whole batch tractable.
