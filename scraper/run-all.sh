#!/usr/bin/env bash
# Run the "backend" jobs from .github/workflows/ locally.
#
# The scheduled workflows (scrape-broadcasts, scrape-leagues, build-crosswalk)
# are thin wrappers around the scripts in this directory plus `npm run build`.
# This runs those same steps against the working tree, skipping the parts that
# only exist for CI: fetching state from gh-pages (your tree already has it) and
# the deploy/commit steps.
#
#   scraper/run-all.sh                     # rankings + broadcasts + build
#   scraper/run-all.sh all                 # everything, incl. leagues + crosswalk
#   scraper/run-all.sh crosswalk           # one task
#   scraper/run-all.sh rankings crosswalk  # several
#   scraper/run-all.sh crosswalk --rebuild # forward flags to build_crosswalk.py
#
# Tasks always run in dependency order regardless of the order given, since
# build_crosswalk.py reads static/rankings/ and the build reads everything.

set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$ROOT"

CROSSWALK_ARGS=()
REQUESTED=()

for arg in "$@"; do
  case "$arg" in
    rankings|broadcasts|leagues|crosswalk|build) REQUESTED+=("$arg") ;;
    all)     REQUESTED+=(rankings broadcasts leagues crosswalk build) ;;
    # Help must precede the --* catch-all or it gets forwarded to the crosswalk.
    -h|--help|help)
      echo "usage: scraper/run-all.sh [rankings|broadcasts|leagues|crosswalk|build|all ...] [--rebuild]"
      echo "       (no task) = rankings broadcasts build"
      exit 0 ;;
    --*)     CROSSWALK_ARGS+=("$arg") ;;  # e.g. --rebuild
    *)       echo "unknown task: $arg (try: rankings broadcasts leagues crosswalk build all)" >&2; exit 2 ;;
  esac
done

if [ ${#REQUESTED[@]} -eq 0 ]; then
  REQUESTED=(rankings broadcasts build)
fi

# No pipe into `grep -q` here: early exit + SIGPIPE under `set -o pipefail`
# makes that form unreliable (same trap build-crosswalk.yml calls out).
wants() {
  local t
  for t in "${REQUESTED[@]}"; do [ "$t" = "$1" ] && return 0; done
  return 1
}

# Prefer the checked-out venv; fall back to whatever python3 is on PATH.
if [ -x scraper/.venv/bin/python ]; then
  PY=scraper/.venv/bin/python
else
  PY=python3
fi
if ! "$PY" -c 'import requests, bs4, dateutil' 2>/dev/null; then
  echo "Missing Python deps for $PY. Install them with:" >&2
  echo "  $PY -m pip install -r scraper/requirements.txt" >&2
  exit 1
fi

step() {
  local label="$1"; shift
  echo
  echo "==> $label"
  local start=$SECONDS
  "$@"
  echo "    done in $((SECONDS - start))s"
}

# Canonical order: rankings feeds the crosswalk, and the build reads all of it.
if wants rankings; then
  step "GFR rankings -> static/rankings/" "$PY" scraper/scrape_rankings.py
fi

if wants broadcasts; then
  step "livesoccertv -> static/broadcasts.json" "$PY" scraper/scrape.py
fi

if wants leagues; then
  step "ESPN leagues -> static/league_order.json" "$PY" scraper/scrape.py leagues
fi

if wants crosswalk; then
  if [ ! -f static/rankings/men_league.json ]; then
    echo "static/rankings/ is missing — run 'scraper/run-all.sh rankings crosswalk' first." >&2
    exit 1
  fi
  case " ${CROSSWALK_ARGS[*]-} " in
    *" --rebuild "*)
      # --rebuild ignores the committed maps and re-derives from scratch, so it
      # inherits whatever ESPN's flaky /teams endpoint returns today — a normal
      # run drops real mappings. Check the diff before you keep it.
      echo "warning: --rebuild discards the committed maps; expect churn from ESPN roster flakiness." >&2 ;;
  esac
  step "ESPN<->GFR crosswalk -> static/crosswalk/" \
    "$PY" scraper/build_crosswalk.py ${CROSSWALK_ARGS[@]+"${CROSSWALK_ARGS[@]}"}
  echo
  echo "    Crosswalk output is committed — review it before staging:"
  echo "      git diff --stat static/crosswalk scraper/crosswalk_review.json"
fi

if wants build; then
  if [ ! -d node_modules ]; then
    step "npm install" npm install
  fi
  step "vite build -> build/" npm run build
  echo
  echo "    Preview the built site with: npm run preview"
fi
