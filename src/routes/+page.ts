import type { PageLoad } from './$types';
import { base } from '$app/paths';
import { adaptEvent } from '$lib/espnEvent';

const getDateGames = (dt: string) => {
	// The /all scoreboard carries the venue address, goals/cards timeline, and
	// per-team stats inline (unlike the lean header endpoint), so the match modal
	// needs no per-game summary fetch. Its events are a flat list in the standard
	// site-API shape; `adaptEvent` normalizes each one back to the header shape the
	// rest of the app reads.
	const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/all/scoreboard?dates=${dt.replaceAll('-', '')}&limit=999&d=${(new Date()).toISOString()}`;
	// Node's fetch (undici) sends no User-Agent by default; ESPN's Akamai bot
	// protection blocks that and returns an HTML "Access Denied" page instead
	// of JSON. Only bites during SSR (e.g. `npm run dev`'s first render) since
	// this is otherwise a client-rendered SPA and browsers always send a UA.
	// Oddly, a browser-style UA is *also* blocked (mismatched fingerprint vs.
	// Node's TLS/HTTP2 stack) — a curl-style UA is what Akamai lets through.
	return fetch(url, { headers: { 'User-Agent': 'curl/8.7.1' } }).then(res => res.json());
}

const dateNDaysFromNow = (n: number) => {
	const tzoffset = (new Date()).getTimezoneOffset() * 60000;
	return new Date(new Date(Date.now() - tzoffset).setDate(new Date().getDate() + n)).toISOString().slice(0, 10);
}

// The local (browser-timezone) calendar date a kickoff falls on, YYYY-MM-DD.
// getFullYear/getMonth/getDate read local-time components.
const localDate = (iso: string) => {
	const d = new Date(iso);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// --- /all scoreboard -> header-shape adapter --------------------------------
// /all encodes only a numeric league id per event (in the uid, `s:600~l:700~e:`);
// the slug + display name come from league_order.json's `meta` map.
const LEAGUE_ID_RE = /~l:(\d+)~/;
const leagueIdOf = (uid: string | undefined): string | null => {
	const m = LEAGUE_ID_RE.exec(uid ?? '');
	return m ? m[1] : null;
};

// `adaptEvent` (the /all event -> header-shape adapter) lives in $lib/espnEvent
// so the bracket can reuse it to open the same match modal.

// --- alternate (GFR league rating) competition boost ------------------------
// A domestic cup has no GFR league rating of its own, so it inherits its country's
// top flight discounted by CUP_FALLOFF per position between the two in ESPN's
// order (see `leagueAlt` below). Two slug classes must be kept out of that:
// Same-country slugs that aren't competitive fixtures — preseason friendlies and
// college soccer — which would otherwise land near a real domestic cup
// (esp.joan_gamper 20.7, jpn.world_challenge 15.5, usa.ncaa.m.1 10.2).
const ALT_BLOCK = new Set(['esp.joan_gamper', 'jpn.world_challenge', 'usa.ncaa.m.1', 'usa.ncaa.w.1']);
// Pyramid tiers (eng.1, fra.2, eng.w.1) — mirrors build_crosswalk.py's `slug_tier`.
// A second/third tier missing from league_map is a *league*, not a cup: it should
// get a crosswalk override carrying its own real rating, not a guess derived from
// the country's top flight. (mex.2 is even explicitly blocked in
// crosswalk_overrides.json, which the falloff would silently override.)
const TIER_SLUG = /^[a-z0-9]+(?:\.[wm])?\.\d+$/;
const CUP_FALLOFF = 0.1;

export const load: PageLoad = async ({ fetch }) => {
	// Yesterday is bucketed and sent down too, but DayGames only renders it while
	// it still has a live game (e.g. a late-night kickoff that ran past local
	// midnight) — see `hideIfNoLive` in +page.svelte / DayGames.svelte.
	const yesterdayDt = dateNDaysFromNow(-1);
	// The 7 local days we display, plus yesterday (conditionally shown).
	const displayDts: string[] = [yesterdayDt];
	for (let i = 0; i <= 6; i++) displayDts.push(dateNDaysFromNow(i));

	// ESPN buckets games by US Eastern date, so a kickoff can land on a different
	// day than the viewer's local one (e.g. an 11pm Central game shows up under
	// the next Eastern date). Fetch one extra ESPN day on each side of the window
	// and re-bucket every event by its local kickoff date below.
	const fetchDts: string[] = [];
	for (let i = -1; i <= 7; i++) fetchDts.push(dateNDaysFromNow(i));
	const fetches = fetchDts.map(getDateGames);

	// league_order.json carries both ESPN's prominence-ordered slug list and a
	// numeric-id -> { slug, name } map. The slug list drives the interest rank
	// (leagueOrder); the map (leagueMeta) resolves each /all event's league.
	const leagueOrderData = fetch(`${base}/league_order.json?d=${new Date().toISOString()}`)
		.then(res => res.json())
		.catch(() => ({}));
	const leagueOrder = leagueOrderData.then((d: any) => {
		const rank: Record<string, number> = {};
		(d.leagues ?? []).forEach((slug: string, i: number) => { rank[slug] = i; });
		return rank;
	});
	const leagueMeta = leagueOrderData.then((d: any) => d.meta ?? {});

	// Resolve every ESPN day, then redistribute events into local-date buckets,
	// grouping by league id (parsed from the event uid, resolved to slug/name via
	// leagueMeta), merging leagues that span more than one fetch, de-duplicating
	// events, and adapting each /all event to the header shape the app reads.
	const rebucketed = Promise.all([Promise.all(fetches), leagueMeta]).then(([responses, meta]) => {
		const dayMap: Record<string, Map<string, any>> = {};
		for (const dt of displayDts) dayMap[dt] = new Map();
		const seen = new Set<string>();
		for (const res of responses) {
			for (const event of res?.events ?? []) {
				const dt = localDate(event.date);
				const lid = leagueIdOf(event.uid);
				if (!dayMap[dt] || !lid || seen.has(event.id)) continue;
				seen.add(event.id);
				let lg = dayMap[dt].get(lid);
				if (!lg) {
					const m = meta[lid];
					lg = { id: lid, slug: m?.slug ?? lid, name: m?.name ?? `League ${lid}`, gender: m?.gender, events: [] };
					dayMap[dt].set(lid, lg);
				}
				lg.events.push(adaptEvent(event));
			}
		}
		const out: Record<string, any> = {};
		for (const dt of displayDts) {
			out[dt] = { sports: [{ leagues: Array.from(dayMap[dt].values()) }] };
		}
		return out;
	});

	let days: Record<string, Promise<any>> = {};
	for (const dt of displayDts) {
		days[dt] = rebucketed.then((m) => m[dt]);
	}
	const broadcasts = fetch(`${base}/broadcasts.json?d=${new Date().toISOString()}`)
		.then(res => res.json())
		.catch(() => ({ games: [] }));

	// GFR rankings keyed by ESPN team id, as { rank, intl, points, url, grade }. Composes two ESPN<->GFR
	// crosswalks with their respective ranking universes: clubs (team_map +
	// {men,women}_team, intl:false) and national teams (national_map + the FIFA
	// {men,women}_international tables, intl:true). The two rank scales differ, so
	// the `intl` flag lets the UI distinguish them. Rankings live in static/rankings
	// (gitignored; present in dev/build); the crosswalks are committed.
	const json = (p: string, fallback: any) =>
		fetch(`${base}/${p}?d=${new Date().toISOString()}`).then(res => res.json()).catch(() => fallback);
	const GFR_BASE = 'https://globalfootballrankings.com';
	// Per-api_football_id GFR info: rank, the raw score (clubs: `rating`, national:
	// FIFA `points`), and a link to the relevant overall GFR ranking page. `kind`/
	// `gender` select the value field and the (gender-scoped) ranking page.
	const gfrInfo = (kind: 'club' | 'national', gender: 'men' | 'women', list: any) => {
		const url = kind === 'club'
			? `${GFR_BASE}/rankings/teams/${gender}`
			: `${GFR_BASE}/rankings/fifa-world-ranking/${gender}`;
		const idx: Record<number, { rank: number; points: number; url: string }> = {};
		for (const t of list.rankings ?? []) {
			idx[t.api_football_id] = { rank: t.rank, points: kind === 'club' ? t.rating : t.points, url };
		}
		return idx;
	};
	// Map a club rating to a standard American letter grade (with +/-). Returns
	// null below D- (rating < 60) so the UI shows nothing for low-rated clubs.
	const gradeFor = (rating: number | undefined): string | null => {
		if (rating == null) return null;
		if (rating >= 97) return 'A+';
		if (rating >= 93) return 'A';
		if (rating >= 90) return 'A-';
		if (rating >= 87) return 'B+';
		if (rating >= 83) return 'B';
		if (rating >= 80) return 'B-';
		if (rating >= 77) return 'C+';
		if (rating >= 73) return 'C';
		if (rating >= 70) return 'C-';
		if (rating >= 67) return 'D+';
		if (rating >= 63) return 'D';
		if (rating >= 60) return 'D-';
		return null;
	};
	// Normalize a single ranking table's value field (clubs: `rating`, national:
	// FIFA `points`) to a 0..1 strength per api_football_id. Anchored so the table
	// median maps to 0 and the table max to 1 — below-median teams contribute ~0,
	// scaling up to the very top. Each table is normalized independently because
	// the four scales differ; anchors (median/max) are easy to tune.
	const strengthIndex = (field: string, list: any) => {
		const rows = list.rankings ?? [];
		const vals = rows.map((t: any) => t[field]).filter((v: any) => v != null).sort((a: number, b: number) => a - b);
		const idx: Record<number, number> = {};
		if (!vals.length) return idx;
		const hi = vals[vals.length - 1];
		const lo = vals[Math.floor(vals.length / 2)]; // median
		const span = hi - lo;
		for (const t of rows) {
			const v = t[field];
			if (v == null) continue;
			idx[t.api_football_id] = span > 0 ? Math.max(0, Math.min(1, (v - lo) / span)) : 0;
		}
		return idx;
	};
	const teamRanks = Promise.all([
		json('crosswalk/team_map.json', { teams: [] }),
		json('crosswalk/national_map.json', { teams: [] }),
		json('rankings/men_team.json', { rankings: [] }),
		json('rankings/women_team.json', { rankings: [] }),
		json('rankings/men_international.json', { rankings: [] }),
		json('rankings/women_international.json', { rankings: [] }),
	]).then(([clubXw, natXw, menT, womenT, menI, womenI]) => {
		// Per-table info merged — an api_football_id belongs to a single club/national
		// table, so no collision. Strength is normalized per table (men/women apart).
		const clubInfo = { ...gfrInfo('club', 'men', menT), ...gfrInfo('club', 'women', womenT) };
		const intlInfo = { ...gfrInfo('national', 'men', menI), ...gfrInfo('national', 'women', womenI) };
		const clubStrength = { ...strengthIndex('rating', menT), ...strengthIndex('rating', womenT) };
		const intlStrength = { ...strengthIndex('points', menI), ...strengthIndex('points', womenI) };
		const out: Record<string, { rank: number; intl: boolean; strength: number; points: number; url: string; grade?: string | null }> = {};
		for (const m of clubXw.teams ?? []) {
			const info = clubInfo[m.gfr_api_football_id];
			if (info) out[String(m.espn_id)] = { rank: info.rank, intl: false, strength: clubStrength[m.gfr_api_football_id] ?? 0, points: info.points, url: info.url, grade: gradeFor(info.points) };
		}
		for (const m of natXw.teams ?? []) {
			const info = intlInfo[m.gfr_api_football_id];
			if (info) out[String(m.espn_id)] = { rank: info.rank, intl: true, strength: intlStrength[m.gfr_api_football_id] ?? 0, points: info.points, url: info.url };
		}
		return out;
	}).catch(() => ({}));

	// Alternate competition boost input: GFR *league* power ratings keyed by ESPN
	// slug, as { rating, name, weight, via? }. ESPN's prominence order (leagueOrder
	// above) is US/Anglo-centric — Brazil, Belgium, Argentina and Japan all sit past
	// rank 100 and score nothing — so DayGames takes the max of that and a base
	// derived from these ratings. Men's clubs only: women's leagues live in a
	// separate GFR table on its own scale, and continental/national-team slugs have
	// no GFR league row at all, so both are simply absent here.
	//
	// Cups aren't in league_map (build_crosswalk.py skips anything ESPN flags a
	// tournament — no single country to scope against), so a cup inherits its
	// country's top flight at a weight that falls off 10 points per position between
	// the two *within that country's slugs* in ESPN's order: eng.1(0) eng.fa(1)
	// eng.league_cup(2) eng.2(3) eng.charity(4) … → 1.0 / 0.9 / 0.8 / — / 0.6.
	// (Raw list-index distance can't work: ESPN interleaves countries, putting
	// usa.open 25 slots and mex.campeon 189 slots from their top flight.)
	const leagueAlt = Promise.all([
		json('crosswalk/league_map.json', { leagues: [] }),
		json('rankings/men_league.json', { rankings: [] }),
		leagueOrderData,
	]).then(([xw, menL, lo]) => {
		const byApiId: Record<number, { rating: number; name: string }> = {};
		for (const l of menL.rankings ?? []) {
			if (l.api_football_id != null) byApiId[l.api_football_id] = { rating: l.rating, name: l.league_name };
		}
		const out: Record<string, { rating: number; name: string; weight: number; via?: string }> = {};
		for (const m of xw.leagues ?? []) {
			const l = byApiId[m.gfr_api_football_id];
			if (l) out[m.espn_slug] = { rating: l.rating, name: l.name, weight: 1 };
		}
		// Group the ordered slug list by country trigram, men only. `meta` is keyed by
		// ESPN's numeric league id, so index gender by slug first.
		const genderOf: Record<string, string | undefined> = {};
		for (const m of Object.values<any>(lo.meta ?? {})) genderOf[m.slug] = m.gender;
		const byCountry: Record<string, string[]> = {};
		for (const slug of lo.leagues ?? []) {
			if (genderOf[slug] === 'women') continue;
			(byCountry[slug.split('.')[0]] ??= []).push(slug);
		}
		for (const [tri, slugs] of Object.entries(byCountry)) {
			const parentSlug = `${tri}.1`;
			const parent = out[parentSlug];
			const pi = slugs.indexOf(parentSlug);
			if (!parent || pi < 0) continue;
			slugs.forEach((slug, i) => {
				if (out[slug] || ALT_BLOCK.has(slug) || TIER_SLUG.test(slug)) return;
				const weight = 1 - CUP_FALLOFF * Math.abs(i - pi);
				if (weight > 0) out[slug] = { rating: parent.rating, name: parent.name, weight, via: parentSlug };
			});
		}
		return out;
	}).catch(() => ({}));

	return { days, broadcasts, leagueOrder, teamRanks, leagueAlt, yesterdayDt };
};
