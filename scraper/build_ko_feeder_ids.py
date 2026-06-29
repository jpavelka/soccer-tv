#!/usr/bin/env python3
"""
Generate a KO_FEEDER_IDS entry for src/lib/bracket.ts for one tournament.

Background (see CLAUDE.md / bracket.ts): ESPN pre-seeds every knockout fixture as
a scoreboard event whose undecided slots carry placeholder names like
"Round of 32 3 Winner". The trailing number is the slot's 1-based position within
its round given by ESPN's `matchNumber` -- which does NOT match the scoreboard's
event-id or date order, and lives only on the per-event core resource. Rather than
fetch it live (one call per knockout match), bracket.ts freezes the
matchNumber-ordered event-id lists in KO_FEEDER_IDS so feeder links resolve with
no extra calls. This script regenerates that frozen block for a given league slug.

What it does:
  1. Pull the league's full-tournament scoreboard (season window auto-derived,
     or pass --dates).
  2. Keep knockout events; fetch each one's `matchNumber` from the core API.
  3. For every round that placeholders actually feed from, emit its event ids in
     matchNumber order -- i.e. index i is "<Round> <i+1> Winner|Loser".
  4. Print a ready-to-paste block for KO_FEEDER_IDS, and sanity-check that every
     placeholder resolves.

Usage (from repo root):
  python scraper/build_ko_feeder_ids.py <league-slug> [--dates YYYYMMDD-YYYYMMDD]
  e.g. python scraper/build_ko_feeder_ids.py uefa.euro

Then paste the stdout block into KO_FEEDER_IDS in src/lib/bracket.ts.

Assumptions / limits (mirrors bracket.ts):
  * Single-match ties only. Two-legged knockouts (e.g. Champions League) model a
    tie as two events and are NOT supported by this single-match feeder scheme.
  * Placeholder wording must be "<Round> <N> Winner|Loser" and the round must be
    one of the slugs in FEEDER_SLUG. Any placeholder this can't parse is reported
    to stderr (group-stage ones like "Group A 2nd Place" are expected and benign);
    genuinely new wording means FEEDER_RE/FEEDER_SLUG here and in bracket.ts need
    a matching tweak.
  * A round is emitted only if EVERY match in it has a matchNumber, so a partial
    API response yields no (rather than wrong) links -- same rule as bracket.ts.
"""
import argparse
import concurrent.futures
import re
import sys
from collections import defaultdict

import requests

CORE = "https://sports.core.api.espn.com/v2/sports/soccer"
SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
MAX_WORKERS = 12

# Knockout round slugs (mirrors KO_RE/isKnockout in bracket.ts).
KO_RE = re.compile(
    r"round-of-\d+|quarter-?final|semi-?final|(^|[^a-z])final([^a-z]|$)"
    r"|3rd-place|third-place|knockout|playoff|last-\d+",
    re.I,
)

# Placeholder feeder names, e.g. "Round of 32 3 Winner" (mirrors bracket.ts).
FEEDER_RE = re.compile(r"^(round of \d+|quarterfinals?|semifinals?)\s+(\d+)\s+(winner|loser)$", re.I)
FEEDER_SLUG = {
    "round of 64": "round-of-64",
    "round of 32": "round-of-32",
    "round of 16": "round-of-16",
    "quarterfinal": "quarterfinals",
    "quarterfinals": "quarterfinals",
    "semifinal": "semifinals",
    "semifinals": "semifinals",
}


def is_knockout(slug: str | None) -> bool:
    return bool(slug) and slug != "group-stage" and bool(KO_RE.search(slug))


def fetch_json(url: str) -> dict:
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.json()


def ymd(iso: str) -> str:
    return iso[:10].replace("-", "")


def season_window(slug: str) -> str | None:
    """Derive a YYYYMMDD-YYYYMMDD window from the league's current season."""
    sb = fetch_json(f"{SITE}/{slug}/scoreboard")
    season = ((sb.get("leagues") or [{}])[0]).get("season") or {}
    start, end = season.get("startDate"), season.get("endDate")
    return f"{ymd(start)}-{ymd(end)}" if start and end else None


def fetch_match_numbers(slug: str, ids: list[str]) -> dict[str, int | None]:
    def one(eid: str):
        try:
            d = fetch_json(f"{CORE}/leagues/{slug}/events/{eid}/competitions/{eid}")
            mn = d.get("matchNumber")
            return eid, mn if isinstance(mn, int) else None
        except Exception:
            return eid, None

    out: dict[str, int | None] = {}
    with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as ex:
        for eid, mn in ex.map(one, ids):
            out[eid] = mn
    return out


def placeholders(ko_events: list[dict]):
    """Yield (round_slug, placeholder_name) for every undecided slot."""
    for e in ko_events:
        for c in (e["competitions"][0].get("competitors") or []):
            team = c.get("team") or {}
            if team.get("logo"):  # resolved team, not a placeholder
                continue
            yield e.get("season", {}).get("slug"), team.get("displayName", "")


