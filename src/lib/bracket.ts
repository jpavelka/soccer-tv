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
//
// The placeholder name encodes its feeder match as "<Round> <N> Winner|Loser",
// where <N> is the 1-based position within the round by ESPN's `matchNumber`.
// That ordering is NOT the scoreboard's id/date order (the bracket crosses
// deliberately) and `matchNumber` lives only in the core API (one call per
// event). So rather than fetch it live, we freeze the ordinal->event-id lists
// for the one tournament that warrants it (FIFA World Cup) in KO_FEEDER_IDS
// below, and resolve each placeholder to a concrete `feedsFrom.matchId` with no
// extra calls. Other tournaments simply get no feeder links.

import { adaptEvent } from './espnEvent';

// Where an undecided knockout slot's team comes from.
export type FeederRef = {
	round: string; // feeder round slug, e.g. 'round-of-32'
	ordinal: number; // 1-based position within that round, by ESPN matchNumber
	outcome: 'winner' | 'loser';
	matchId: string | null; // resolved feeder match id, if known
};
export type BracketTeam = {
	name: string;
	abbrev: string;
	logo: string | null;
	logoDark: string | null;
	link: string | null; // ESPN team page ("clubhouse"); null for undecided placeholder slots
	teamId: string | null; // ESPN team id; null for placeholders. Used to recover a
	// decided slot's feeder match (its slot no longer carries a `feedsFrom`).
	score: string;
	winner: boolean;
	placeholder: boolean;
	feedsFrom: FeederRef | null; // set for knockout placeholders whose feeder match is known
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
	event: ReturnType<typeof adaptEvent>; // full adapted event, so a card opens the match modal
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

// Feeder placeholder names, e.g. "Round of 32 3 Winner", "Quarterfinal 1
// Winner", "Semifinal 2 Loser". The trailing number is the slot's 1-based index
// within its round (ESPN matchNumber order); the label maps to its slug below.
const FEEDER_RE = /^(round of \d+|quarterfinals?|semifinals?)\s+(\d+)\s+(winner|loser)$/i;
const FEEDER_SLUG: Record<string, string> = {
	'round of 64': 'round-of-64',
	'round of 32': 'round-of-32',
	'round of 16': 'round-of-16',
	quarterfinal: 'quarterfinals',
	quarterfinals: 'quarterfinals',
	semifinal: 'semifinals',
	semifinals: 'semifinals',
};

// Frozen ordinal -> ESPN event id for the rounds other rounds feed from, per
// league slug. Index i holds the event whose placeholders are referenced as
// "<Round> <i+1> Winner|Loser". Derived once from the core API's `matchNumber`
// (scoreboard id/date order does NOT match it); event ids are stable for a
// scheduled tournament, so no refresh is needed during the event.
//
// Each entry is stamped with the `season` year it was built from. Slugs repeat
// across editions (`fifa.world` 2026 vs 2030), so the table is applied only when
// its season matches the scoreboard's — a future edition with a stale entry (or
// none) cleanly gets no feeder links instead of last time's. As a backstop,
// resolution also drops any id not present in the current payload, so a wrong or
// outdated id can never link anywhere.
//
// Regenerate with:  scraper/build_ko_feeder_ids.py <league-slug>
const KO_FEEDER_IDS: Record<string, { season: number; rounds: Record<string, string[]> }> = {
	'fifa.world': {
		season: 2026,
		rounds: {
			'round-of-32': ['760486', '760489', '760488', '760487', '760492', '760490', '760491', '760495', '760494', '760493', '760496', '760497', '760498', '760500', '760501', '760499'],
			'round-of-16': ['760503', '760502', '760504', '760505', '760506', '760507', '760509', '760508'],
			quarterfinals: ['760510', '760511', '760512', '760513'],
			semifinals: ['760514', '760515'],
		},
	},
};

const adaptTeam = (c: any, resolveFeeder: (name: string) => FeederRef | null): BracketTeam => {
	const t = c.team ?? {};
	const logo = t.logo || null; // placeholders carry an empty logo string
	const link = t.links?.find((l: any) => l.rel?.includes('clubhouse'))?.href ?? null;
	const name = t.displayName ?? t.shortDisplayName ?? t.name ?? 'TBD';
	const placeholder = !logo;
	return {
		name,
		abbrev: t.abbreviation ?? t.shortDisplayName ?? '',
		logo,
		logoDark: darkLogo(logo),
		link,
		teamId: !placeholder && t.id != null ? String(t.id) : null,
		score: c.score ?? '',
		winner: !!c.winner,
		placeholder,
		feedsFrom: placeholder ? resolveFeeder(name) : null,
	};
};

const adaptBracket = (raw: any, feeder?: { season: number; rounds: Record<string, string[]> }): Bracket | null => {
	const events = Array.isArray(raw?.events) ? raw.events : [];
	// Apply the frozen table only to the edition it was built from — a stale entry
	// from a previous edition of the same slug is ignored. (Season year comes from
	// the scoreboard's league season; if it's somehow absent we still rely on the
	// existence guard below.)
	const currentSeason = raw?.leagues?.[0]?.season?.year;
	const feederIds = feeder && (currentSeason == null || feeder.season === currentSeason) ? feeder.rounds : undefined;
	// Backstop: only ever link to a match present in this payload, so an outdated
	// or wrong id resolves to no link rather than a dead one.
	const eventIds = new Set<string>(events.map((e: any) => String(e.id)));
	// Resolve a placeholder name ("Round of 32 3 Winner") to its feeder match via
	// the frozen ordinal lists; matchId stays null when this tournament has none.
	const resolveFeeder = (name: string): FeederRef | null => {
		const m = FEEDER_RE.exec(name.trim());
		if (!m) return null;
		const slug = FEEDER_SLUG[m[1].toLowerCase()];
		if (!slug) return null;
		const ordinal = Number(m[2]);
		const id = feederIds?.[slug]?.[ordinal - 1];
		return {
			round: slug,
			ordinal,
			outcome: m[3].toLowerCase() as 'winner' | 'loser',
			matchId: id && eventIds.has(id) ? id : null,
		};
	};
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
			home: adaptTeam(competitors[0] ?? {}, resolveFeeder),
			away: adaptTeam(competitors[1] ?? {}, resolveFeeder),
			event: adaptEvent(e),
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
			.then((raw) => adaptBracket(raw, KO_FEEDER_IDS[slug]))
			.catch(() => null);
		cache.set(slug, p);
	}
	return p;
}

