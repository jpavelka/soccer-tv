#!/usr/bin/env python3
"""
Builds an ID crosswalk between ESPN and Global Football Rankings (GFR).

There is no shared key between the two systems (ESPN has its own team/league IDs;
GFR carries API-Football IDs), so we match on attributes offline, freeze the result
to IDs, and curate the residual by hand.

Design decisions (see CLAUDE.md):
  * Leagues matched by (gender, country, name); ESPN tournaments (UCL etc.) are
    skipped for team building since their league has no single country.
  * Teams matched within COUNTRY, not league, so promotion/relegation and update-
    timing skew between the sources don't break matches. League is only a signal:
    a confident name match whose leagues disagree is flagged, not dropped.
  * Identity is IDs only. team_map stores espn_id <-> gfr api_football_id; current
    league is read live from each source, never baked into the map.
  * INCREMENTAL by default: the committed maps are the source of truth. Each run
    loads them, re-applies overrides, and only auto-matches espn ids NOT already
    mapped. Settled matches are never re-validated (the IDs are stable), so they
    can't regress, and a team that's absent from this week's rosters is kept.
    `--rebuild` ignores the existing maps and re-derives everything from scratch.
  * The map holds only SETTLED matches (exact/token/tier/override). Fuzzy matches
    stay provisional — reported in the review file but never persisted — until a
    human promotes one to an override. So a low-confidence guess is never frozen.

Outputs:
  static/crosswalk/league_map.json  espn_slug    -> gfr league api_football_id
  static/crosswalk/team_map.json    espn_team_id -> gfr api_football_id
  scraper/crosswalk_review.json     dev report: new / fuzzy / unmatched / disagreements

Inputs: static/rankings/*.json (run scrape_rankings.py first) + the ESPN API.
Hand-curated overrides live in scraper/crosswalk_overrides.json and win over
auto-matching, so re-runs are deterministic and manual fixes are never lost.

Run from the repo root.  Usage: build_crosswalk.py [--rebuild]
"""
import concurrent.futures
import datetime
import difflib
import json
import os
import re
import sys
import unicodedata
from collections import defaultdict

import requests

ESPN_CORE = "https://sports.core.api.espn.com/v2/sports/soccer"
ESPN_SITE = "https://site.api.espn.com/apis/site/v2/sports/soccer"
UTC = datetime.timezone.utc
FUZZY_THRESHOLD = 0.84
MAX_WORKERS = 12

OVERRIDES_PATH = "scraper/crosswalk_overrides.json"
LEAGUE_MAP_PATH = "static/crosswalk/league_map.json"
TEAM_MAP_PATH = "static/crosswalk/team_map.json"
NATIONAL_MAP_PATH = "static/crosswalk/national_map.json"
REVIEW_PATH = "scraper/crosswalk_review.json"

# ESPN competitions whose rosters are SENIOR national teams, used to harvest the
# espn national-team ids that get matched to the FIFA ranking tables. WC qualifiers
# give the widest coverage (every nation enters); continental events fill gaps.
# Youth (u17/u20/u23), Olympic (U23), and club competitions are deliberately excluded.
NATIONAL_COMP_SLUGS = {
    "men": ["fifa.world", "fifa.worldq.uefa", "fifa.worldq.conmebol",
            "fifa.worldq.concacaf", "fifa.worldq.afc", "fifa.worldq.caf",
            "fifa.worldq.ofc", "uefa.nations", "uefa.euro", "uefa.euroq",
            "caf.nations", "caf.nations_qual", "afc.asian.cup", "concacaf.gold",
            "concacaf.gold_qual", "concacaf.nations.league", "conmebol.america",
            "fifa.friendly"],
    "women": ["fifa.wwc", "fifa.wworldq.uefa", "fifa.wwcq.ply", "uefa.weuro",
              "uefa.w.nations", "caf.w.nations", "concacaf.w.gold",
              "concacaf.womens.championship", "conmebol.america.femenina",
              "afc.w.asian.cup", "fifa.friendly.w"],
}

