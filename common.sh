#!/usr/bin/env bash
# Shared helpers for tcrs-derive, sourced by run-all.sh and run-one.sh. Keep this
# bash 3.2 compatible — macOS ships bash 3.2, so no associative arrays / ${x,,} here.

# How to launch KoLmafia's JVM. We run strictly headless: in --CLI mode mafia
# still asks yes/no questions (e.g. "derive TCRS data?" at login), and with a
# display available those become *modal Swing dialogs* that block forever with
# no one to click them. Headless makes KoLmafia read those answers from stdin
# instead (StaticEntity.isHeadless() -> InputFieldUtilities.confirm reads a line),
# so no framebuffer / xvfb is needed on any platform.
MAFIA_JAVA=(java -Djava.awt.headless=true -DuseCWDasROOT=true)

# The three data files KoLmafia writes per class/sign permutation.
TCRS_SUFFIXES=("" "_cafe_booze" "_cafe_food")

# Recursively signal a process and all its descendants. Portable stand-in for
# `setsid` process-group kills (macOS lacks setsid; pgrep/pkill exist on both).
kill_tree() {
  local pid="$1" sig="${2:-TERM}" k
  for k in $(pgrep -P "$pid" 2>/dev/null); do
    kill_tree "$k" "$sig"
  done
  kill "-$sig" "$pid" 2>/dev/null || true
}

# Case conversion without bash 4's ${x,,} / ${x^^}.
to_lower() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }
to_upper() { printf '%s' "$1" | tr '[:lower:]' '[:upper:]'; }

# Emit the three TCRS output basenames for a class/sign permutation, one per line.
# Single source of truth for the filename scheme the whole tool is built around.
tcrs_files() {  # <classToken> <signCap>
  local s
  for s in "${TCRS_SUFFIXES[@]}"; do printf 'TCRS_%s_%s%s.txt\n' "$1" "$2" "$s"; done
}

# Print only the current (last) attempt's slice of a run log, with the NULs
# KoLmafia sometimes writes stripped out (they make command substitution warn and
# disrupt the progress chart). run-one.sh writes a `=== attempt N/M ===` marker
# before each attempt; both the watchdog and the chart scope their parsing to it.
current_attempt_block() {  # <logfile>
  tr -d '\000' < "$1" 2>/dev/null \
    | awk '/^=== attempt [0-9]+\/[0-9]+ ===$/{buf=""; next} {buf=buf $0 ORS} END{printf "%s", buf}'
}

# From text on stdin, print "<done> <total>" for the last `Progress: r/total` line
# KoLmafia emitted; non-zero exit (no output) if there is no usable progress line.
last_progress() {
  local line r tot
  line="$(grep 'Progress: ' | tail -1)"
  [ -n "$line" ] || return 1
  line="${line##*Progress: }"; r="${line%%/*}"; tot="${line#*/}"; tot="${tot%%[!0-9]*}"
  [ -n "$r" ] && [ -n "$tot" ] && [ "$tot" -gt 0 ] 2>/dev/null || return 1
  printf '%s %s\n' "$r" "$tot"
}

# Download the latest published KoLmafia release jar to $1 (run-all.sh's fallback
# when no jar is supplied). Needs curl and jq on PATH.
download_latest_jar() {  # <dest>
  local dest="$1" url
  url="$(curl -fsSL https://api.github.com/repos/kolmafia/kolmafia/releases/latest \
        | jq -r '.assets[] | select(.name | endswith(".jar")) | .browser_download_url' | head -n1)"
  [ -n "$url" ] || { echo "Could not find a KoLmafia release jar." >&2; return 1; }
  echo "Downloading KoLmafia jar from $url" >&2
  curl -fsSL "$url" -o "$dest" && [ -s "$dest" ]
}
