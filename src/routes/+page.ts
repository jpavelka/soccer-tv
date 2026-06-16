import type { PageLoad } from './$types';
import { base } from '$app/paths';

const getDateGames = (dt) => {
	const url = `https://site.web.api.espn.com/apis/v2/scoreboard/header?sport=soccer&dates=${dt.replaceAll('-', '')}&limit=999&d=${(new Date()).toISOString()}`;
	return fetch(url).then(res => res.json());
}

const dateNDaysFromNow = (n) => {
	const tzoffset = (new Date()).getTimezoneOffset() * 60000;
	return new Date(new Date(Date.now() - tzoffset).setDate(new Date().getDate() + n)).toISOString().slice(0, 10);
}

// The local (browser-timezone) calendar date a kickoff falls on, YYYY-MM-DD.
// getFullYear/getMonth/getDate read local-time components.
const localDate = (iso: string) => {
	const d = new Date(iso);
	return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export const load: PageLoad = async ({ fetch }) => {
	// The 7 local days we display.
	const displayDts: string[] = [];
	for (let i = 0; i <= 6; i++) displayDts.push(dateNDaysFromNow(i));

	// ESPN buckets games by US Eastern date, so a kickoff can land on a different
	// day than the viewer's local one (e.g. an 11pm Central game shows up under
	// the next Eastern date). Fetch one extra ESPN day on each side of the window
	// and re-bucket every event by its local kickoff date below.
	const fetchDts: string[] = [];
	for (let i = -1; i <= 7; i++) fetchDts.push(dateNDaysFromNow(i));
	const fetches = fetchDts.map(getDateGames);

	// Resolve every ESPN day, then redistribute events into local-date buckets,
	// merging leagues that span more than one fetch and de-duplicating events.
	const rebucketed = Promise.all(fetches).then((responses) => {
		const dayMap: Record<string, Map<string, any>> = {};
		for (const dt of displayDts) dayMap[dt] = new Map();
		const seen = new Set<string>();
		for (const res of responses) {
			for (const league of res?.sports?.[0]?.leagues ?? []) {
				for (const event of league.events ?? []) {
					const dt = localDate(event.date);
					if (!dayMap[dt] || seen.has(event.id)) continue;
					seen.add(event.id);
					const key = league.id ?? league.slug ?? league.name;
					let lg = dayMap[dt].get(key);
					if (!lg) {
						lg = { ...league, events: [] };
						dayMap[dt].set(key, lg);
					}
					lg.events.push(event);
				}
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
	// ESPN's master league prominence order (slug -> rank), baked by the scraper.
	const leagueOrder = fetch(`${base}/league_order.json?d=${new Date().toISOString()}`)
		.then(res => res.json())
		.then((d) => {
			const rank: Record<string, number> = {};
			(d.leagues ?? []).forEach((slug: string, i: number) => { rank[slug] = i; });
			return rank;
		})
		.catch(() => ({}));

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

	return { days, broadcasts, leagueOrder, teamRanks };
};
