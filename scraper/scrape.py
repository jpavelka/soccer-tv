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

import requests
from bs4 import BeautifulSoup

BASE_URL = "https://www.livesoccertv.com/schedules/{}/"
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept-Language": "en-US,en;q=0.5",
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

        channels_td = row.find("td", id="channels")
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
        })

    return games


def main():
    today = datetime.datetime.now(tz=UTC).date()
    seen = set()
    all_games = []

    for i in range(7):
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
    main()