// --- Tree layout -----------------------------------------------------------
// Positions matches as a classic single-elimination tree from the feeder edges
// (`feedsFrom.matchId`): col = round index, and each match is vertically
// centered between the two matches that feed it. Leaf matches (first knockout
// round) take sequential rows; internal matches the midpoint of their feeders.
// Rows are in "leaf-slot" units (fractional for internal nodes); the component
// scales them to pixels. Returns null when there aren't enough edges to form a
// tree, so the caller can fall back to plain columns.
export type BracketTreeLayout = {
	col: Record<string, number>; // matchId -> round index
	row: Record<string, number>; // matchId -> vertical slot
	rowSpan: number; // total slots, for sizing
	edges: { from: string; to: string }[]; // feeder matchId -> consumer matchId
};

export function layoutBracket(b: Bracket): BracketTreeLayout | null {
	const byId = new Map<string, BracketMatch>();
	const col: Record<string, number> = {};
	b.rounds.forEach((r, ci) =>
		r.matches.forEach((m) => {
			byId.set(m.id, m);
			col[m.id] = ci;
		}),
	);
	// A slot's feeder match: from its placeholder while undecided; once decided the
	// slot shows the real team (no placeholder), so recover the feeder as the match
	// this team won in the nearest prior round. Keeps the tree intact as games finish.
	const winnerId = (m: BracketMatch): string | null =>
		m.home.winner ? m.home.teamId : m.away.winner ? m.away.teamId : null;
	const feederForSlot = (team: BracketTeam, consumerCol: number): string | null => {
		if (team.feedsFrom?.matchId && byId.has(team.feedsFrom.matchId)) return team.feedsFrom.matchId;
		if (team.placeholder || !team.teamId) return null;
		let best: string | null = null;
		let bestCol = -1;
		for (const m of byId.values()) {
			const c = col[m.id];
			if (c >= consumerCol || c <= bestCol) continue;
			if (winnerId(m) === team.teamId) {
				best = m.id;
				bestCol = c;
			}
		}
		return best;
	};
	const feedersOf = (m: BracketMatch): string[] =>
		[feederForSlot(m.home, col[m.id]), feederForSlot(m.away, col[m.id])].filter((x): x is string => !!x);
	if (![...byId.values()].some((m) => feedersOf(m).length > 0)) return null;

	// Root the main tree at the latest "sink" (a match nothing feeds from — the
	// final). Other sinks like the 3rd-place match are parked separately below.
	const consumed = new Set<string>();
	for (const m of byId.values()) for (const f of feedersOf(m)) consumed.add(f);
	let root: string | null = null;
	let rootCol = -1;
	for (const m of byId.values()) {
		if (consumed.has(m.id) || col[m.id] <= rootCol) continue;
		rootCol = col[m.id];
		root = m.id;
	}
	if (!root) return null;

	const row: Record<string, number> = {};
	const edges: { from: string; to: string }[] = [];
	let nextLeaf = 0;
	const visit = (id: string): number => {
		if (id in row) return row[id];
		const fs = feedersOf(byId.get(id)!);
		let r: number;
		if (fs.length === 0) {
			r = nextLeaf++;
		} else {
			const childRows = fs.map((f) => {
				edges.push({ from: f, to: id });
				return visit(f);
			});
			r = childRows.reduce((a, c) => a + c, 0) / childRows.length;
		}
		row[id] = r;
		return r;
	};
	visit(root);
	if (nextLeaf === 0) return null;

	// Park any matches the tree didn't reach (e.g. 3rd-place, whose feeders are
	// shared with the final's branch) in line with the lowest tree card, in their own
	// (late) column — adds no height and stays clear of the other games.
	const parkRow = nextLeaf - 1;
	for (const id of byId.keys()) {
		if (id in row) continue;
		row[id] = parkRow;
	}
	return { col, row, rowSpan: nextLeaf, edges };
}

