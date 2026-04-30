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
