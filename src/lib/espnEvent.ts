// Adapter from ESPN's site-API scoreboard event into the leaner "header" shape
// the rest of the app reads. Used both by the home-page load (`/all` scoreboard)
// and the bracket (`/{slug}/scoreboard`), since the two endpoints share this
// event shape — so a bracket card can open the same match modal.

import { canonicalBcst } from '$lib/broadcasters';

// /all gives no clean per-game stage label, so two complementary signals are
// blended (see `stageOf`):
//   - `season.slug` carries knockout rounds ("round-of-32", "promotion-finals"),
//     but flattens group play to just "group-stage".
//   - `competition.altGameNote` carries the group ("FIFA World Cup, Group A"),
//     but for knockouts is just the competition name ("FIFA World Cup").
// Both are usually just the league-season name for ordinary league play.
const STAGE_RE = /round-of-\d+|quarter-?final|semi-?final|knockout|playoff|(^|-)finals?(-|$)/;
const deriveStage = (slug?: string): string | null => {
	if (!slug) return null;
	const s = slug.toLowerCase();
	if (!STAGE_RE.test(s)) return null;
	return s.replace(/-+/g, ' ').trim()
		.replace(/\b\w/g, (c) => c.toUpperCase())
		.replace(/\bOf\b/g, 'of');
};

// altGameNote is "<competition>, <stage>", where <stage> can itself be prefixed
// with a redundant "<year> <competition> - " ("Copa Chile, 2026 Copa Chile -
// Group A"). Keep only the part after the last " - " of the post-comma stage.
// No comma means there's no sub-stage (just the competition name) -> null, so
// the slug stays authoritative for knockout rounds.
const stageFromNote = (note?: string): string | null => {
	if (!note) return null;
	const i = note.indexOf(',');
	if (i < 0) return null;
	let s = note.slice(i + 1).trim();
	const j = s.lastIndexOf(' - ');
	if (j >= 0) s = s.slice(j + 3).trim();
	return s || null;
};

// Prefer the slug's knockout round when present (authoritative), else the group
// from altGameNote. The two are effectively mutually exclusive in practice.
const stageOf = (e: any, comp: any): string | null =>
	deriveStage(e.season?.slug) ?? stageFromNote(comp.altGameNote);

const toMoneyLine = (v: any): number | undefined => {
	if (v == null) return undefined;
	const n = Number(v);
	return Number.isFinite(n) ? n : undefined;
};

// Normalize /all's odds array into the flat { home/away/draw: { moneyLine } }
// shape winProbabilities reads. Home/away moneylines are strings under
// moneyline.{side}.close.odds; the draw is a number under drawOdds.moneyLine.
const adaptOdds = (oddsArr: any) => {
	const o = Array.isArray(oddsArr) ? oddsArr.find((x: any) => x) : oddsArr;
	if (!o) return undefined;
	const ml = o.moneyline ?? {};
	const home = toMoneyLine(ml.home?.close?.odds ?? ml.home?.open?.odds);
	const away = toMoneyLine(ml.away?.close?.odds ?? ml.away?.open?.odds);
	const draw = toMoneyLine(o.drawOdds?.moneyLine);
	if (home == null && away == null && draw == null) return undefined;
	return {
		...o,
		home: home != null ? { moneyLine: home } : undefined,
		away: away != null ? { moneyLine: away } : undefined,
		draw: draw != null ? { moneyLine: draw } : undefined,
	};
};

// Dark-mode logos aren't given by /all; the dark variant lives in the sibling
// `500-dark` directory for both club and country logos.
const darkLogo = (url?: string) => (url ? url.replace('/500/', '/500-dark/') : url);

const adaptCompetitor = (c: any) => {
	const t = c.team ?? {};
	return {
		id: c.id ?? t.id,
		homeAway: c.homeAway,
		score: c.score,
		winner: c.winner,
		name: t.shortDisplayName ?? t.displayName ?? t.name,
		abbreviation: t.abbreviation,
		logo: t.logo,
		logoDark: darkLogo(t.logo),
		color: t.color,
		alternateColor: t.alternateColor,
		links: t.links,
		statistics: c.statistics,
	};
};

// Adapt one site-API event into the header-shaped event the rest of the app reads.
export const adaptEvent = (e: any) => {
	const comp = e.competitions?.[0] ?? {};
	const st = comp.status?.type ?? {};
	const addr = comp.venue?.address;
	const seen = new Set<string>();
	const broadcasts: { name: string; isNational: boolean }[] = [];
	for (const g of comp.geoBroadcasts ?? []) {
		const name = g.media?.shortName ? canonicalBcst(g.media.shortName) : null;
		if (name && !seen.has(name)) {
			seen.add(name);
			broadcasts.push({ name, isNational: g.market?.type === 'National' });
		}
	}
	const stage = stageOf(e, comp);
	const link = (e.links ?? []).find((l: any) => l.rel?.includes('desktop'))?.href ?? e.links?.[0]?.href;
	return {
		id: e.id,
		uid: e.uid,
		date: e.date,
		name: e.name,
		shortName: e.shortName,
		link,
		status: st.state,
		summary: st.shortDetail ?? st.detail,
		location: comp.venue?.fullName,
		// Precomputed city/country, so the modal shows it without a per-game fetch.
		venueAddress: addr ? [addr.city, addr.country].filter(Boolean).join(', ') : null,
		neutralSite: comp.neutralSite,
		group: stage ? { name: stage } : null,
		notes: comp.notes ?? [],
		onWatch: false,
		broadcasts,
		odds: adaptOdds(comp.odds),
		details: comp.details ?? [],
		// The header endpoint listed competitors away-first (away on the left, score
		// shown as away-home); /all lists them home-first. Sort by `order` desc
		// (home=0, away=1) to keep the previous left/right arrangement.
		competitors: [...(comp.competitors ?? [])]
			.sort((a: any, b: any) => (b.order ?? 0) - (a.order ?? 0))
			.map(adaptCompetitor),
	};
};
