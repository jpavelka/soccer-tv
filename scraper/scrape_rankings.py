#!/usr/bin/env python3
"""
Scrapes Global Football Rankings (globalfootballrankings.com) and writes one JSON
file per dataset into static/rankings/.

The site is a client-rendered app whose HTML contains no data; it reads directly
from a public Supabase (PostgREST) backend using an anon key shipped in its JS
bundle. We replicate the same read-only queries here. PostgREST caps each response
at 1000 rows, so larger tables are paginated with the Range header.

If this ever breaks, re-extract SUPABASE_URL / SUPABASE_ANON_KEY and the table
names from the site's bundle (https://globalfootballrankings.com/assets/index-*.js).
"""
import datetime
import json
import os
import sys

import requests

SUPABASE_URL = "https://ifluudzbwomhiveydmbb.supabase.co"
# Public, read-only anon key — served to every visitor in the site's JS bundle.
# Override via env if it gets rotated.
SUPABASE_ANON_KEY = os.environ.get(
    "GFR_SUPABASE_ANON_KEY",
    "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9."
    "eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImlmbHV1ZHpid29taGl2ZXlkbWJiIiwicm9sZSI6"
    "ImFub24iLCJpYXQiOjE3NDkyNjY2MDIsImV4cCI6MjA2NDg0MjYwMn0."
    "iJLU5LH__iBdTvjkVr8mxyyA8sDh8WpoPtzrGwoHjvA",
)

# Output filename -> Supabase table. All ordered by rank ascending.
DATASETS = {
    "men_league": "men_league_rankings",
    "women_league": "women_league_rankings",
    "men_team": "men_team_rankings",
    "women_team": "women_team_rankings",
    "men_international": "fifa_men_rankings",
    "women_international": "fifa_women_rankings",
}

PAGE_SIZE = 1000  # PostgREST's max rows per response
UTC = datetime.timezone.utc
HEADERS = {
    "apikey": SUPABASE_ANON_KEY,
    "Authorization": f"Bearer {SUPABASE_ANON_KEY}",
    "Accept": "application/json",
}


def fetch_table(table: str) -> list:
    """Fetch every row of a table, ordered by rank, paging in PAGE_SIZE chunks."""
    url = f"{SUPABASE_URL}/rest/v1/{table}"
    params = {"select": "*", "order": "rank.asc"}
    rows = []
    start = 0
    while True:
        headers = {**HEADERS, "Range-Unit": "items",
                   "Range": f"{start}-{start + PAGE_SIZE - 1}"}
        resp = requests.get(url, params=params, headers=headers, timeout=30)
        resp.raise_for_status()
        batch = resp.json()
        rows.extend(batch)
        if len(batch) < PAGE_SIZE:
            break
        start += PAGE_SIZE
    return rows


def main() -> int:
    os.makedirs("static/rankings", exist_ok=True)
    generated_at = datetime.datetime.now(UTC).isoformat()
    failures = []

    for name, table in DATASETS.items():
        print(f"  {table}...", file=sys.stderr)
        try:
            rows = fetch_table(table)
        except Exception as e:
            print(f"    error: {e}", file=sys.stderr)
            failures.append(name)
            continue
        if not rows:
            # Don't clobber a good file with an empty result.
            print("    empty, leaving existing file", file=sys.stderr)
            failures.append(name)
            continue

        # source_updated_at: newest row update timestamp, i.e. when GFR last rescored.
        source_updated_at = max((r.get("updated_at") or "" for r in rows), default="")
        path = f"static/rankings/{name}.json"
        with open(path, "w") as f:
            json.dump({
                "generated_at": generated_at,
                "source": "globalfootballrankings.com",
                "table": table,
                "source_updated_at": source_updated_at,
                "count": len(rows),
                "rankings": rows,
            }, f)
        print(f"    wrote {len(rows)} rows to {path}", file=sys.stderr)

    if failures:
        print(f"Failed datasets: {', '.join(failures)}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())
