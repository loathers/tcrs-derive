#!/usr/bin/env bash
# Orchestrate TCRS derivation across every class x sign permutation.
# Runs each permutation as its own isolated KoLmafia JVM, in parallel, and
# collects all resulting TCRS_*.txt files into $OUTPUT_DIR.
set -uo pipefail

here="$(cd "$(dirname "$0")" && pwd)"
. "$here/common.sh"
RUN_ONE="$here/run-one.sh"

: "${CONCURRENCY:=4}"
# OUTPUT_DIR holds only the derived data files; LOG_DIR holds the per-account logs
# and completion sentinels, kept separate so OUTPUT_DIR stays a clean data folder.
: "${OUTPUT_DIR:=$here/out}"
: "${LOG_DIR:=$here/logs}"
: "${WORK_ROOT:=${TMPDIR:-/tmp}/tcrs-work}"
: "${TIMEOUT:=1800}"
: "${ONLY:=}"      # optional comma-separated allow-list, e.g. ONLY=tt_wallaby
: "${EXCLUDE:=}"   # optional comma-separated skip-list, e.g. EXCLUDE=sa_blender

# Resolve the KoLmafia jar: explicit $JAR, else a jar sitting next to these
# scripts, else download the latest release.
if [ -z "${JAR:-}" ]; then
  for cand in "$here"/KoLmafia*.jar "$here"/kolmafia*.jar; do
    [ -f "$cand" ] && { JAR="$cand"; break; }
  done
fi
if [ -z "${JAR:-}" ]; then
  JAR="$here/KoLmafia.jar"
  echo "No KoLmafia jar found; downloading the latest release..." >&2
  download_latest_jar "$JAR" || {
    echo "Could not download a jar — set JAR=/path/to/KoLmafia.jar and re-run." >&2; exit 1; }
fi
[ -s "$JAR" ] || { echo "JAR '$JAR' not found or empty." >&2; exit 1; }

export OUTPUT_DIR LOG_DIR WORK_ROOT JAR TIMEOUT

mkdir -p "$OUTPUT_DIR" "$LOG_DIR" "$WORK_ROOT"

# Single-instance guard: refuse to start if another batch is already running
# against this WORK_ROOT (concurrent runs oversubscribe KoL and corrupt output).
LOCK="$WORK_ROOT/.run-all.lock"
if [ -f "$LOCK" ] && kill -0 "$(cat "$LOCK" 2>/dev/null)" 2>/dev/null; then
  echo "Another run-all.sh is already running (pid $(cat "$LOCK"))." >&2
  echo "Stop it first, or set a different WORK_ROOT to run a separate batch." >&2
  exit 1
fi
echo $$ > "$LOCK"
# Release the lock (and restore the cursor if we hid it) on any exit.
trap 'rm -f "$LOCK" 2>/dev/null; [ -t 2 ] && printf "\033[?25h" >&2' EXIT

