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
	return { days, broadcasts, leagueOrder };
};