# Match kinds trusted enough to persist into the map. Fuzzy is deliberately
# excluded: it stays provisional (review-only) until a human promotes it to an
# override, so a low-confidence guess never gets silently frozen forever.
SETTLED_LEAGUE_KINDS = {"exact", "token", "tier"}
SETTLED_TEAM_KINDS = {"exact", "token"}

# Tokens stripped during team-name normalization (club-form noise, not identity).
TEAM_NOISE = {"fc", "cf", "afc", "sc", "cd", "ac", "as", "club", "de", "the",
              "vfb", "vfl", "tsg", "sv", "fk", "sk", "if", "bk", "ks", "rb",
              "calcio", "ssd", "us", "ud", "ca", "cs"}

# Canonical country names so ESPN's spelling lines up with GFR's. Keyed by the
# normalized (accent-stripped, lowercased) form; extendable via overrides.
DEFAULT_COUNTRY_ALIASES = {
    "turkey": "turkiye",
    "czech republic": "czechia",
    "korea republic": "south korea", "republic of korea": "south korea",
    "united arab emirates": "uae",
    "united states": "usa", "united states of america": "usa",
    "bosnia and herzegovina": "bosnia herzegovina",
    "bosnia-herzegovina": "bosnia herzegovina",
    "china pr": "china",
}

# ESPN's core league endpoint returns country: null for some domestic leagues
# (usa.1/MLS, mex.1, ned.1, ksa.1, ...), which would otherwise silently exclude
# them — and every team in them — from the crosswalk. Domestic slugs start with
# the FIFA trigram, so recover the country from it. Spelled the GFR way (the
# alias table normalizes either spelling). Covers the countries GFR ranks;
# non-country prefixes (fifa, uefa, club, ...) are absent on purpose — those
# leagues have no single country and are correctly skipped.
SLUG_COUNTRY = {
    "alg": "Algeria", "arg": "Argentina", "aus": "Australia", "aut": "Austria",
    "aze": "Azerbaijan", "bel": "Belgium", "bih": "Bosnia-Herzegovina",
    "bol": "Bolivia", "bra": "Brazil", "bul": "Bulgaria", "can": "Canada",
    "chi": "Chile", "chn": "China", "col": "Colombia", "crc": "Costa Rica",
    "cro": "Croatia", "cyp": "Cyprus", "cze": "Czechia", "den": "Denmark",
    "ecu": "Ecuador", "egy": "Egypt", "eng": "England", "esp": "Spain",
    "fin": "Finland", "fra": "France", "geo": "Georgia", "ger": "Germany",
    "gre": "Greece", "hon": "Honduras", "hun": "Hungary", "ind": "India",
    "irn": "Iran", "isl": "Iceland", "isr": "Israel", "ita": "Italy",
    "jpn": "Japan", "kor": "South Korea", "ksa": "Saudi Arabia", "lva": "Latvia",
    "mar": "Morocco", "mex": "Mexico", "ned": "Netherlands", "nor": "Norway",
    "par": "Paraguay", "per": "Peru", "pol": "Poland", "por": "Portugal",
    "qat": "Qatar", "rou": "Romania", "rsa": "South Africa", "rus": "Russia",
    "sco": "Scotland", "srb": "Serbia", "sui": "Switzerland", "svk": "Slovakia",
    "svn": "Slovenia", "swe": "Sweden", "tun": "Tunisia", "tur": "Turkiye",
    "uae": "UAE", "ukr": "Ukraine", "uru": "Uruguay", "usa": "USA",
    "ven": "Venezuela",
}


def fetch_json(url: str) -> dict:
    resp = requests.get(url, timeout=30)
    resp.raise_for_status()
    return resp.json()


# --- normalization ---------------------------------------------------------

def _strip_accents(s: str) -> str:
    return unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()


def norm_team(s: str) -> str:
    s = _strip_accents(s).lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    toks = [t for t in s.split() if t not in TEAM_NOISE and not t.isdigit()]
    return " ".join(toks).strip()


