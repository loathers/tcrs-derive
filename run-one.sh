#!/usr/bin/env bash
# Derive + save TCRS data for a single account (one class/sign permutation).
# Args: <abbr> <classToken> <SignCap> <signLower>
#   abbr       - class abbreviation, used only to build the username (sc/tt/pm/sa/db/at)
#   classToken - class name as it appears in the filename (e.g. Turtle_Tamer)
#   SignCap    - zodiac sign, filename casing (e.g. Wallaby)
#   signLower  - zodiac sign, lowercase, used in the username (e.g. wallaby)
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/common.sh"

abbr="$1"; classToken="$2"; signCap="$3"; signLower="$4"
user="${abbr}_${signLower}"

# Each account has its own password env var, PASSWORD_<USER> (e.g. PASSWORD_TT_WALLABY);
# set them all to the same value if the multis share a password.
pwvar="PASSWORD_$(to_upper "$user")"
password="${!pwvar:-}"
: "${password:?No password for $user — set $pwvar}"
: "${OUTPUT_DIR:?OUTPUT_DIR not set}"
: "${LOG_DIR:?LOG_DIR not set}"
: "${WORK_ROOT:?WORK_ROOT not set}"
: "${JAR:?JAR not set}"
: "${TIMEOUT:=1800}"
: "${TEMPLATE_DIR:=}"
# Resilience knobs for flaky KoL logins (intermittent HTTP connect timeouts):
: "${MAX_ATTEMPTS:=3}"     # login attempts before giving up on this permutation
: "${LOGIN_TIMEOUT:=180}"  # seconds to wait for derive to start before treating a login as stuck
: "${RETRY_BACKOFF:=15}"   # base seconds between attempts (multiplied by attempt number)
: "${COMPLETE_TOLERANCE:=150}"  # how close the last progress must reach the item total to count as complete

wd="$WORK_ROOT/$user"
log="$LOG_DIR/$user.log"
exitfile="$WORK_ROOT/.$user.exit"
mkdir -p "$OUTPUT_DIR" "$LOG_DIR" "$WORK_ROOT"
: > "$log"

# Log markers that mean "this attempt is doomed, but a retry might work" — network
# blips where KoLmafia's Java client can't reach KoL even though the box can.
TRANSIENT_RE='connect timed out|connection timed out|read timed out|IOException retrieving server reply|Connection reset|Unable to (establish|connect)'
# The account genuinely started deriving — login worked, don't kill it.
STARTED_RE='Deriving TCRS item adjustments for all real items|Progress: '

# A KoLmafia parallel derive bails out — but still prints "Done!" and saves a
# PARTIAL file — if any single item's description fetch errors (common when many
# derives hammer KoL at once). So file existence isn't enough: consider the
# real-items derive complete only if its last reported progress reached (near)
# the item total. Parses the current attempt, up to the first cafe-phase header.
derive_complete() {
  local items prog lastr tot
  items="$(current_attempt_block "$log" | awk '/Deriving TCRS item adjustments for all cafe/{exit} {print}')"
  prog="$(printf '%s' "$items" | last_progress)" || return 1
  read -r lastr tot <<< "$prog"
  [ "$lastr" -ge "$(( tot - COMPLETE_TOLERANCE ))" ]
}

seed_workdir() {
  rm -rf "$wd"
  mkdir -p "$wd"
  # Seed from the shared warm-up template so we don't re-download common data 54 times.
  if [ -n "$TEMPLATE_DIR" ] && [ -d "$TEMPLATE_DIR" ]; then
    cp -a "$TEMPLATE_DIR/." "$wd/" 2>/dev/null || true
    rm -rf "$wd/data" 2>/dev/null || true  # start with a clean data dir for this class/sign
  fi
}

# Launch one KoLmafia run in the background. Roots mafia at $wd via CWD so its
# data/ lands where we collect from. A completion sentinel ($exitfile) is written
# when the JVM exits — that, not `kill -0`, is our liveness signal, so it works
# without setsid/`wait -n` and correctly reflects a killed or finished process.
# The password is fed on stdin (a bash builtin), never as an argv `ps` could expose.
jpid=""
start_run() {
  rm -f "$exitfile"
  (
    cd "$wd" || exit 97
    # After username+password, login refreshes session data and (running headless)
    # asks up to two yes/no questions on stdin — "derive TCRS data?" for the real
    # and cafe files. Answer 'no' to both (we derive explicitly below); if a prompt
    # doesn't appear, the extra 'no' is just an unknown command mafia skips over.
    printf '%s\n' "$user" "$password" no no 'tcrs reset' 'tcrs derive' 'tcrs save' 'exit' \
      | "${MAFIA_JAVA[@]}" -jar "$JAR" --CLI
    echo "$?" > "$exitfile"
  ) >> "$log" 2>&1 &
  jpid=$!
  disown "$jpid" 2>/dev/null || true  # we manage its lifecycle; silence job-control "Terminated" notices
}
run_alive() { [ ! -f "$exitfile" ]; }
end_run() {
  if [ ! -f "$exitfile" ]; then
    kill_tree "$jpid" TERM
    for _ in 1 2 3; do [ -f "$exitfile" ] && break; sleep 1; done
    [ -f "$exitfile" ] || kill_tree "$jpid" KILL
  fi
  wait "$jpid" 2>/dev/null || true
}

