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
https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=soccer&dates=YYYYMMDD&limit=999
```

### Broadcast supplementation

ESPN's broadcast data is incomplete (often missing Univision/TUDN and some NBC/CBS games). `scraper/scrape.py` fetches 7 days of schedules from livesoccertv.com and outputs `static/broadcasts.json`. The scraper runs every 8 hours via `.github/workflows/scrape-broadcasts.yml`, which also builds and deploys the site itself.

Matching in `DayGames.svelte` uses the `timestamp_ms` field (Unix ms from livesoccertv's `dv` attribute, accurate to the minute) plus at least one team name substring overlap. This is more reliable than name-only matching since multiple games can kick off at the same time.

livesoccertv marks high-profile games with `class="topmatch"` on the match link; these rows have no `matchrow` class on the `<tr>`. The scraper selects by `id=True` to catch both regular and featured rows.

### Global Football Rankings

`scraper/scrape_rankings.py` pulls power rankings from globalfootballrankings.com and writes one JSON file per dataset into `static/rankings/`: `{men,women}_league.json`, `{men,women}_team.json`, and `{men,women}_international.json` (the last two are the FIFA national-team rankings, which use a different schema with `points` + historical `pts_<date>` snapshot columns).

The site is client-rendered with no data in its HTML; it reads from a public **Supabase (PostgREST)** backend using an anon key shipped in its JS bundle. The scraper replicates those read-only queries directly (no headless browser). PostgREST caps responses at 1000 rows, so larger tables are paginated via the `Range` header. If it breaks, re-extract `SUPABASE_URL` / the anon key / table names from the bundle at `https://globalfootballrankings.com/assets/index-*.js`; the key is overridable via the `GFR_SUPABASE_ANON_KEY` env var.

The scraped `static/rankings/*.json` is **gitignored** — it's a high-frequency mirror of GFR's data, regenerated fresh at deploy time like `broadcasts.json`, never committed.

### ESPN ↔ GFR ID crosswalk

ESPN and GFR share no common key (ESPN has its own IDs; GFR carries API-Football IDs), so `scraper/build_crosswalk.py` matches them offline and freezes the result to IDs. It reads `static/rankings/*.json` (run `scrape_rankings.py` first) plus ESPN's API, and writes `static/crosswalk/{league_map,team_map}.json` and a human-facing `scraper/crosswalk_review.json` (unmatched / fuzzy / league-disagreement buckets).

Key design points:
- **Leagues** are matched by (gender, country, name); since the two sources name leagues very differently ("Primeira Liga" vs "Liga Portugal"), it falls back to **tier** — ESPN's `country.N` slug → the N-th best-rated GFR league in that country. `slug_tier` is strict so non-pyramid slugs (`usa.ncaa.m.1`, `*.promotion.relegation`) don't false-match. ESPN tournaments (UCL etc.) are skipped — no single country.
- **Teams** are matched within **country, not league**, so promotion/relegation and update-timing skew between the sources don't break matches. A confident name match whose leagues disagree is *flagged* (real pro/rel), not dropped. Reserve/youth sides (II, B, U23) are blocked from collapsing onto the senior team.
- **Identity is IDs only**: `team_map` stores `espn_id ↔ gfr api_football_id`; current league is read live, never baked in.
- **Incremental by default**: the committed maps are the source of truth. Each run loads them, re-applies overrides, and only auto-matches espn IDs *not already mapped* — settled matches (the IDs are stable) are never re-validated, so they can't regress, and a team absent from this week's rosters is kept rather than dropped. This also absorbs ESPN's run-to-run roster flakiness (its `/teams` endpoint intermittently returns partial lists). `build_crosswalk.py --rebuild` ignores the existing maps and re-derives from scratch (use sparingly — subject to that flakiness).
- **Only settled matches are persisted** (exact / token / tier / override). Fuzzy matches stay **provisional** — reported in `crosswalk_review.json` but never written to the map — until a human verifies one and promotes it to an override. So a low-confidence guess is never silently frozen.
- **`scraper/crosswalk_overrides.json`** holds hand-curated corrections (country aliases, forced league pairings, forced/blocked team pairings) applied *every* run, so corrections/blocks always take effect and the map is reproducible under `--rebuild`. To promote a verified fuzzy match, add its `espn_id → gfr api_football_id` here.

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
