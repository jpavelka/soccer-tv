// On-demand knockout bracket for a competition, built from ESPN's league
// scoreboard. ESPN has no bracket endpoint and no structured match->match
// linkage, but it pre-seeds every knockout fixture (even during the group
// stage) as a normal scoreboard event tagged with its round in `season.slug`.
// A single date-range scoreboard call over the season window returns them all;
// we keep the knockout rounds, ordered by when they're played.
//
// Before a team is decided ESPN fills the slot with a placeholder name
// ("Group A 2nd Place", "Round of 32 1 Winner") and an empty logo; these are
// shown as-is and replaced by the real team once the prior match finishes.

export type BracketTeam = {
	name: string;
	abbrev: string;
	logo: string | null;
	logoDark: string | null;
	score: string;
	winner: boolean;
	placeholder: boolean;
};
export type BracketMatch = {
	id: string;
	date: string;
	state: string; // 'pre' | 'in' | 'post'
	summary: string;
	venue: string | null; // stadium name
	location: string | null; // "City, Country"
	home: BracketTeam;
	away: BracketTeam;
};
export type BracketRound = { slug: string; name: string; matches: BracketMatch[] };
export type Bracket = { rounds: BracketRound[] };

// Knockout round slugs ESPN uses; anything matching is treated as a bracket
// round. Group/league play (`group-stage`, league-name slugs) won't match.
const KO_RE = /round-of-\d+|quarter-?final|semi-?final|(^|[^a-z])final([^a-z]|$)|3rd-place|third-place|knockout|playoff|last-\d+/i;
const isKnockout = (slug?: string) => !!slug && slug !== 'group-stage' && KO_RE.test(slug);

// Pretty round names for the common slugs; otherwise title-case the slug.
const ROUND_NAMES: Record<string, string> = {
	'round-of-64': 'Round of 64',
	'round-of-32': 'Round of 32',
	'round-of-16': 'Round of 16',
	quarterfinals: 'Quarterfinals',
	semifinals: 'Semifinals',
	'3rd-place-match': '3rd-Place Match',
	final: 'Final',
};
const roundName = (slug: string) =>
	ROUND_NAMES[slug] ??
	slug.replace(/-+/g, ' ').trim().replace(/\b\w/g, (c) => c.toUpperCase()).replace(/\bOf\b/g, 'of');

const darkLogo = (url?: string | null) => (url ? url.replace('/500/', '/500-dark/') : null);

const adaptTeam = (c: any): BracketTeam => {
	const t = c.team ?? {};
	const logo = t.logo || null; // placeholders carry an empty logo string
	return {
		name: t.displayName ?? t.shortDisplayName ?? t.name ?? 'TBD',
		abbrev: t.abbreviation ?? t.shortDisplayName ?? '',
		logo,
		logoDark: darkLogo(logo),
		score: c.score ?? '',
		winner: !!c.winner,
		placeholder: !logo,
	};
};

const adaptBracket = (raw: any): Bracket | null => {
	const events = Array.isArray(raw?.events) ? raw.events : [];
	const byRound = new Map<string, BracketRound>();
	for (const e of events) {
		const slug = e.season?.slug;
		if (!isKnockout(slug)) continue;
		const comp = e.competitions?.[0];
		if (!comp) continue;
		// Home-first (order 0) like the rest of the app.
		const competitors = [...(comp.competitors ?? [])].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
		const st = comp.status?.type ?? {};
		const addr = comp.venue?.address;
		const match: BracketMatch = {
			id: e.id,
			date: e.date,
			state: st.state ?? 'pre',
			summary: st.shortDetail ?? st.detail ?? '',
			venue: comp.venue?.fullName ?? null,
			location: addr ? [addr.city, addr.country].filter(Boolean).join(', ') : null,
			home: adaptTeam(competitors[0] ?? {}),
			away: adaptTeam(competitors[1] ?? {}),
		};
		let round = byRound.get(slug);
		if (!round) {
			round = { slug, name: roundName(slug), matches: [] };
			byRound.set(slug, round);
		}
		round.matches.push(match);
	}
	if (byRound.size === 0) return null;
	// Order matches within a round, and rounds, by kickoff time — knockout rounds
	// run sequentially, so earliest-match time orders the rounds correctly without
	// a hard-coded list.
	const rounds = [...byRound.values()];
	for (const r of rounds) r.matches.sort((a, b) => +new Date(a.date) - +new Date(b.date));
	rounds.sort((a, b) => +new Date(a.matches[0].date) - +new Date(b.matches[0].date));
	return { rounds };
};

const ymd = (iso: string) => iso.slice(0, 10).replaceAll('-', '');
const cache = new Map<string, Promise<Bracket | null>>();

export function fetchBracket(slug: string, startDate: string, endDate: string): Promise<Bracket | null> {
	let p = cache.get(slug);
	if (!p) {
		const url = `https://site.api.espn.com/apis/site/v2/sports/soccer/${slug}/scoreboard?dates=${ymd(startDate)}-${ymd(endDate)}&limit=999`;
		p = fetch(url)
			.then((res) => res.json())
			.then(adaptBracket)
			.catch(() => null);
		cache.set(slug, p);
	}
	return p;
}
