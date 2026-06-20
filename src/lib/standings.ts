// On-demand competition standings, fetched from ESPN's v2 standings endpoint when
// the user clicks a league's 📊 trigger (never on the main load path). Results are
// cached per session keyed by league slug, so the same competition opened on
// different days (each a separate DayGames instance) only fetches once.
//
// The endpoint returns a uniform `{ name, children[] }` shape across competition
// types: each child is a sub-table (World Cup -> 12 groups, MLS -> 2 conferences,
// EPL/UCL -> 1). Knockout-only cups return HTTP 200 with no `children` -> null.

export type StandingsRow = {
	teamId: string;
	name: string;
	abbrev: string;
	logo: string | null;
	logoDark: string | null;
	rank: number;
	note: { description: string; color: string } | null;
	points: string;
	played: string;
	wins: string;
	draws: string;
	losses: string;
	gf: string;
	ga: string;
	gd: string; // signed, e.g. "+3"
	record: string; // W-D-L, e.g. "2-0-0"
};

export type StandingsGroup = { name: string; entries: StandingsRow[] };
export type Standings = { name: string; groups: StandingsGroup[] };

// Dark-mode logos live in the sibling `500-dark` directory (mirrors +page.ts).
const darkLogo = (url?: string | null) => (url ? url.replace('/500/', '/500-dark/') : null);

// stats[] entries carry { name, displayValue }; read the formatted string by name.
const statBy = (entry: any, name: string): string => {
	const s = (entry.stats ?? []).find((x: any) => x.name === name);
	return s?.displayValue ?? '';
};

const adaptStandings = (raw: any): Standings | null => {
	const children = raw?.children;
	if (!Array.isArray(children) || children.length === 0) return null;
	const groups: StandingsGroup[] = children.map((child: any) => {
		const entries: StandingsRow[] = (child.standings?.entries ?? []).map((e: any) => {
			const t = e.team ?? {};
			const logo = t.logos?.[0]?.href ?? null;
			const note = e.note ? { description: e.note.description, color: e.note.color } : null;
			return {
				teamId: String(t.id ?? ''),
				name: t.displayName ?? t.shortDisplayName ?? t.name ?? '',
				abbrev: t.abbreviation ?? t.shortDisplayName ?? '',
				logo,
				logoDark: darkLogo(logo),
				rank: Number(statBy(e, 'rank')) || (e.note?.rank ?? 0),
				note,
				points: statBy(e, 'points'),
				played: statBy(e, 'gamesPlayed'),
				wins: statBy(e, 'wins'),
				draws: statBy(e, 'ties'),
				losses: statBy(e, 'losses'),
				gf: statBy(e, 'pointsFor'),
				ga: statBy(e, 'pointsAgainst'),
				gd: statBy(e, 'pointDifferential'),
				record: statBy(e, 'overall'),
			};
		});
		// Entries arrive rank-sorted; sort defensively.
		entries.sort((a, b) => a.rank - b.rank);
		return { name: child.name ?? '', entries };
	});
	return { name: raw.name ?? '', groups };
};

const cache = new Map<string, Promise<Standings | null>>();

export function fetchStandings(slug: string): Promise<Standings | null> {
	let p = cache.get(slug);
	if (!p) {
		const url = `https://site.api.espn.com/apis/v2/sports/soccer/${slug}/standings`;
		p = fetch(url)
			.then((res) => res.json())
			.then(adaptStandings)
			.catch(() => null);
		cache.set(slug, p);
	}
	return p;
}