def js_key(k: str) -> str:
    return k if re.fullmatch(r"[A-Za-z_$][\w$]*", k) else f"'{k}'"


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description="Generate a KO_FEEDER_IDS entry for bracket.ts.")
    ap.add_argument("slug", help="ESPN league slug, e.g. fifa.world, uefa.euro, concacaf.gold")
    ap.add_argument("--dates", help="YYYYMMDD-YYYYMMDD window; default: derive from the league season")
    args = ap.parse_args(argv)
    slug = args.slug

    window = args.dates or season_window(slug)
    if not window:
        print("error: could not derive a season window; pass --dates YYYYMMDD-YYYYMMDD", file=sys.stderr)
        return 1
    print(f"  league {slug}  window {window}", file=sys.stderr)

    sb = fetch_json(f"{SITE}/{slug}/scoreboard?dates={window}&limit=999")
    ko = [e for e in sb.get("events", []) if is_knockout(e.get("season", {}).get("slug")) and e.get("competitions")]
    if not ko:
        print("error: no knockout events found in that window", file=sys.stderr)
        return 1
    print(f"  {len(ko)} knockout events; fetching matchNumbers...", file=sys.stderr)

    mns = fetch_match_numbers(slug, [str(e["id"]) for e in ko])

    by_round: dict[str, list[dict]] = defaultdict(list)
    for e in ko:
        by_round[e["season"]["slug"]].append(e)

    # Only the rounds that placeholders actually feed from need an entry. Collect
    # them, and report any placeholder we can't parse so wording drift is visible.
    referenced: set[str] = set()
    unparsed: list[tuple[str, str]] = []
    for round_slug, name in placeholders(ko):
        m = FEEDER_RE.match(name.strip())
        if m:
            referenced.add(FEEDER_SLUG[m.group(1).lower()])
        else:
            unparsed.append((round_slug, name))

    # Build matchNumber-ordered id lists for each referenced round; sort the rounds
    # themselves by earliest matchNumber for readable output.
    emit: list[tuple[int, str, list[str]]] = []
    skipped, absent = [], []
    for round_slug in referenced:
        evs = by_round.get(round_slug)
        if not evs:
            absent.append(round_slug)
            continue
        if any(mns[str(e["id"])] is None for e in evs):
            skipped.append(round_slug)
            continue
        ordered = sorted(evs, key=lambda e: mns[str(e["id"])])
        emit.append((mns[str(ordered[0]["id"])], round_slug, [str(e["id"]) for e in ordered]))
    emit.sort()

    # --- ready-to-paste block (stdout) ---
    # Stamp the season year so bracket.ts only applies this entry to the matching
    # edition (slugs repeat across editions, e.g. fifa.world 2026 vs 2030).
    season_year = ((sb.get("leagues") or [{}])[0].get("season") or {}).get("year")
    if season_year is None:
        print("  WARNING: could not read season year; fill in 'season:' by hand", file=sys.stderr)
    out = [f"\t'{slug}': {{"]
    out.append(f"\t\tseason: {season_year if season_year is not None else 0},")
    out.append("\t\trounds: {")
    for _, round_slug, ids in emit:
        arr = ", ".join(f"'{i}'" for i in ids)
        out.append(f"\t\t\t{js_key(round_slug)}: [{arr}],")
    out.append("\t\t},")
    out.append("\t},")
    print("\n".join(out))

    # --- diagnostics (stderr) ---
    if skipped:
        print(f"  WARNING: rounds missing matchNumber (left unlinkable): {', '.join(sorted(skipped))}", file=sys.stderr)
    if absent:
        print(f"  WARNING: referenced rounds with no events in window: {', '.join(sorted(absent))}", file=sys.stderr)
    if unparsed:
        print(f"  note: {len(unparsed)} unparsed placeholder(s) (group-stage feeders are expected):", file=sys.stderr)
        for round_slug, name in sorted(set(unparsed)):
            print(f"      [{round_slug}] {name!r}", file=sys.stderr)

    # Sanity: every knockout placeholder should resolve against what we emit.
    table = {round_slug: ids for _, round_slug, ids in emit}
    resolved = unresolved = 0
    for _, name in placeholders(ko):
        m = FEEDER_RE.match(name.strip())
        if not m:
            continue
        ids = table.get(FEEDER_SLUG[m.group(1).lower()])
        ordinal = int(m.group(2))
        if ids and 1 <= ordinal <= len(ids):
            resolved += 1
        else:
            unresolved += 1
    print(f"  resolved {resolved} placeholder(s), {unresolved} unresolved", file=sys.stderr)
    if unresolved:
        print("  WARNING: some placeholders did not resolve — bracket links will be incomplete.", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