# Never leave a JVM running if we're signalled or exit early (the JVM is disowned,
# so it would otherwise orphan when this script dies).
cleanup_run() { [ -n "${jpid:-}" ] && kill_tree "$jpid" KILL 2>/dev/null; }
trap 'cleanup_run; exit 130' INT TERM
trap cleanup_run EXIT

echo "[$user] starting (class=$classToken sign=$signCap)" >&2

copied=0
status=1
attempt=0
while [ "$attempt" -lt "$MAX_ATTEMPTS" ]; do
  attempt=$((attempt + 1))
  seed_workdir

  # Everything appended below this marker belongs to the current attempt; the
  # watchdog and the progress chart both scope their parsing to it.
  printf '=== attempt %d/%d ===\n' "$attempt" "$MAX_ATTEMPTS" >> "$log"
  offset=$(wc -c < "$log" 2>/dev/null || echo 0)
  this_attempt() { tail -c "+$((offset + 1))" "$log" 2>/dev/null; }

  start_run
  started=0
  transient=0
  begin=$(date +%s)
  while run_alive; do
    if this_attempt | grep -qE "$STARTED_RE"; then started=1; break; fi
    if this_attempt | grep -qiE "$TRANSIENT_RE"; then transient=1; break; fi
    if [ $(( $(date +%s) - begin )) -ge "$LOGIN_TIMEOUT" ]; then
      transient=1; break   # login never got as far as deriving — treat as a stuck login
    fi
    sleep 3
  done

  if [ "$started" -eq 1 ]; then
    # Login worked and deriving has begun; let it run to completion, bounded by
    # the overall per-account TIMEOUT.
    while run_alive; do
      [ $(( $(date +%s) - begin )) -ge "$TIMEOUT" ] && break
      sleep 5
    done
  fi
  end_run

  # Collect the three data files KoLmafia writes for this class/sign.
  copied=0
  while read -r name; do
    if [ -s "$wd/data/$name" ]; then
      cp "$wd/data/$name" "$OUTPUT_DIR/"
      copied=$((copied + 1))
    fi
  done < <(tcrs_files "$classToken" "$signCap")

  complete=0
  [ "$copied" -gt 0 ] && derive_complete && complete=1

  if [ "$copied" -eq 3 ] && [ "$complete" -eq 1 ]; then
    status=0
    break
  fi

  # Got files but the real-items derive bailed early -> partial data. Discard the
  # copies so RESUME won't skip this permutation, and treat it as retryable
  # (bails are load-induced and often succeed on a quieter retry).
  if [ "$copied" -gt 0 ] && [ "$complete" -eq 0 ]; then
    echo "[$user] real-items derive did not complete (bailed early) — discarding partial data" >&2
    while read -r name; do rm -f "$OUTPUT_DIR/$name"; done < <(tcrs_files "$classToken" "$signCap")
    copied=0
    transient=1
  fi

  # Retry transient problems (early bail, login timeout) while attempts remain;
  # a non-transient failure (e.g. account not in a TCRS run) won't self-fix.
  if [ "$transient" -eq 1 ] && [ "$attempt" -lt "$MAX_ATTEMPTS" ]; then
    echo "[$user] retrying after incomplete/failed attempt $attempt/$MAX_ATTEMPTS" >&2
    sleep $(( RETRY_BACKOFF * attempt ))
    continue
  fi
  break
done

# Reclaim disk: each working dir holds a full mafia data tree.
rm -rf "$wd" "$exitfile"

# Drop a completion sentinel so the orchestrator's progress chart can classify
# this task as OK/FAIL without racing the log: "<copied> <exit status>".
echo "$copied $status" > "$LOG_DIR/$user.done"

if [ "$copied" -eq 3 ]; then
  echo "[$user] OK (3/3 files, attempt $attempt/$MAX_ATTEMPTS)" >&2
  exit 0
fi

echo "[$user] FAILED ($copied/3 files after $attempt attempt(s)) — see $log" >&2
exit 1