def norm_generic(s: str) -> str:
    s = _strip_accents(s).lower()
    s = re.sub(r"[^a-z0-9 ]", " ", s)
    return re.sub(r"\s+", " ", s).strip()


# --- GFR side (from our scraped files) -------------------------------------

def load_gfr():
    def rows(name):
        return json.load(open(f"static/rankings/{name}.json"))["rankings"]
    return {
        "men": {"teams": rows("men_team"), "leagues": rows("men_league"),
                "intl": rows("men_international")},
        "women": {"teams": rows("women_team"), "leagues": rows("women_league"),
                  "intl": rows("women_international")},
    }


# --- ESPN side -------------------------------------------------------------

def espn_league_slugs() -> list:
    data = fetch_json(f"{ESPN_CORE}/leagues?limit=1000")
    slugs = []
    for item in data.get("items", []):
        slug = item.get("$ref", "").split("/leagues/")[-1].split("?")[0]
        if slug:
            slugs.append(slug)
    return slugs


def espn_league_detail(slug: str) -> dict | None:
    try:
        d = fetch_json(f"{ESPN_CORE}/leagues/{slug}")
    except Exception:
        return None
    country = d.get("country")
    country = country.get("name") if isinstance(country, dict) else country
    slug = d.get("slug", slug)
    if not country:
        country = SLUG_COUNTRY.get(slug.split(".")[0])
    return {
        "slug": slug,
        "id": d.get("id"),
        "name": d.get("name", ""),
        "is_tournament": bool(d.get("isTournament")),
        "gender": {"MALE": "men", "FEMALE": "women"}.get(d.get("gender")),
        "country": country,
    }


def espn_all_leagues() -> list:
    slugs = espn_league_slugs()
    print(f"  fetching {len(slugs)} ESPN league details...", file=sys.stderr)
    out = []
    with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as ex:
        for d in ex.map(espn_league_detail, slugs):
            if d:
                out.append(d)
    return out


def espn_league_teams(slug: str) -> list:
    try:
        d = fetch_json(f"{ESPN_SITE}/{slug}/teams")
        teams = d["sports"][0]["leagues"][0]["teams"]
        return [(t["team"]["id"], t["team"]["displayName"]) for t in teams]
    except Exception:
        return []


# --- matching --------------------------------------------------------------

# Tokens that mark a distinct (reserve / youth) side. If two names differ only by
# one of these, they are NOT the same team — block the loose match that would
# otherwise collapse "Real Sociedad II" onto "Real Sociedad".
RESERVE_MARKERS = {"ii", "iii", "b", "reserve", "reserves",
                   "u19", "u20", "u21", "u23"}


def _reserve_conflict(a: set, b: set) -> bool:
    return bool((a ^ b) & RESERVE_MARKERS)


def best_match(name: str, candidates: list, norm_fn=norm_team):
    """candidates: list of dicts with a precomputed '_norm'. Returns (cand, kind, score)."""
    n = norm_fn(name)
    if not n:
        return None, "MISS", 0.0
    nt = set(n.split())
    # 1. exact normalized
    for c in candidates:
        if c["_norm"] == n:
            return c, "exact", 1.0
    # 2. token subset either direction; accept only if unambiguous
    subs = [c for c in candidates
            if c["_tokens"] and not _reserve_conflict(nt, c["_tokens"])
            and (c["_tokens"] <= nt or nt <= c["_tokens"])]
    if len(subs) == 1:
        return subs[0], "token", 0.95
    pool = subs if subs else candidates
    # 3. fuzzy fallback over the pool
    best, score = None, 0.0
    for c in pool:
        if _reserve_conflict(nt, c["_tokens"]):
            continue
        r = difflib.SequenceMatcher(None, n, c["_norm"]).ratio()
        if r > score:
            best, score = c, r
    if best and score >= FUZZY_THRESHOLD:
        return best, "fuzzy", round(score, 3)
    return None, "MISS", round(score, 3)


def country_key(s: str, aliases: dict) -> str:
    """Normalize a country name to a canonical key, applying aliases."""
    k = norm_generic(s or "")
    return aliases.get(k, k)