# Clear stale sentinels AND logs from a previous run, so the progress chart shows
# not-yet-started tasks as "queued" instead of replaying old per-account output.
rm -f "$LOG_DIR"/*.done "$LOG_DIR"/*.log

# Class abbreviation -> class name as it appears in the TCRS filename.
# (A function, not an associative array, so this runs under bash 3.2 / macOS.)
class_token() {
  case "$1" in
    sc) echo Seal_Clubber ;;   tt) echo Turtle_Tamer ;;    pm) echo Pastamancer ;;
    sa) echo Sauceror ;;       db) echo Disco_Bandit ;;    at) echo Accordion_Thief ;;
  esac
}
CLASS_ORDER=(sc tt pm sa db at)
SIGNS=(Mongoose Wallaby Vole Platypus Opossum Marmot Wombat Blender Packrat)

# --- Warm-up: populate a shared data template once (best effort) --------------
# An empty first line makes attemptLogin bail ("Invalid login") without consuming
# the `exit` line, which then cleanly quits the JVM.
TEMPLATE_DIR="$WORK_ROOT/.template"
rm -rf "$TEMPLATE_DIR"; mkdir -p "$TEMPLATE_DIR"
echo "Warming up shared data files..." >&2
( cd "$TEMPLATE_DIR" && printf '%s\n' '' 'exit' | "${MAFIA_JAVA[@]}" -jar "$JAR" --CLI \
    > "$LOG_DIR/_warmup.log" 2>&1 ) &
warm_pid=$!
( sleep 300; kill_tree "$warm_pid" KILL 2>/dev/null ) & warm_killer=$!
if wait "$warm_pid" 2>/dev/null; then
  echo "Warm-up complete." >&2
else
  echo "Warm-up skipped/failed (continuing without a template)." >&2
  TEMPLATE_DIR=""
fi
kill_tree "$warm_killer" KILL 2>/dev/null; wait "$warm_killer" 2>/dev/null || true
export TEMPLATE_DIR

# --- Build the permutation list (respecting the optional ONLY filter) ---------
want_user() {  # 0 if $1 should run, honoring EXCLUDE (skip-list) then ONLY (allow-list)
  case ",$EXCLUDE," in *",$1,"*) return 1 ;; esac
  [ -z "$ONLY" ] && return 0
  case ",$ONLY," in *",$1,"*) return 0 ;; *) return 1 ;; esac
}

# With RESUME=1, skip permutations whose 3 output files already exist — useful to
# pick up where an interrupted run left off without re-deriving completed ones.
already_done() {  # $1=classToken $2=signCap
  [ "${RESUME:-}" = 1 ] || return 1
  local name
  while read -r name; do [ -s "$OUTPUT_DIR/$name" ] || return 1; done < <(tcrs_files "$1" "$2")
  return 0
}

tasks=()
skipped=0
for abbr in "${CLASS_ORDER[@]}"; do
  classToken="$(class_token "$abbr")"
  for signCap in "${SIGNS[@]}"; do
    signLower="$(to_lower "$signCap")"
    user="${abbr}_${signLower}"
    want_user "$user" || continue
    if already_done "$classToken" "$signCap"; then skipped=$((skipped + 1)); continue; fi
    tasks+=("$abbr $classToken $signCap $signLower")
  done
done
[ "$skipped" -gt 0 ] && echo "Resuming: skipping $skipped already-complete permutation(s)." >&2

if [ "${#tasks[@]}" -eq 0 ]; then
  echo "Nothing to do — 0 permutations to run." >&2
  exit 0
fi

echo "Running ${#tasks[@]} permutation(s) with concurrency $CONCURRENCY..." >&2

# --- Live progress chart ------------------------------------------------------
# Render one bar per permutation, parsed from each account's log:
#   queued  - no log yet
#   running - log present, no .done sentinel; phase + %% from `Progress: r/t`
#   done    - .done sentinel with 3/3 files
#   FAIL    - .done sentinel with <3 files
BAR_WIDTH=10

make_bar() {  # <pct> <fill-char>
  local pct="$1" fill="$2" i filled bar=""
  filled=$(( pct * BAR_WIDTH / 100 ))
  (( filled > BAR_WIDTH )) && filled=$BAR_WIDTH
  (( filled < 0 )) && filled=0
  for ((i = 0; i < filled; i++)); do bar+="$fill"; done
  for ((i = filled; i < BAR_WIDTH; i++)); do bar+="░"; done
  printf '%s' "$bar"
}

# Compute the current state of every task into ROWS[] (one formatted line each),
# RUNROWS[] (just the running ones), and SUMMARY. emit_frame then prints either
# the full table or a compact view depending on terminal height.
ROWS=(); RUNROWS=(); SUMMARY=""
compute_states() {
  ROWS=(); RUNROWS=()
  local done_n=0 running=0 failed=0 queued=0
  local t abbr classToken signCap signLower user log donef
  local pct label bar status_txt copied st phase_line prog r total
  local block an am try line
  for t in "${tasks[@]}"; do
    read -r abbr classToken signCap signLower <<< "$t"
    user="${abbr}_${signLower}"
    log="$LOG_DIR/$user.log"
    donef="$LOG_DIR/$user.done"
    local is_running=0
    if [ -f "$donef" ]; then
      read -r copied st < "$donef"
      if [ "${copied:-0}" -eq 3 ]; then
        bar="$(make_bar 100 █)"; status_txt="done"; done_n=$((done_n + 1))
      else
        bar="$(make_bar 100 ▓)"; status_txt="FAIL ${copied:-0}/3"; failed=$((failed + 1))
      fi
    elif [ -f "$log" ]; then
      running=$((running + 1)); is_running=1
      # Scope parsing to the current (last) attempt so a retry doesn't show the
      # previous attempt's stale phase/percent.
      block="$(current_attempt_block "$log")"
      phase_line="$(printf '%s' "$block" | grep -E 'Deriving TCRS item adjustments for all (real|cafe booze|cafe food) items' | tail -1)"
      case "$phase_line" in
        *"cafe food"*)  label="food"  ;;
        *"cafe booze"*) label="booze" ;;
        *"real items"*) label="items" ;;
        *) if printf '%s' "$block" | grep -qiE 'timed out|IOException retrieving server reply|Connection reset'; then
             label="stalled"
           else
             label="login"
           fi ;;
      esac
      pct=0
      if prog="$(printf '%s' "$block" | last_progress)"; then
        read -r r total <<< "$prog"; pct=$(( r * 100 / total ))
      fi
      try=""
      am="$(tr -d '\000' < "$log" 2>/dev/null | grep -oE 'attempt [0-9]+/[0-9]+' | tail -1)"
      if [ -n "$am" ]; then
        an="${am#attempt }"; if [ "${an%%/*}" -gt 1 ] 2>/dev/null; then try=" try ${an}"; fi
      fi
      # The items phase is the bulk and its %% is meaningful (caps ~99% because
      # KoLmafia only announces every 100 items). The cafe phases emit no progress,
      # so show a full bar labelled with the phase instead of a stale items %%.
      case "$label" in
        items)        bar="$(make_bar "$pct" █)"; status_txt="$(printf '%3d%% items%s' "$pct" "$try")" ;;
        booze|food)   bar="$(make_bar 100 █)";    status_txt="$(printf 'cafe %s%s' "$label" "$try")" ;;
        *)            bar="$(make_bar "$pct" █)";  status_txt="$(printf '%s%s' "$label" "$try")" ;;
      esac
    else
      bar="$(make_bar 0 ░)"; status_txt="queued"; queued=$((queued + 1))
    fi
    line="$(printf '%-12s [%s] %s' "$user" "$bar" "$status_txt")"
    ROWS+=("$line")
    [ "$is_running" -eq 1 ] && RUNROWS+=("$line")
  done
  SUMMARY="$(printf 'Overall: %d/%d done  (%d running, %d failed, %d queued)' \
    "$done_n" "${#tasks[@]}" "$running" "$failed" "$queued")"
}

# Print exactly $frame_lines lines (stable height, so the in-place redraw never
# scrolls). Full table when it fits; otherwise summary + as many running rows as
# fit, padded to a constant height.
emit_frame() {
  compute_states
  local i shown n
  if [ "$view" = "full" ]; then
    # ${arr[@]+"${arr[@]}"} avoids bash 3.2's "unbound variable" on an empty array under set -u.
    for i in ${ROWS[@]+"${ROWS[@]}"}; do printf '%s\033[K\n' "$i"; done
    printf '%s\033[K\n' "$SUMMARY"
  else
    printf '%s  [running only]\033[K\n' "$SUMMARY"
    n=$(( frame_lines - 1 )); shown=0
    for i in ${RUNROWS[@]+"${RUNROWS[@]}"}; do
      [ "$shown" -ge "$n" ] && break
      printf '%s\033[K\n' "$i"; shown=$((shown + 1))
    done
    while [ "$shown" -lt "$n" ]; do printf '\033[K\n'; shown=$((shown + 1)); done
  fi
}

# Interactive terminal + not explicitly disabled -> draw the live chart.
chart=0
if [ -t 2 ] && [ "${NO_PROGRESS:-}" != 1 ]; then chart=1; fi

# Each task line is 4 space-separated tokens (none contain spaces); xargs -L1
# passes them as the four positional args to run-one.sh.
fan_pid=""
# Ctrl-C / TERM: tear down the whole fan-out (xargs -> run-one -> java), restore
# the cursor, and exit — otherwise the trap would just redraw and the run would
# look uninterruptible.
stop_all() {
  trap - INT TERM
  printf '\033[?25h' >&2
  echo >&2; echo "Interrupted — stopping all permutations..." >&2
  [ -n "$fan_pid" ] && { kill_tree "$fan_pid" TERM; sleep 1; kill_tree "$fan_pid" KILL; }
  exit 130
}
trap stop_all INT TERM

if [ "$chart" -eq 1 ]; then
  # Choose full table vs compact view based on the terminal height, and fix the
  # frame at a constant number of lines so the cursor-up redraw never scrolls.
  term_rows="$(tput lines 2>/dev/null)"; case "$term_rows" in ''|*[!0-9]*) term_rows=24 ;; esac
  needed=$(( ${#tasks[@]} + 1 ))
  cap=$(( term_rows - 1 )); [ "$cap" -lt 3 ] && cap=3
  if [ "$needed" -le "$cap" ]; then view="full"; frame_lines=$needed
  else view="compact"; frame_lines=$cap; fi

  # Run the fan-out in the background; divert its diagnostics so they don't
  # corrupt the chart (the per-account logs still hold everything).
  ( printf '%s\n' "${tasks[@]}" | xargs -P "$CONCURRENCY" -L1 "$RUN_ONE" ) \
    2> "$LOG_DIR/_run.log" &
  fan_pid=$!

  printf '\033[?25l' >&2                                   # hide cursor (restored by the EXIT trap)
  emit_frame >&2                                            # first frame
  while kill -0 "$fan_pid" 2>/dev/null; do
    sleep 1.5
    printf '\033[%dA' "$frame_lines" >&2                    # cursor to top of chart
    emit_frame >&2
  done
  printf '\033[%dA' "$frame_lines" >&2
  emit_frame >&2                                            # final frame
  printf '\033[?25h' >&2                                    # show cursor
  wait "$fan_pid"
else
  ( printf '%s\n' "${tasks[@]}" | xargs -P "$CONCURRENCY" -L1 "$RUN_ONE" ) &
  fan_pid=$!
  wait "$fan_pid"
fi
trap - INT TERM

# --- Summary ------------------------------------------------------------------
echo >&2
echo "==================== SUMMARY ====================" >&2
ok=0; bad=0
for t in "${tasks[@]}"; do
  read -r abbr classToken signCap signLower <<< "$t"
  user="${abbr}_${signLower}"
  have=0
  while read -r name; do
    [ -s "$OUTPUT_DIR/$name" ] && have=$((have + 1))
  done < <(tcrs_files "$classToken" "$signCap")
  if [ "$have" -eq 3 ]; then
    printf '  OK    %-16s (%s / %s)\n' "$user" "$classToken" "$signCap" >&2
    ok=$((ok + 1))
  else
    printf '  FAIL  %-16s %d/3 files — see %s/%s.log\n' "$user" "$have" "$LOG_DIR" "$user" >&2
    bad=$((bad + 1))
  fi
done
echo "-------------------------------------------------" >&2
echo "  $ok ok, $bad failed, ${#tasks[@]} total" >&2
echo "  output: $OUTPUT_DIR" >&2
echo "  logs:   $LOG_DIR" >&2
echo "=================================================" >&2

[ "$bad" -eq 0 ]
