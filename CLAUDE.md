# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
npm run dev        # Start dev server (Vite)
npm run build      # Build for production (outputs to build/)
npm run preview    # Preview production build locally
npm run check      # Type-check with svelte-check
```

No test suite is configured. Type checking via `npm run check` is the primary correctness tool.

## Architecture

**Soccer TV** is a SvelteKit static site that shows soccer schedules for the next 7 days. It uses `@sveltejs/adapter-static` and deploys to GitHub Pages at `/soccer-tv`.

### Data flow

`+page.ts` (load function) fires 7 parallel fetches to the ESPN scoreboard API — one per day — plus one fetch for `broadcasts.json`. It returns `{ days: { [dateString]: Promise<ESPNResponse> }, broadcasts: Promise<BroadcastData> }`. Both are kept as unresolved promises so each `DayGames` component can render independently via `{#await}` blocks, and broadcast data is merged in once both resolve.

The ESPN endpoint used:
```
https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=YYYYMMDD&limit=999&d=<ISO-timestamp>
```
The `/all` scoreboard returns a flat `events[]` list (standard site-API shape, with `competitions[].competitors[]`) and carries the venue address, goals/cards timeline, and inline per-team stats — so the match modal needs no separate per-game `summary?event=` fetch. `adaptEvent` in `+page.ts` normalizes each event back to the leaner `scoreboard/header` shape the rest of the app reads. The trailing `d=` is a cache-busting timestamp. (Note: inline `competitors[].statistics` is reliably populated for live games but frequently empty for finished lower-tier games; the `summary?event=` endpoint retains full stats postgame if ever needed.)

### Broadcast supplementation

ESPN's broadcast data is incomplete (often missing Univision/TUDN and some NBC/CBS games). `scraper/scrape.py` fetches 9 days of schedules from livesoccertv.com (UTC today-1 through today+7, mirroring `+page.ts`'s ESPN window so it covers the viewer's *local* today even when that lags UTC) and outputs `static/broadcasts.json`. The scraper runs every 8 hours via `.github/workflows/scrape-broadcasts.yml`, which also builds and deploys the site itself.

Matching in `DayGames.svelte` uses the `timestamp_ms` field (Unix ms from livesoccertv's `dv` attribute, accurate to the minute) plus at least one team name substring overlap. This is more reliable than name-only matching since multiple games can kick off at the same time.

livesoccertv marks high-profile games with `class="topmatch"` on the match link; these rows have no `matchrow` class on the `<tr>`. The scraper selects by `id=True` to catch both regular and featured rows.

### Global Football Rankings

`scraper/scrape_rankings.py` pulls power rankings from globalfootballrankings.com and writes one JSON file per dataset into `static/rankings/`: `{men,women}_league.json`, `{men,women}_team.json`, and `{men,women}_international.json` (the last two are the FIFA national-team rankings, which use a different schema with `points` + historical `pts_<date>` snapshot columns).

The site is client-rendered with no data in its HTML; it reads from a public **Supabase (PostgREST)** backend using an anon key shipped in its JS bundle. The scraper replicates those read-only queries directly (no headless browser). PostgREST caps responses at 1000 rows, so larger tables are paginated via the `Range` header. If it breaks, re-extract `SUPABASE_URL` / the anon key / table names from the bundle at `https://globalfootballrankings.com/assets/index-*.js`; the key is overridable via the `GFR_SUPABASE_ANON_KEY` env var.

The scraped `static/rankings/*.json` is **gitignored** — it's a high-frequency mirror of GFR's data, regenerated fresh at deploy time like `broadcasts.json`, never committed.

### ESPN ↔ GFR ID crosswalk

ESPN and GFR share no common key (ESPN has its own IDs; GFR carries API-Football IDs), so `scraper/build_crosswalk.py` matches them offline and freezes the result to IDs. It reads `static/rankings/*.json` (run `scrape_rankings.py` first) plus ESPN's API, and writes `static/crosswalk/{league_map,team_map,national_map}.json` and a human-facing `scraper/crosswalk_review.json` (new / fuzzy / unmatched / league-disagreement buckets).

Key design points:
- **Leagues** are matched by (gender, country, name); since the two sources name leagues very differently ("Primeira Liga" vs "Liga Portugal"), it falls back to **tier** — ESPN's `country.N` slug → the N-th best-rated GFR league in that country. `slug_tier` is strict so non-pyramid slugs (`usa.ncaa.m.1`, `*.promotion.relegation`) don't false-match. ESPN tournaments (UCL etc.) are skipped — no single country. Beware: ESPN's core league endpoint returns `country: null` for some domestic leagues (`usa.1`/MLS, `mex.1`, `ned.1`, `ksa.1`, …), which would silently drop them — and every team in them — from the crosswalk; `SLUG_COUNTRY` recovers the country from the FIFA-trigram slug prefix, and the affected leagues are also pinned in overrides.
- **Teams (clubs)** are matched within **country, not league**, so promotion/relegation and update-timing skew between the sources don't break matches. A confident name match whose leagues disagree is *flagged* (real pro/rel), not dropped. Reserve/youth sides (II, B, U23) are blocked from collapsing onto the senior team.
- **National teams** (`national_map.json`) map ESPN national-team IDs → the FIFA ranking tables (`{men,women}_international`). ESPN national-team IDs are harvested from senior international competitions (WC qualifiers + continental championships, per `NATIONAL_COMP_SLUGS`; youth/Olympic/club excluded) and matched by country name. Non-FIFA territories (Guadeloupe, Martinique, …) legitimately stay unmatched.
- **Identity is IDs only**: `team_map` stores `espn_id ↔ gfr api_football_id`; current league is read live, never baked in.
- **Incremental by default**: the committed maps are the source of truth. Each run loads them, re-applies overrides, and only auto-matches espn IDs *not already mapped* — settled matches (the IDs are stable) are never re-validated, so they can't regress, and a team absent from this week's rosters is kept rather than dropped. This also absorbs ESPN's run-to-run roster flakiness (its `/teams` endpoint intermittently returns partial lists). `build_crosswalk.py --rebuild` ignores the existing maps and re-derives from scratch (use sparingly — subject to that flakiness).
- **Only settled matches are persisted** (exact / token / tier / override). Fuzzy matches stay **provisional** — reported in `crosswalk_review.json` but never written to the map — until a human verifies one and promotes it to an override. So a low-confidence guess is never silently frozen.
- **`scraper/crosswalk_overrides.json`** holds hand-curated corrections (country aliases; forced league pairings; forced/blocked team and national pairings) applied *every* run, so corrections/blocks always take effect and the map is reproducible under `--rebuild`. To promote a verified fuzzy match, add its `espn_id → gfr api_football_id` here.

The app composes both crosswalks at load time (`+page.ts`): club ranks from `team_map` + `{men,women}_team`, and national ranks from `national_map` + the FIFA `{men,women}_international` tables, keyed by ESPN team id. The two rank scales aren't comparable, so entries carry an `intl` flag.

Unlike the rankings, the crosswalk output (`static/crosswalk/` and `scraper/crosswalk_review.json`) **is committed** — it changes slowly and its diffs are meaningful (a renamed club breaking a match is worth seeing in review). `.github/workflows/build-crosswalk.yml` scrapes rankings (as input only), rebuilds the crosswalk daily, and commits it back to its branch when it actually changes.

### Component hierarchy

```
+page.svelte          — global controls (show-completed toggle, filter-broadcasts toggle, broadcast selector modal)
  DayGames.svelte     — one section per day; resolves the Promise, filters events, groups by league
    Accordion.svelte  — collapsible section (used for both day headers and league headers)
    BcstSelect.svelte — checkbox list inside a Modal to pick preferred broadcast channels
  Modal.svelte        — fixed-position overlay, positions itself using windowInfo store
  ToggleButton.svelte — Yes/No pill toggle
```

### Svelte version notes

The codebase mixes Svelte 4 and Svelte 5 syntax:
- `+layout.svelte` and `DayGames.svelte` use Svelte 5 runes (`$props()`, `$state()`, `$effect()`)
- Older components (`Accordion`, `Modal`, `ToggleButton`, `BcstSelect`) still use Svelte 4 syntax (`export let`, `on:click`, `$:`)

When adding new components, prefer Svelte 5 runes style.

### Stores (`src/lib/stores.ts`)

| Store | Purpose |
|---|---|
| `goodBcsts` | User-selected broadcast networks; persisted to `localStorage` |
| `allBcsts` | All broadcast names seen so far (populated dynamically) |
| `filterBcsts` | Boolean — whether to filter games by `goodBcsts` |
| `goodStatuses` | Game statuses to show: `'pre'` (upcoming), `'in'` (live), optionally `'post'` (finished) |
| `windowInfo` | `{ screenWidth, gameContentWidth }` — drives responsive layout and modal positioning |
| `accordionShow` | Map of `dt` / `dt-leagueName` keys to boolean — persists expand/collapse state |

### Responsive layout

`DayGames` switches to abbreviated team names and narrower columns when `screenWidth < 550px`. The `windowInfo` store is set in `+page.svelte`'s `onMount` and updated on `visualViewport resize`.

### Build / deploy

`svelte.config.js` sets `base: "/soccer-tv"` in production, matching the GitHub Pages path. Two workflows handle deployment:

- `.github/workflows/github-pages-deploy.yml` — triggers on push to `main`; curls the current live `broadcasts.json` into `static/` before building so a code-only deploy doesn't lose scraped data
- `.github/workflows/scrape-broadcasts.yml` — runs every 8 hours; scrapes livesoccertv.com, builds, and deploys independently

Both use `JamesIves/github-pages-deploy-action` to push the `build/` folder to the `gh-pages` branch. The `build/` directory is **not** committed to `main`.
