#!/usr/bin/env python3
"""
Scrapes livesoccertv.com for US broadcast data and outputs static/broadcasts.json.
Uses Unix timestamps (dv attribute) for accurate matching with ESPN data.
Only includes channels marked with the homech CSS class (US-targeted channels).
"""
import datetime
import json
import sys
import time
from concurrent.futures import ThreadPoolExecutor

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.livesoccertv.com/schedules/{}/"
# ESPN's master league list. The order is ESPN's own prominence ranking
# (World Cup, Champions League, Premier League, ...), used to weight game interest.
LEAGUES_URL = "https://sports.core.api.espn.com/v2/sports/soccer/leagues?limit=1000"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.5",
    "Cookie": "u_continent=North%20America; u_country=United%20States; u_country_code=US; u_lang=en; u_locale=en_US; u_scores=on; u_state=New%20York; u_timezone=America%2FChicago",
}
UTC = datetime.timezone.utc


def scrape_day(date_str: str) -> list:
    url = BASE_URL.format(date_str)
    resp = requests.get(url, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    soup = BeautifulSoup(resp.text, "html.parser")

    games = []
    for row in soup.find_all("tr", id=True):
        match_td = row.find("td", id="match")
        if not match_td:
            continue
        title = match_td.find("a")
        if not title:
            continue

        # "Team A vs Team B" — livesoccertv uses plain "vs"
        parts = title.get_text(strip=True).split(" vs ")
        if len(parts) != 2:
            continue
        teams = [p.strip() for p in parts]

        ts_span = row.find("span", class_="ts")
        if not ts_span or not ts_span.get("dv"):
            continue
        timestamp_ms = int(ts_span["dv"])

        channels_td = row.find(id="channels")
        if not channels_td:
            continue
        seen = set()
        broadcasts = []
        for a in channels_td.find_all("a"):
            if "homech" not in a.get("class", []):
                continue
            name = a.get_text(strip=True)
            if name and name not in seen:
                seen.add(name)
                broadcasts.append(name)

        games.append({
            "teams": teams,
            "timestamp_ms": timestamp_ms,
            "date": datetime.datetime.fromtimestamp(timestamp_ms / 1000, tz=UTC).date().isoformat(),
            "broadcasts": broadcasts,
            # livesoccertv tags high-profile games with class="topmatch" on the match link.
            "topmatch": "topmatch" in (title.get("class") or []),
        })

    return games


def scrape_leagues() -> list:
    """Return ESPN's master league slugs in prominence order."""
    resp = requests.get(LEAGUES_URL, headers=HEADERS, timeout=30)
    resp.raise_for_status()
    data = resp.json()
    slugs = []
    for item in data.get("items", []):
        ref = item.get("$ref", "")
        slug = ref.split("/leagues/")[-1].split("?")[0]
        if slug:
            slugs.append(slug)
    return slugs


def resolve_league(slug: str):
    """Resolve a league slug to its numeric id and display name via the core API.
    Returns (id, name) or None on any failure (renamed/removed leagues are skipped)."""
    try:
        url = f"https://sports.core.api.espn.com/v2/sports/soccer/leagues/{slug}"
        resp = requests.get(url, headers=HEADERS, timeout=30)
        resp.raise_for_status()
        d = resp.json()
        lid, name = d.get("id"), d.get("name")
        if lid and name:
            return str(lid), name
    except Exception:
        pass
    return None


def write_league_order():
    """Refresh static/league_order.json: ESPN's ordered league slugs (for interest
    ranking) plus a numeric-id -> {slug, name} map. The /all/scoreboard endpoint
    only encodes a numeric league id per event, so the app uses `meta` to recover
    each league's slug and display name. Run on its own (weekly) schedule, not with
    the 8-hourly broadcast scrape -- resolving every league is slow and the data
    barely changes."""
    try:
        slugs = scrape_leagues()
    except Exception as e:
        print(f"  league order error: {e}", file=sys.stderr)
        return
    if not slugs:
        print("  league order: empty, leaving existing file", file=sys.stderr)
        return
    # Resolve id + name for each league concurrently; failures are skipped.
    meta = {}
    with ThreadPoolExecutor(max_workers=16) as ex:
        for slug, res in zip(slugs, ex.map(resolve_league, slugs)):
            if res:
                lid, name = res
                meta[lid] = {"slug": slug, "name": name}
    path = "static/league_order.json"
    with open(path, "w") as f:
        json.dump({
            "generated_at": datetime.datetime.now(UTC).isoformat(),
            "leagues": slugs,
            "meta": meta,
        }, f)
    print(f"Wrote {len(slugs)} leagues ({len(meta)} resolved) to {path}", file=sys.stderr)


def main():
    today = datetime.datetime.now(tz=UTC).date()
    seen = set()
    all_games = []

    for i in range(8):
        date_str = (today + datetime.timedelta(days=i)).isoformat()
        print(f"  {date_str}...", file=sys.stderr)
        try:
            games = scrape_day(date_str)
            for g in games:
                key = (g["timestamp_ms"], g["teams"][0], g["teams"][1])
                if key not in seen:
                    seen.add(key)
                    all_games.append(g)
            print(f"    {len(games)} games", file=sys.stderr)
        except Exception as e:
            print(f"    error: {e}", file=sys.stderr)
        if i < 6:
            time.sleep(1)

    output = {
        "generated_at": datetime.datetime.now(UTC).isoformat(),
        "games": all_games,
    }
    path = "static/broadcasts.json"
    with open(path, "w") as f:
        json.dump(output, f)
    print(f"Wrote {len(all_games)} games to {path}", file=sys.stderr)


if __name__ == "__main__":
    # `scrape.py leagues` refreshes only league_order.json (its own weekly job);
    # the default run scrapes broadcasts and leaves league_order.json untouched.
    if len(sys.argv) > 1 and sys.argv[1] == "leagues":
        write_league_order()
    else:
        main()
