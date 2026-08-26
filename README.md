# tcrs-derive

Batch-derives KoLmafia's Two Crazy Random Summer (TCRS) item-modifier data for every
class × sign permutation, and serves the results from a small website.

There are 54 dedicated KoL accounts, one per permutation, named `<classAbbr>_<sign>`
(e.g. `tt_wallaby`), each already inside an active TCRS run as the matching class and
sign. For each one the tool logs in, derives, and collects the three files KoLmafia
writes. That is 162 files and about 50 MB. A full run takes roughly 8 minutes.

## Requirements

- Node 22+ (24 recommended)
- A JVM (Java 21+) on `PATH`, for KoLmafia itself
- Yarn 4 (`corepack enable`)

## Setup

Each account has its own password variable, `PASSWORD_<CLASS>_<SIGN>`, for example
`PASSWORD_TT_WALLABY`. Copy the template and fill them in. If the accounts share a
password, set every line to the same value:

```sh
cp .env.example .env
# edit .env. If they share a password:  sed -i '' 's/=$/=thepassword/' .env
```

`.env` is gitignored, and you should not export it into your shell. `tcrs` reads the
file itself. Check it before a long run:

```sh
yarn tcrs list --check-env
```

## Usage

```sh
yarn dev                 # the website, at http://localhost:3000
yarn tcrs run            # a one-off batch in the terminal, with a live chart
yarn tcrs attach         # watch a run happening on the server
yarn tcrs list           # the 54 permutations
```

Every variable below is also a CLI flag. Run `yarn tcrs run --help` for the full list.

## Configuration

| Var | Default | Meaning |
|-----|---------|---------|
| `PASSWORD_<CLASS>_<SIGN>` | (required) | Password for one account, e.g. `PASSWORD_TT_WALLABY`. |
| `CONCURRENCY` | `3` | Permutations in parallel. Each is a full JVM and a login from one IP. |
| `TIMEOUT` | `1800` | Per-account seconds before the JVM is killed. |
| `LOGIN_TIMEOUT` | `180` | Seconds to wait for deriving to start before treating a login as stuck. |
| `MAX_ATTEMPTS` | `3` | Login attempts per permutation. |
| `RETRY_BACKOFF` | `15` | Base seconds between attempts, multiplied by attempt number. |
| `STALL_TIMEOUT` | (unset) | Kill a derive that reports no progress for this many seconds. |
| `DATA_DIR` | `./data` | Data root (runs, state, scratch). |
| `JAR` | `./KoLmafia.jar` | KoLmafia jar. |
| `JAVA_OPTS` | (unset) | Extra JVM flags, e.g. `-Xmx512m`. |
| `ONLY` / `EXCLUDE` | (unset) | Comma-separated permutation filters. |
| `RESUME` | (unset) | `1` to skip permutations the published manifest records as complete. |
| `COOLDOWN_HOURS` | `12` | Minimum gap between runs. |
| `FAILED_COOLDOWN_HOURS` | `1` | Shorter gap after a run in which nothing succeeded. |
| `PORT` / `HOST` | `3000` / `0.0.0.0` | Web server bind. |

If you see a lot of retries, lower `CONCURRENCY`.

## Docker

```sh
docker build -t tcrs .
docker run -p 3000:3000 -v tcrs-data:/data --env-file .env --memory 4g tcrs
```

Mount a persistent volume at `/data`, or every redeploy loses the dataset and the
cooldown history. Give the container at least 4 GB, a 60 second stop grace period
(a run needs up to 45 seconds to abort cleanly), and a healthcheck on `GET /healthz`.
Deploy stop-then-start rather than rolling, because two containers cannot share
`/data`.

The KoLmafia jar is baked into the image at build time. Pin one with
`--build-arg MAFIA_TAG=r29183` if you need to, but not at or below `r29131`, which
has a race in `TCRSDatabase.save` that fails every permutation.

## Tests

```sh
yarn test
yarn typecheck
yarn lint
```