// Re-derive vertical positions with `anchorCol` as the leaf round instead of the
// first round. The default layout spreads later rounds across the whole first-round
// height (the two semifinals end up ~8 rows apart); anchoring on a later round
// stacks *its* matches adjacently and centers everything after it between them, so a
// focused round and its descendants fit on screen together. anchorCol<=0 is the
// original layout. Earlier (collapsed) rounds get no row — they render as rails.
export function rowsForAnchor(
	t: BracketTreeLayout,
	anchorCol: number,
): { row: Record<string, number>; rowSpan: number } {
	if (anchorCol <= 0) return { row: t.row, rowSpan: t.rowSpan };
	const feeders: Record<string, string[]> = {};
	for (const e of t.edges) (feeders[e.to] ??= []).push(e.from);
	const byCol: Record<number, string[]> = {};
	for (const id in t.col) (byCol[t.col[id]] ??= []).push(id);
	// Keep each column ordered top-to-bottom as the original layout had it.
	const ordered = (c: number) => (byCol[c] ?? []).slice().sort((a, b) => (t.row[a] ?? 0) - (t.row[b] ?? 0));
	const maxCol = Math.max(0, ...Object.keys(byCol).map(Number));

	const row: Record<string, number> = {};
	let nextLeaf = 0;
	for (const id of ordered(anchorCol)) row[id] = nextLeaf++; // anchor round = leaves
	for (let c = anchorCol + 1; c <= maxCol; c++) {
		for (const id of ordered(c)) {
			const fs = (feeders[id] ?? []).filter((f) => f in row);
			if (fs.length) row[id] = fs.reduce((s, f) => s + row[f], 0) / fs.length;
		}
	}
	// Park anchor-or-later matches with no feeders in view (e.g. 3rd-place) in line
	// with the lowest tree card, so they add no height and stay out of the way.
	const parkRow = nextLeaf - 1;
	for (let c = anchorCol; c <= maxCol; c++)
		for (const id of byCol[c] ?? [])
			if (!(id in row)) row[id] = parkRow;
	return { row, rowSpan: nextLeaf };
}