def slug_tier(slug: str) -> int | None:
    """Tier from a pyramid slug: country['.'gender]'.'N  (eng.1, fra.2, eng.w.1).

    Deliberately strict — slugs with extra segments (usa.ncaa.m.1, college soccer;
    por.1.promotion.relegation, playoffs) are NOT pyramid tiers and must not match.
    """
    m = re.fullmatch(r"[a-z0-9]+(?:\.[wm])?\.(\d+)", slug)
    return int(m.group(1)) if m else None


def load_map(path: str, list_key: str, id_key: str) -> dict:
    """Load a committed crosswalk file into {espn key (str): gfr_api_football_id}."""
    if not os.path.exists(path):
        return {}
    data = json.load(open(path))
    return {str(r[id_key]): r["gfr_api_football_id"] for r in data.get(list_key, [])}


def main(argv=None) -> int:
    argv = sys.argv[1:] if argv is None else argv
    rebuild = "--rebuild" in argv  # ignore existing maps; re-derive from scratch

    if not os.path.exists("static/rankings/men_team.json"):
        print("Missing static/rankings/*.json — run scrape_rankings.py first.",
              file=sys.stderr)
        return 1

    overrides = {}
    if os.path.exists(OVERRIDES_PATH):
        overrides = json.load(open(OVERRIDES_PATH))
    country_aliases = dict(DEFAULT_COUNTRY_ALIASES)
    country_aliases.update({norm_generic(k): norm_generic(v)
                            for k, v in overrides.get("country_aliases", {}).items()})
    league_overrides = {str(k): v for k, v in overrides.get("leagues", {}).items()}
    team_overrides = {str(k): v for k, v in overrides.get("teams", {}).items()}
    national_overrides = {str(k): v for k, v in overrides.get("national", {}).items()}

    gfr = load_gfr()
    generated_at = datetime.datetime.now(UTC).isoformat()

    # --- GFR indexes ---------------------------------------------------------
    gfr_league_idx = defaultdict(list)
    gfr_league_by_apifid = {}
    for gender in ("men", "women"):
        for lg in gfr[gender]["leagues"]:
            n = norm_generic(lg["league_name"])
            entry = {**lg, "_norm": n, "_tokens": set(n.split()), "gender": gender}
            gfr_league_idx[(gender, country_key(lg["country"], country_aliases))].append(entry)
            gfr_league_by_apifid[lg["api_football_id"]] = entry
    for cands in gfr_league_idx.values():  # tier order = GFR rank order
        cands.sort(key=lambda c: c["rank"])
    gfr_team_idx = defaultdict(list)
    for gender in ("men", "women"):
        for t in gfr[gender]["teams"]:
            gfr_team_idx[(gender, country_key(t["country"], country_aliases))].append({
                **t, "_norm": norm_team(t["team_name"]),
                "_tokens": set(norm_team(t["team_name"]).split()),
            })
    gfr_team_by_apifid = {t["api_football_id"]: t
                          for g in ("men", "women") for t in gfr[g]["teams"]}

    # --- load settled maps (espn key -> gfr api_football_id), apply overrides -
    # Overrides are re-applied every run so corrections/forced-matches/blocks
    # always take effect — even for teams not in any roster this run.
    league_map = {} if rebuild else load_map(LEAGUE_MAP_PATH, "leagues", "espn_slug")
    team_map = {} if rebuild else load_map(TEAM_MAP_PATH, "teams", "espn_id")
    blocked = set()
    league_blocked = set()
    for slug, fid in league_overrides.items():
        if fid is None:
            league_map.pop(slug, None)
            league_blocked.add(slug)
        else:
            league_map[slug] = fid
    for eid, fid in team_overrides.items():
        if fid is None:
            team_map.pop(eid, None)
            blocked.add(eid)
        else:
            team_map[eid] = fid

    espn_leagues = espn_all_leagues()

    # --- leagues: keep settled ones, auto-match only NEW slugs ---------------
    unmatched_leagues, fuzzy_leagues, new_leagues = [], [], []
    for el in espn_leagues:
        if el["is_tournament"] or not el["gender"] or not el["country"]:
            continue  # tournaments / unknown gender / multi-country: no country scope
        slug = el["slug"]
        if slug in league_map or slug in league_blocked:
            continue  # settled (persisted or override) — don't re-validate
        gender, ck = el["gender"], country_key(el["country"], country_aliases)
        cands = gfr_league_idx.get((gender, ck), [])
        cand, kind, _ = best_match(el["name"], cands, norm_generic) if cands else (None, "MISS", 0)
        if not cand:  # names diverge across sources; fall back to tier
            tier = slug_tier(slug)
            if tier and tier <= len(cands):
                cand, kind = cands[tier - 1], "tier"
        info = {"espn_slug": slug, "espn_name": el["name"],
                "country": el["country"], "gender": gender}
        if cand and kind in SETTLED_LEAGUE_KINDS:
            league_map[slug] = cand["api_football_id"]
            new_leagues.append({**info, "gfr_league_name": cand["league_name"], "match": kind})
        elif cand:  # fuzzy — provisional, not persisted
            fuzzy_leagues.append({**info, "gfr_league_name": cand["league_name"]})
        else:
            unmatched_leagues.append(info)

    # slug -> (gfr league, gender) for every mapped league, to scope team rosters.
    matched_for_teams = {}
    for slug, fid in league_map.items():
        cand = gfr_league_by_apifid.get(fid)
        if cand:
            matched_for_teams[slug] = (cand, cand["gender"])
    print(f"  leagues: {len(league_map)} mapped (+{len(new_leagues)} new), "
          f"{len(fuzzy_leagues)} provisional, {len(unmatched_leagues)} unmatched",
          file=sys.stderr)

    # --- teams: keep settled ones, auto-match only NEW ids -------------------
    slugs = list(matched_for_teams)
    rosters = {}
    with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as ex:
        for slug, teams in zip(slugs, ex.map(espn_league_teams, slugs)):
            rosters[slug] = teams

    unmatched_teams, fuzzy_teams, disagreements, new_teams = [], [], [], []
    seen = set()
    for slug, (gfr_league, gender) in matched_for_teams.items():
        ck = country_key(gfr_league["country"], country_aliases)
        cands = gfr_team_idx.get((gender, ck), [])
        for espn_id, espn_name in rosters.get(slug, []):
            eid = str(espn_id)
            if eid in seen or eid in blocked:
                continue
            seen.add(eid)
            if eid in team_map:
                fid = team_map[eid]  # settled — trust, don't re-match
            else:
                cand, kind, score = best_match(espn_name, cands)
                if not cand:
                    unmatched_teams.append({
                        "espn_id": eid, "espn_name": espn_name,
                        "country": gfr_league["country"], "gender": gender,
                        "espn_league_slug": slug, "best_score": score})
                    continue
                if kind not in SETTLED_TEAM_KINDS:  # fuzzy — provisional, NOT persisted
                    fuzzy_teams.append({
                        "espn_id": eid, "espn_name": espn_name,
                        "gfr_api_football_id": cand["api_football_id"],
                        "gfr_team_name": cand["team_name"],
                        "country": cand["country"], "score": score})
                    continue
                fid = cand["api_football_id"]
                team_map[eid] = fid
                new_teams.append({
                    "espn_id": eid, "espn_name": espn_name,
                    "gfr_api_football_id": fid, "gfr_team_name": cand["team_name"],
                    "match": kind})
            # league-disagreement (works for persisted + newly added): same team,
            # different league across the two sources — usually real promotion/relegation.
            gteam = gfr_team_by_apifid.get(fid)
            if gteam and gteam["league_name"] != gfr_league["league_name"]:
                disagreements.append({
                    "espn_id": eid, "espn_name": espn_name, "espn_league_slug": slug,
                    "expected_gfr_league": gfr_league["league_name"],
                    "actual_gfr_league": gteam["league_name"],
                    "gfr_team_name": gteam["team_name"]})

    print(f"  teams: {len(team_map)} mapped (+{len(new_teams)} new), "
          f"{len(fuzzy_teams)} provisional, {len(unmatched_teams)} unmatched, "
          f"{len(disagreements)} league-disagreements", file=sys.stderr)

    # --- national teams: ESPN national-team ids -> FIFA ranking api_football_id
    # Harvest senior national teams from the international competitions, then match
    # by country name (clean; uses the same aliases) to the FIFA ranking tables.
    fifa_idx = {g: {country_key(t["team_name"], country_aliases): t
                    for t in gfr[g]["intl"]} for g in ("men", "women")}
    national_map = {} if rebuild else load_map(NATIONAL_MAP_PATH, "teams", "espn_id")
    nat_blocked = set()
    for eid, fid in national_overrides.items():
        if fid is None:
            national_map.pop(eid, None)
            nat_blocked.add(eid)
        else:
            national_map[eid] = fid

    new_nationals, unmatched_nationals = [], []
    nat_seen = set()
    for gender in ("men", "women"):
        comp_slugs = NATIONAL_COMP_SLUGS[gender]
        harvest = {}  # espn_id -> name (deduped across this gender's competitions)
        with concurrent.futures.ThreadPoolExecutor(MAX_WORKERS) as ex:
            for teams in ex.map(espn_league_teams, comp_slugs):
                for tid, tname in teams:
                    harvest[str(tid)] = tname
        for eid, name in harvest.items():
            if eid in nat_seen or eid in nat_blocked or eid in national_map:
                continue
            nat_seen.add(eid)
            row = fifa_idx[gender].get(country_key(name, country_aliases))
            if row:
                national_map[eid] = row["api_football_id"]
                new_nationals.append({"espn_id": eid, "espn_name": name,
                                      "gfr_api_football_id": row["api_football_id"],
                                      "gfr_team_name": row["team_name"], "gender": gender})
            else:
                unmatched_nationals.append({"espn_id": eid, "espn_name": name,
                                            "gender": gender})
    print(f"  nationals: {len(national_map)} mapped (+{len(new_nationals)} new), "
          f"{len(unmatched_nationals)} unmatched", file=sys.stderr)

    # --- write (maps carry only join keys; detail lives in the review file) ---
    os.makedirs("static/crosswalk", exist_ok=True)
    leagues_out = [{"espn_slug": s, "gfr_api_football_id": f}
                   for s, f in sorted(league_map.items())]
    teams_out = [{"espn_id": e, "gfr_api_football_id": f}
                 for e, f in sorted(team_map.items(), key=lambda kv: int(kv[0]))]
    nationals_out = [{"espn_id": e, "gfr_api_football_id": f}
                     for e, f in sorted(national_map.items(), key=lambda kv: int(kv[0]))]
    with open(LEAGUE_MAP_PATH, "w") as f:
        json.dump({"generated_at": generated_at,
                   "count": len(leagues_out), "leagues": leagues_out}, f, indent=2)
    with open(TEAM_MAP_PATH, "w") as f:
        json.dump({"generated_at": generated_at,
                   "count": len(teams_out), "teams": teams_out}, f, indent=2)
    with open(NATIONAL_MAP_PATH, "w") as f:
        json.dump({"generated_at": generated_at,
                   "count": len(nationals_out), "teams": nationals_out}, f, indent=2)
    with open(REVIEW_PATH, "w") as f:
        json.dump({
            "generated_at": generated_at,
            "mode": "rebuild" if rebuild else "incremental",
            "new_leagues": new_leagues,
            "new_teams": new_teams,
            "new_nationals": new_nationals,
            "fuzzy_leagues": fuzzy_leagues,
            "fuzzy_teams": fuzzy_teams,
            "unmatched_leagues": unmatched_leagues,
            "unmatched_teams": unmatched_teams,
            "unmatched_nationals": unmatched_nationals,
            "league_disagreements": disagreements,
        }, f, indent=2)
    print(f"  wrote maps and {REVIEW_PATH} "
          f"({'rebuild' if rebuild else 'incremental'})", file=sys.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
