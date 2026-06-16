<script lang="ts">
    import { goodBcsts, allBcsts, windowInfo, accordionShow } from "$lib/stores";
    import Accordion from "./Accordion.svelte";
    import Modal from "./Modal.svelte";

    let { dayData, dt, goodStatuses, filterBroadcasts, broadcasts, leagueOrder, teamRanks, sortMode } = $props();

    // GFR data by ESPN team id ({ rank, intl, strength }). `rank` drives the inline
    // labels below; `strength` (0..1, normalized upstream in +page.ts) feeds the
    // interest score. intl=true means a FIFA national team (different scale, already
    // normalized). Populated from the resolved map in the main effect below.
    let teamRankMap = $state<Record<string, { rank: number; intl: boolean; strength: number; points: number; url: string; grade?: string | null }>>({});
    const rankOf = (c: any) => teamRankMap[String(c?.id)] ?? null;

    const nameMatch = (a: string, b: string) => {
        const al = a.toLowerCase(), bl = b.toLowerCase();
        return al.includes(bl) || bl.includes(al);
    };

    // Match by timestamp (within 10 min) + at least one team name overlap,
    // falling back to date + both teams when no timestamp is available.
    const findLstvGame = (event: any, wstGames: any[]) => {
        const espnMs = new Date(event.date).getTime();
        const espnTeams = event.competitors.map((c: any) => c.name);
        return wstGames.find((wg: any) => {
            const oneTeamMatches = espnTeams.some((en: string) => wg.teams.some((t: string) => nameMatch(en, t)));
            if (!oneTeamMatches) return false;
            if (wg.timestamp_ms != null) {
                return Math.abs(espnMs - wg.timestamp_ms) < 10 * 60 * 1000;
            }
            return wg.date === event.date.slice(0, 10) &&
                espnTeams.every((en: string) => wg.teams.some((t: string) => nameMatch(en, t)));
        });
    };

    let leagueData = $state<any[]>([]);
    let numToShow = $state(0);
    let flatEvents = $derived(
        leagueData
            .flatMap((league: any) => league.events
                .filter((e: any) => e.show)
                .map((e: any) => ({ event: e, league }))
            )
            .sort((a: any, b: any) => new Date(a.event.date).getTime() - new Date(b.event.date).getTime())
    );
    let flatEventsByInterest = $derived(
        leagueData
            .flatMap((league: any) => league.events
                .filter((e: any) => e.show)
                .map((e: any) => ({ event: e, league }))
            )
            .sort((a: any, b: any) => (b.event.interest ?? 0) - (a.event.interest ?? 0))
    );
    $effect(() => {
        Promise.all([dayData, broadcasts, leagueOrder, teamRanks]).then(([d, bcstData, leagueRank, ranks]) => {
            const wstGames = bcstData?.games ?? [];
            teamRankMap = ranks ?? {};
            // /all yields leagues in event order, so re-sort by ESPN's prominence
            // rank (the header endpoint used to return them pre-ordered). Falls back
            // to the as-received order if the rank map didn't load.
            leagueData = [...d.sports[0].leagues];
            if (leagueRank && Object.keys(leagueRank).length > 0) {
                leagueData.sort((a: any, b: any) =>
                    (leagueRank[a.slug] ?? Infinity) - (leagueRank[b.slug] ?? Infinity));
            }
            numToShow = 0;
            for (const [leagueIndex, league] of leagueData.entries()) {
                league.numToShow = 0;
                for (const event of league.events) {
                    event.bcstsToShow = [];
                    event.show = false;

                    // ESPN broadcasts
                    for (const bcst of event.broadcasts || []) {
                        if (!$allBcsts.includes(bcst.name)) {
                            allBcsts.update((a) => [...a, bcst.name])
                        }
                        if (!filterBroadcasts || $goodBcsts.includes(bcst.name)) {
                            event.bcstsToShow.push(bcst.name)
                        }
                    }

                    // Additional broadcasts from livesoccertv.com
                    const wstGame = findLstvGame(event, wstGames);
                    event.lstv_matched = !!wstGame;
                    event.topmatch = wstGame?.topmatch ?? false;
                    event.interest = interestScore(event, league, leagueIndex, leagueRank, ranks ?? {});
                    if (wstGame) {
                        for (const bcst of wstGame.broadcasts) {
                            if (!$allBcsts.includes(bcst)) {
                                allBcsts.update((a) => [...a, bcst])
                            }
                            if (!event.bcstsToShow.includes(bcst)) {
                                if (!filterBroadcasts || $goodBcsts.includes(bcst)) {
                                    event.bcstsToShow.push(bcst);
                                }
                            }
                        }
                    }

                    event.bcstStr = event.bcstsToShow.join('/');
                    if (!filterBroadcasts || event.bcstsToShow.length > 0) {
                        if (goodStatuses.includes(event.status)) {
                            numToShow += 1;
                            league.numToShow += 1;
                            event.show = true;
                        }
                    }
                }
            }
            for (const ld of leagueData) {
                if (!Object.keys($accordionShow).includes(dt + '-' + ld.name)) {
                    $accordionShow[dt + '-' + ld.name] = true;
                }
            }
        })
    })
    const narrowWidth = 550;
    let narrowScreen = $state(false);
    $effect(() => {
        narrowScreen = $windowInfo.screenWidth < narrowWidth;
    })
    const dtStr = new Date(dt).toLocaleDateString('en-US', {timeZone: 'UTC', weekday: 'long', month: 'long', day: 'numeric'});
    if (!Object.keys($accordionShow).includes(dt)) {
        $accordionShow[dt] = true;
    }
    const bodyBgNums = window
        ? window.getComputedStyle(document.body, null).getPropertyValue('background-color').match(/\d+/g)?.map(Number) ?? null
        : null;
    let mode = bodyBgNums && Math.max(...bodyBgNums) > 150 ? 'light' : 'dark';
    // Page background as hex, used to detect bars that would blend into it.
    const bgHex = bodyBgNums
        ? bodyBgNums.slice(0, 3).map((n) => n.toString(16).padStart(2, '0')).join('')
        : mode === 'light' ? 'ffffff' : '000000';
    // Border color for bars that are too close to the background.
    const barBorder = mode === 'light' ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.45)';

    let selectedEvent = $state<any>(null);
    let selectedLeague = $state<any>(null);
    let showInfoModal = $state(false);
    let venueAddress = $state<string | null>(null);
    // For in-progress / finished games: goals-cards-subs timeline and team stats,
    // both read off the adapted event (see +page.ts) — no per-game fetch.
    let matchEvents = $state<{ clock: string; icon: string; player: string; col: number; score: string; detail: string }[] | null>(null);
    // Indices of the timeline events whose detail is expanded. A click toggles
    // an event open/closed independently, so any number can be shown at once.
    let openTips = $state<Set<number>>(new Set());
    function toggleTip(i: number) {
        const next = new Set(openTips);
        if (next.has(i)) next.delete(i); else next.add(i);
        openTips = next;
    }
    let matchStats = $state<{ label: string; c0: string; c1: string }[] | null>(null);
    // Measured width of the win-probability bar column; drives whether each
    // percentage label fits inside its bar. Updated on resize via bind:clientWidth.
    let winbarsWidth = $state(0);
    // Label column (.prow-label width) + row gap, subtracted from the measured
    // container width to get the bar track width.
    const PROW_LABEL_OFFSET = 66;

    function showInfo(event: any, league: any) {
        selectedEvent = event;
        selectedLeague = league;
        openTips = new Set();
        showInfoModal = true;
        // The /all scoreboard supplies the venue address, the goals/cards timeline,
        // and per-team stats inline (precomputed/adapted upstream in +page.ts), so
        // there's no per-game fetch here. Timeline + stats apply once a game is
        // under way.
        venueAddress = event.venueAddress ?? null;
        const live = event.status !== 'pre';
        matchEvents = live ? matchTimeline(event) : null;
        matchStats = live ? matchStatRows(event) : null;
    }
    // Convert an American moneyline to a raw implied probability.
    function mlToProb(ml: number): number {
        return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
    }
    // Round a set of values (assumed to sum to ~100) to integers that sum to
    // exactly 100. Floor each, then distribute the remaining points to the
    // entries with the largest fractional remainders (i.e. those that lost the
    // most to rounding down).
    function roundTo100(vals: number[]): number[] {
        const floors = vals.map(Math.floor);
        let remaining = Math.round(vals.reduce((s, v) => s + v, 0)) - floors.reduce((s, v) => s + v, 0);
        const order = vals
            .map((v, i) => ({ i, frac: v - floors[i] }))
            .sort((a, b) => b.frac - a.frac);
        for (let k = 0; k < remaining; k++) floors[order[k].i]++;
        return floors;
    }
    // Derive fair home/draw/away win probabilities from the three-way moneyline
    // market, normalizing to remove the bookmaker's margin (vig). Returns null
    // unless all three moneylines are present.
    function winProbabilities(odds: any): { home: { abbr?: string; pct: number }; draw: { pct: number }; away: { abbr?: string; pct: number } } | null {
        const h = odds?.home?.moneyLine ?? odds?.homeTeamOdds?.moneyLine;
        const a = odds?.away?.moneyLine ?? odds?.awayTeamOdds?.moneyLine;
        const d = odds?.draw?.moneyLine ?? odds?.drawOdds?.moneyLine;
        if (h == null || a == null || d == null) return null;
        const raw = { home: mlToProb(h), draw: mlToProb(d), away: mlToProb(a) };
        const sum = raw.home + raw.draw + raw.away;
        // Round to whole percentages that always total 100 (largest-remainder
        // method): floor each, then hand the leftover points to whichever
        // entries lost the most to rounding.
        const [home, draw, away] = roundTo100([
            (100 * raw.home) / sum,
            (100 * raw.draw) / sum,
            (100 * raw.away) / sum,
        ]);
        return {
            home: { abbr: odds.homeTeamOdds?.team?.abbreviation, pct: home },
            draw: { pct: draw },
            away: { abbr: odds.awayTeamOdds?.team?.abbreviation, pct: away },
        };
    }

    // Neutral gray for the draw segment, and fallback team colors when ESPN's
    // are missing or clash.
    const DRAW_HEX = '8a8f96';
    const FALLBACK_HOME = '3b78c2';
    const FALLBACK_AWAY = 'c2693b';

    function normHex(c: string | undefined | null): string | null {
        if (!c) return null;
        const h = c.replace('#', '').trim().toLowerCase();
        return /^[0-9a-f]{6}$/.test(h) ? h : null;
    }
    function rgb(hex: string): [number, number, number] {
        return [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number];
    }
    // Euclidean RGB distance; under the threshold the colors read as the same.
    function tooClose(a: string, b: string, threshold = 60): boolean {
        const [r1, g1, b1] = rgb(a);
        const [r2, g2, b2] = rgb(b);
        return Math.hypot(r1 - r2, g1 - g2, b1 - b2) < threshold;
    }
    // Pick a team color distinct from every color in `avoid`: try primary, then
    // ESPN's alternate, then the supplied fallback.
    function teamColor(comp: any, avoid: string[], fallback: string): string {
        const candidates = [normHex(comp?.color), normHex(comp?.alternateColor), fallback];
        for (const c of candidates) {
            if (c && !avoid.some((x) => tooClose(c, x))) return c;
        }
        return fallback;
    }
    // Bar segment colors: draw is fixed gray; home must differ from draw; away
    // must differ from both the draw color and the chosen home color.
    function barColors(event: any): { home: string; draw: string; away: string } {
        const home = event.competitors.find((c: any) => c.homeAway === 'home') ?? event.competitors[0];
        const away = event.competitors.find((c: any) => c.homeAway === 'away') ?? event.competitors[1];
        const h = teamColor(home, [DRAW_HEX], FALLBACK_HOME);
        const a = teamColor(away, [DRAW_HEX, h], FALLBACK_AWAY);
        return { home: `#${h}`, draw: `#${DRAW_HEX}`, away: `#${a}` };
    }
    // A bar that's nearly the page background color would blend in, so flag it
    // for a border. Slightly looser threshold than the team/draw clash check
    // since a large solid block reads as "the same" from farther apart.
    function needsBorder(color: string): boolean {
        const h = normHex(color);
        return h ? tooClose(h, bgHex, 70) : false;
    }
    // Choose legible text color + shadow for a given segment background.
    function legibleText(hex: string): string {
        const [r, g, b] = rgb(normHex(hex) ?? '000000');
        const light = 0.299 * r + 0.587 * g + 0.114 * b > 150;
        return light
            ? 'color:#111;text-shadow:0 1px 1px rgba(255,255,255,0.45)'
            : 'color:#fff;text-shadow:0 1px 1px rgba(0,0,0,0.4)';
    }
    // Build the three bar rows in the same top-to-bottom order the teams appear
    // elsewhere (competitors[0] on top, draw in the middle, competitors[1] on
    // the bottom), mapping each team to its home/away probability and color.
    function winProbRows(event: any, odds: any): { label: string; logo: string | null; pct: number; color: string }[] | null {
        const wp = winProbabilities(odds);
        if (!wp) return null;
        const bc = barColors(event);
        const teamRow = (comp: any) => {
            const side = comp.homeAway === 'away' ? 'away' : 'home';
            return {
                label: comp.abbreviation ?? (side === 'home' ? 'Home' : 'Away'),
                logo: comp[`logo${mode === 'dark' ? 'Dark' : ''}`] ?? null,
                pct: wp[side].pct,
                color: bc[side],
            };
        };
        const [c0, c1] = event.competitors;
        return [teamRow(c0), { label: 'Draw', logo: null, pct: wp.draw.pct, color: bc.draw }, teamRow(c1)];
    }
    function eventStage(event: any, league: any): string | null {
        const name = event.group?.name;
        if (!name) return null;
        // Many leagues just echo the competition name into group.name; only
        // show it when it's something more specific (e.g. "Group A", "Round of 16").
        const echoes = [event.name, event.shortName, league?.name].filter(Boolean);
        return echoes.includes(name) ? null : name;
    }
    function eventNote(event: any): string | null {
        const notes = event.notes ?? [];
        const note = notes.find((n: any) => n.type === 'event-long')
            ?? notes.find((n: any) => n.type === 'event');
        return note?.text ?? note?.headline ?? null;
    }
    // ESPN team ("clubhouse") page for a competitor, straight from its own links
    // so we don't have to reconstruct the /id/{id}/{slug} URL ourselves.
    function teamLink(comp: any): string | null {
        return comp?.links?.find((l: any) => l.rel?.includes('clubhouse'))?.href ?? null;
    }
    // The /all event's `details`, distilled to goals and cards with just the
    // minute, player, team and (for goals) the running score. ESPN doesn't put a
    // running score on each play, so we tally goals ourselves as we walk the
    // (chronological) details. Each play's `team.id` matches the scoreboard
    // competitor id directly, so we map it to competitors[0|1] by id.
    // A fuller description of a goal/card for the tooltip, assembled from the
    // scorer + any assist (the /all details carry no prose `text`).
    function keyEventDetail(e: any, icon: string): string {
        const names = (e.athletesInvolved ?? []).map((a: any) => a?.displayName).filter(Boolean);
        const kind = icon === '⚽' ? 'Goal' : e.type?.text ?? '';
        const assist = names.length > 1 ? ` (assist: ${names.slice(1).join(', ')})` : '';
        return [[kind, names[0]].filter(Boolean).join(' – ') + assist].join('').trim();
    }
    function matchTimeline(event: any): { clock: string; icon: string; player: string; col: number; score: string; detail: string }[] | null {
        const idxById: Record<string, number> = {};
        event.competitors.forEach((c: any, i: number) => { if (c.id != null) idxById[c.id] = i; });

        const tally = [0, 0];
        const rows: { clock: string; icon: string; player: string; col: number; score: string; detail: string }[] = [];
        for (const e of event.details ?? []) {
            if (e.shootout) continue; // penalty-shootout kicks aren't match goals
            const t = e.type?.text ?? '';
            const isGoal = !!e.scoringPlay;
            let icon: string;
            if (isGoal) icon = '⚽';
            else if (e.redCard || t === 'Red Card') icon = '🟥';
            else if (e.yellowCard || t === 'Yellow Card') icon = '🟨';
            else continue;
            // Which team's column the event belongs to (-1 falls back to the left).
            const col = e.team?.id != null && idxById[e.team.id] != null ? idxById[e.team.id] : -1;
            let score = '';
            if (isGoal && col >= 0) { tally[col]++; score = `${tally[0]}–${tally[1]}`; }
            rows.push({
                clock: e.clock?.displayValue ?? '',
                icon,
                player: e.athletesInvolved?.[0]?.displayName ?? '',
                col,
                score,
                detail: keyEventDetail(e, icon),
            });
        }
        return rows.length ? rows : null;
    }
    // Per-team match stats, read straight off the adapted competitors (already
    // ordered as columns 0/1). possessionPct is already a percentage number and
    // just takes the suffix. (passPct isn't carried by /all, so it's omitted.)
    function matchStatRows(event: any): { label: string; c0: string; c1: string }[] | null {
        const s0 = event.competitors?.[0]?.statistics;
        const s1 = event.competitors?.[1]?.statistics;
        if (!s0 || !s1) return null;
        const stat = (stats: any[], name: string): string | null =>
            stats.find((s: any) => s.name === name)?.displayValue ?? null;
        const want = [
            { label: 'Possession', name: 'possessionPct', suffix: '%' },
            { label: 'Shots', name: 'totalShots', suffix: '' },
            { label: 'On target', name: 'shotsOnTarget', suffix: '' },
            { label: 'Corners', name: 'wonCorners', suffix: '' },
            { label: 'Fouls', name: 'foulsCommitted', suffix: '' },
        ];
        const fmt = (v: string | null, w: any): string => {
            if (v == null) return '–';
            if (w.fraction) return Math.round(parseFloat(v) * 100) + '%';
            return v + (w.suffix ?? '');
        };
        const rows = want
            .map((w) => {
                const a = stat(s0, w.name);
                const b = stat(s1, w.name);
                if (a == null && b == null) return null;
                return { label: w.label, c0: fmt(a, w), c1: fmt(b, w) };
            })
            .filter(Boolean) as { label: string; c0: string; c1: string }[];
        return rows.length ? rows : null;
    }

    // How evenly matched the two sides are by GFR/FIFA `strength` (0..1, normalized
    // upstream so the club and national scales are comparable): ~1 when the two
    // strengths are equal (a toss-up), ~0 for a lopsided mismatch. Requires both
    // teams to be ranked — two unranked sides aren't a known toss-up, just unknown.
    // (Previously read off the betting market, but /all drops odds at full-time, so
    // a game's score would fall the moment it finished; rankings are state-stable.)
    function competitiveness(event: any, ranks: Record<string, { strength: number }>): number {
        const r = (event.competitors ?? []).map((c: any) => ranks[String(c?.id)]);
        if (r.length < 2 || !r[0] || !r[1]) return 0;
        return Math.max(0, 1 - Math.abs(r[0].strength - r[1].strength));
    }
    // Extra interest from the competition stage (knockout rounds matter more).
    // Order matters: "semifinal"/"quarterfinal" contain "final", and "round of
    // 16/32" contains "round", so check the specific cases first.
    function stageBonus(event: any, league: any): number {
        const stage = (eventStage(event, league) ?? '').toLowerCase();
        if (!stage) return 0;
        if (stage.includes('semi')) return 12;
        if (stage.includes('quarter')) return 8;
        if (stage.includes('round of')) return 8;
        if (stage.includes('final')) return 15;
        if (stage.includes('playoff') || stage.includes('knockout')) return 5;
        return 0;
    }
    // Bonus for a clash of two strong sides by GFR power rating (clubs) / FIFA
    // points (national teams), normalized to a 0..1 `strength` upstream in +page.ts
    // (so the differing scales are already comparable). Blends the two: weighted
    // toward the *weaker* side so a genuine clash of elites scores highest, with
    // partial credit when only one team is a standout. Replaces the old flat
    // topmatch bonus; tops out at TEAMSTRENGTH_MAX. (Carries the 10 points the
    // dropped top-table-clash bonus used to contribute — /all has no table rank.)
    const TEAMSTRENGTH_MAX = 35;
    const STRENGTH_BLEND_ALPHA = 0.6;
    function teamStrengthBonus(event: any, ranks: Record<string, { strength: number }>): number {
        const s = (event.competitors ?? []).map((c: any) => ranks[String(c?.id)]?.strength ?? 0);
        if (s.length < 2) return 0;
        const blend = STRENGTH_BLEND_ALPHA * Math.min(s[0], s[1]) + (1 - STRENGTH_BLEND_ALPHA) * Math.max(s[0], s[1]);
        return TEAMSTRENGTH_MAX * blend;
    }
    // League base comes from a league's rank in ESPN's master prominence list
    // (slug -> rank, baked by the scraper into league_order.json). A fixed step
    // keeps a league worth the same day to day. The master list has ~244 leagues,
    // so with step 1.0 only roughly the top 50 get a positive base; everything
    // below floors to 0 and is differentiated by topmatch/competitiveness/etc.
    const LEAGUE_TOP = 50;
    const LEAGUE_STEP = 1.0;
    // Rank for leagues not found in the master list (e.g. map unavailable for one
    // slug): treat as long-tail so they floor to 0 rather than inheriting a small
    // per-day index.
    const LEAGUE_MISSING_RANK = 100;
    // Per-game interest score (higher = more compelling). Combines a league base
    // (from ESPN's master prominence list), a GFR/FIFA team-strength bonus, a
    // ranking-based competitiveness (how evenly matched), stage stakes, and ESPN
    // coverage prominence. (The livesoccertv topmatch flag no longer feeds the
    // score — it survives only as the ⭐ UI marker.) Weights are easy to tune.
    function interestScore(event: any, league: any, leagueIndex: number, leagueRank: Record<string, number>, ranks: Record<string, { strength: number }>): number {
        const hasMap = leagueRank && Object.keys(leagueRank).length > 0;
        // Fall back to the per-day index only if the whole map failed to load.
        const rank = hasMap ? (leagueRank[league.slug] ?? LEAGUE_MISSING_RANK) : leagueIndex;
        const leagueBase = Math.max(0, LEAGUE_TOP - rank * LEAGUE_STEP);
        const teamStrength = teamStrengthBonus(event, ranks);
        const competitive = competitiveness(event, ranks) * 15;
        const stage = stageBonus(event, league);
        let prominence = 0;
        if (event.onWatch) prominence += 5;
        if ((event.broadcasts ?? []).some((b: any) => b.isNational)) prominence += 3;
        return leagueBase + teamStrength + competitive + stage + prominence;
    }
</script>

{#snippet gameEntry(event: any, league: any)}
    {@const r0 = rankOf(event.competitors[0])}
    {@const r1 = rankOf(event.competitors[1])}
    <div class=gameLine>
        <button class="matchup" onclick={() => showInfo(event, league)} title="More info">
            <span class={`teamGroup teamGroup0${narrowScreen ? ' teamGroupNarrow' : ''}`}>
                <span class={`teamRank${r0?.intl ? ' teamRankIntl' : ''}`} title={r0 ? (r0.intl ? 'FIFA national rank' : 'GFR club grade') : ''}>{r0 ? (r0.intl ? `${r0.rank}` : (r0.grade ?? '')) : ''}</span>
                <span class="teamName">{event.competitors[0][narrowScreen ? 'abbreviation' : 'name']}</span>
            </span>
            <img class=teamLogo alt="" src={event.competitors[0][`logo${mode === 'dark' ? 'Dark' : ''}`]}/>
            <span class=betweenTeams>{
                event.status === 'pre' ? (
                    'vs'
                ) : `${event.competitors[0].score}-${event.competitors[1].score}`
            }</span>
            <img class=teamLogo alt="" src={event.competitors[1].logo}/>
            <span class={`teamGroup teamGroup1${narrowScreen ? ' teamGroupNarrow' : ''}`}>
                <span class="teamName">{event.competitors[1][narrowScreen ? 'abbreviation' : 'name']}</span>
                <span class={`teamRank${r1?.intl ? ' teamRankIntl' : ''}`} title={r1 ? (r1.intl ? 'FIFA national rank' : 'GFR club grade') : ''}>{r1 ? (r1.intl ? `${r1.rank}` : (r1.grade ?? '')) : ''}</span>
            </span>
        </button>
        <span class={`when${event.status === 'in' ? ' whenLive' : ''}`}>{#if event.status === 'in'}<span class="live-dot" title="in progress"></span>{/if}{
            event.status === 'pre' ? (
                new Date(event.date).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true})
                    .replace(' AM', 'am').replace(' PM', 'pm')
            ) : event.summary
        }</span>
        <span class={`interest-score${event.topmatch ? ' interest-score-top' : ''}`} title={event.topmatch ? 'interest score · livesoccertv top match' : 'interest score'}>{Math.round(event.interest ?? 0)}</span>
        <span class="broadcast">{event.bcstStr}</span>
        {#if event.lstv_matched}
            <a
                class="lstv-dot"
                href={`https://www.livesoccertv.com/schedules/${dt}/`}
                target="_blank"
                title="Matched with livesoccertv.com"
            >●</a>
        {/if}
    </div>
{/snippet}

{#snippet probRow(row: { label: string; logo: string | null; pct: number; color: string })}
    {@const trackWidth = Math.max(0, winbarsWidth - PROW_LABEL_OFFSET)}
    {@const fillWidth = (row.pct / 100) * trackWidth}
    <!-- Fit the "NN%" text inside the bar only when the fill is wide enough for
         it (roughly 7.5px/char plus padding); otherwise show it to the right. -->
    {@const inside = fillWidth >= `${row.pct}%`.length * 7.5 + 12}
    <div class="prow">
        <span class="prow-label">
            {#if row.logo}<img class="prow-logo" src={row.logo} alt=""/>{:else}<span class="prow-logo"></span>{/if}
            <span class="prow-name">{row.label}</span>
        </span>
        <div class="prow-track">
            <div class="prow-fill" style="width: {row.pct}%; background: {row.color}; {legibleText(row.color)}{needsBorder(row.color) ? `; border:1px solid ${barBorder}` : ''}">
                {#if inside}<span class="prow-pct">{row.pct}%</span>{/if}
            </div>
            {#if !inside}<span class="prow-pct-out">{row.pct}%</span>{/if}
        </div>
    </div>
{/snippet}

<hr>
<Accordion
    headerText={dtStr}
    headerStyle='font-weight:bold;font-size:1.9rem;margin-bottom:12pt;cursor:pointer;'
    bind:showContent={$accordionShow[dt]}
>
    <span slot=inlineAfter>
        <a
            class=linkAfter
            href={`https://www.livesoccertv.com/schedules/${dt}`}
            target=_blank
        >📺</a>
    </span>
    <div class=spacing></div>
    {#await dayData}
        Loading games...
    {:then}
        {#if numToShow > 0}
            {#if sortMode === 'time' || sortMode === 'interest'}
                {@const list = sortMode === 'interest' ? flatEventsByInterest : flatEvents}
                {#each list as { event, league }, i}
                    <div class="timeGameGroup">
                        {#if i === 0 || list[i - 1].league.name !== league.name}
                            <div class="leagueName" class:narrowLeague={narrowScreen}><span>{league.name}</span></div>
                        {/if}
                        {@render gameEntry(event, league)}
                    </div>
                {/each}
            {:else}
                {#each leagueData as league}
                    {#if league.numToShow > 0}
                        <Accordion
                            headerText={league.name}
                            headerStyle='font-weight:bold;font-size:1.6rem;cursor:pointer;'
                            bind:showContent={$accordionShow[dt + '-' + league.name]}
                        >
                            <span slot=inlineAfter>
                                <a class=linkAfter target=_blank href={`https://www.google.com/search?q=${league.name}`}>🔎</a>
                            </span>
                            {#each league.events as event}
                                {#if event.show}
                                    {@render gameEntry(event, league)}
                                {/if}
                            {/each}
                        </Accordion>
                    {/if}
                {/each}
            {/if}
        {:else}
            <div class=noShow>No games for this date</div>
        {/if}
    {/await}
    <div class=spacing></div>
</Accordion>

{#snippet modalTeam(comp: any)}
    {@const link = teamLink(comp)}
    {@const rk = rankOf(comp)}
    <div class="modal-team">
        <img class="modal-logo" src={comp[`logo${mode === 'dark' ? 'Dark' : ''}`]} alt=""/>
        <div class="modal-team-info">
            {#if link}
                <a class="modal-team-link" href={link} target="_blank"><strong>{comp.name}</strong></a>
            {:else}
                <strong>{comp.name}</strong>
            {/if}
            {#if rk}
                <a class="modal-gfr" href={rk.url} target="_blank">
                    {rk.intl ? 'FIFA Rank' : 'GFR Club Rank'}: {rk.rank} ({Math.round(rk.points)} Points) ↗
                </a>
            {/if}
        </div>
        {#if selectedEvent.status !== 'pre'}
            <span class="modal-score">{comp.score}</span>
        {/if}
    </div>
{/snippet}

{#if showInfoModal && selectedEvent}
<Modal bind:showModal={showInfoModal}>
    <div slot="header" class="modal-header">
        <div class="modal-meta">{selectedLeague.name} <a class="modal-league-link" href={`https://www.espn.com/soccer/league/_/name/${selectedLeague.slug}`} target="_blank">↗</a></div>
        {#if eventStage(selectedEvent, selectedLeague) || eventNote(selectedEvent)}
            <div class="modal-stage">{[eventStage(selectedEvent, selectedLeague), eventNote(selectedEvent)].filter(Boolean).join(' · ')}</div>
        {/if}
        {#if selectedEvent.status === 'in'}
            <div class="modal-live">● {selectedEvent.summary}</div>
        {/if}
        <div class="modal-teams">
            {@render modalTeam(selectedEvent.competitors[0])}
            {@render modalTeam(selectedEvent.competitors[1])}
        </div>
        <div class="modal-meta modal-datetime">{
            new Date(selectedEvent.date).toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'})
        } · {
            new Date(selectedEvent.date).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true}).replace(' AM', 'am').replace(' PM', 'pm')
        }{selectedEvent.status === 'post' ? ' · ' + selectedEvent.summary : ''}{#if selectedEvent.topmatch}<span class="modal-topmatch" title="livesoccertv top match">Top match</span>{/if}</div>
    </div>
    <div class="modal-body">
        {#if selectedEvent.location}
            <div class="modal-row">
                <span class="modal-label">Venue</span>
                <span>
                    {selectedEvent.location}{selectedEvent.neutralSite ? ' · neutral' : ''}
                    {#if venueAddress}<span class="venue-address"> · {venueAddress}</span>{/if}
                </span>
            </div>
        {/if}
        {#if winProbRows(selectedEvent, selectedEvent.odds)}
            {@const rows = winProbRows(selectedEvent, selectedEvent.odds)}
            <div class="modal-row modal-winprob-row">
                <span class="modal-label">Win %</span>
                <div class="winbars" bind:clientWidth={winbarsWidth}>
                    {#each rows ?? [] as row}
                        {@render probRow(row)}
                    {/each}
                </div>
            </div>
        {/if}
        {#if matchStats}
            <div class="modal-row">
                <span class="modal-label">Stats</span>
                <div class="statgrid">
                    <div class="stat-line stat-head">
                        <span class="stat-c0">{selectedEvent.competitors[0].abbreviation}</span>
                        <span class="stat-mid"></span>
                        <span class="stat-c1">{selectedEvent.competitors[1].abbreviation}</span>
                    </div>
                    {#each matchStats as s}
                        <div class="stat-line">
                            <span class="stat-c0">{s.c0}</span>
                            <span class="stat-mid">{s.label}</span>
                            <span class="stat-c1">{s.c1}</span>
                        </div>
                    {/each}
                </div>
            </div>
        {/if}
        {#if matchEvents}
            <div class="modal-row modal-timeline-row">
                <span class="modal-label">Events</span>
                <div class="timeline">
                    <div class="tl-side tl-left tl-head">{selectedEvent.competitors[0].abbreviation}</div>
                    <div class="tl-mid tl-head"></div>
                    <div class="tl-side tl-right tl-head">{selectedEvent.competitors[1].abbreviation}</div>
                    {#each matchEvents as ev, i}
                        <div class="tl-side tl-left">
                            {#if ev.col !== 1}
                                <button
                                    type="button"
                                    class="tl-trigger"
                                    class:active={openTips.has(i)}
                                    onclick={() => toggleTip(i)}
                                >
                                    <span class="tl-icon">{ev.icon}</span>
                                    <span class="tl-player">{ev.player}</span>
                                </button>
                            {/if}
                        </div>
                        <div class="tl-mid">
                            <span class="tl-clock">{ev.clock}</span>
                        </div>
                        <div class="tl-side tl-right">
                            {#if ev.col === 1}
                                <button
                                    type="button"
                                    class="tl-trigger tl-trigger-right"
                                    class:active={openTips.has(i)}
                                    onclick={() => toggleTip(i)}
                                >
                                    <span class="tl-player">{ev.player}</span>
                                    <span class="tl-icon">{ev.icon}</span>
                                </button>
                            {/if}
                        </div>
                        {#if openTips.has(i) && (ev.detail || ev.score)}
                            <div class="tl-detail">{#if ev.score}<strong class="tl-detail-score">{ev.score}</strong>{' '}{/if}{ev.detail}</div>
                        {/if}
                    {/each}
                </div>
            </div>
        {/if}
        {#if selectedEvent.competitors[0].form || selectedEvent.competitors[1].form}
            <div class="modal-row">
                <span class="modal-label">Form</span>
                <span class="modal-form">
                    <span class="form-team">
                        <span>{selectedEvent.competitors[0].abbreviation}</span>
                        {#each (selectedEvent.competitors[0].form ?? '').split('') as ch, i}<span class="fc-{ch}" style="font-size: {Math.max(0.62, 1 - i * 0.1)}em">{ch}</span>{/each}
                    </span>
                    <span class="form-team">
                        <span>{selectedEvent.competitors[1].abbreviation}</span>
                        {#each (selectedEvent.competitors[1].form ?? '').split('') as ch, i}<span class="fc-{ch}" style="font-size: {Math.max(0.62, 1 - i * 0.1)}em">{ch}</span>{/each}
                    </span>
                </span>
            </div>
        {/if}
        {#if selectedEvent.bcstStr}
            <div class="modal-row">
                <span class="modal-label">TV</span>
                <span>{selectedEvent.bcstStr}</span>
            </div>
        {/if}
    </div>
    <div slot="footer" class="modal-footer">
        <div class="modal-footer-links">
            {#if selectedEvent.link}
                <a href={selectedEvent.link} target="_blank">ESPN ↗</a>
            {/if}
            <a href={`https://www.google.com/search?q=${selectedEvent.competitors[0].name} vs ${selectedEvent.competitors[1].name} ${selectedLeague.name}`} target="_blank">Google ↗</a>
        </div>
        <button onclick={() => showInfoModal = false}>Close</button>
    </div>
</Modal>
{/if}

<style>
    .titleText {
        font-size: 2.1rem;
        font-weight: bold;
        margin-bottom: 12pt;
    }
    .spacing {
        height: 10pt;
    }
    .gameLine {
        height: 30px;
        display: flex;
        align-items: center;
    }
    .teamLogo {
        height: 30px;
        width: 30px;
        padding: 0 5px;
    }
    /* rank + name share a fixed-width group so the name hugs the logo while the
       rank sits beside it; the fixed width keeps logos column-aligned across rows. */
    .teamGroup {
        display: flex;
        align-items: center;
        gap: 3px;
        width: 116px;
        overflow: hidden;
    }
    .teamGroupNarrow {
        width: 71px;
    }
    .teamGroup0 {
        justify-content: flex-end;   /* name hugs the logo on its right; rank to its left */
    }
    .teamGroup1 {
        justify-content: flex-start; /* name hugs the logo on its left; rank to its right */
    }
    .teamName {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        min-width: 0;       /* allow the name to shrink → it (not the rank) ellipsizes */
        flex: 0 1 auto;
    }
    /* TEMP: rank label beside each team name. Club ranks (blue) vs FIFA national
       ranks (green) use different colors since the two scales aren't comparable. */
    .teamRank {
        flex: 0 0 auto;     /* never shrink → rank/grade stays fully visible */
        text-align: center;
        font-size: 0.6rem;
        font-weight: bold;
        color: light-dark(#1565c0, #64b5f6);
    }
    .teamRankIntl {
        color: light-dark(#2e7d32, #81c784);
    }
    .betweenTeams {
        width: 30px;
        text-align: center;
    }
    .when {
        width: 60px;
        padding: 0 10px;
    }
    .whenLive {
        display: inline-flex;
        align-items: center;
        color: light-dark(#d32f2f, #ef5350);
        font-weight: 600;
    }
    .live-dot {
        display: inline-block;
        width: 7px;
        height: 7px;
        margin-right: 4px;
        border-radius: 50%;
        background: light-dark(#d32f2f, #ef5350);
        vertical-align: middle;
        animation: livePulse 5s ease-in-out infinite;
    }
    @keyframes livePulse {
        0%, 65% { opacity: 1; }
        82% { opacity: 0.15; }
        100% { opacity: 1; }
    }
    @media (prefers-reduced-motion: reduce) {
        .live-dot { animation: none; }
    }
    .broadcast {
        margin-left: 10px;
        white-space: nowrap;
    }
    .interest-score {
        margin-left: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 600;
        background: rgba(128, 128, 128, 0.2);
        opacity: 0.8;
        flex-shrink: 0;
    }
    /* Top matches (livesoccertv topmatch) get a gold interest-score badge. */
    .interest-score-top {
        background: light-dark(#ffd24d, #b8860b);
        color: light-dark(#000, #fff);
        opacity: 1;
    }
    .timeGameGroup {
        margin-top: 3px;
    }
    .timeGameGroup:first-child {
        margin-top: 0;
    }
    .leagueName {
        display: flex;
    }
    .narrowLeague::before {
        width: 120px;
    }
    .leagueName span {
        font-size: 0.75rem;
        opacity: 0.6;
        white-space: nowrap;
        font-weight: bold;
    }
    .lstv-dot {
        font-size: 0.55rem;
        opacity: 0.4;
        margin-left: 5px;
        text-decoration: none;
        vertical-align: middle;
        flex-shrink: 0;
    }
    .lstv-dot:hover {
        opacity: 0.9;
    }
    .matchup {
        display: flex;
        align-items: center;
        background: none;
        border: none;
        padding: 1px 4px;
        margin: 0 -4px;        /* cancel the padding so column alignment is unchanged */
        color: inherit;
        font: inherit;
        cursor: pointer;
        border-radius: 4px;
        box-shadow: none;
        -webkit-tap-highlight-color: transparent;
    }
    .matchup:hover {
        background-color: rgba(128, 128, 128, 0.12);
    }
    .modal-meta {
        font-size: 1rem;
        opacity: 0.6;
    }
    .modal-stage {
        font-size: 0.9rem;
        opacity: 0.75;
        margin-top: 2px;
    }
    .modal-league-link {
        color: light-dark(#0066cc, #4da6ff);
        text-decoration: none;
        margin-left: 3px;
    }
    .modal-league-link:hover {
        text-decoration: underline;
    }
    .modal-datetime {
        margin-top: 8px;
    }
    .modal-topmatch {
        margin-left: 8px;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 700;
        background: light-dark(#ffd24d, #b8860b);
        color: light-dark(#000, #fff);
        white-space: nowrap;
    }
    .modal-live {
        margin-top: 4px;
        margin-bottom: 4px;
        font-size: 1.1rem;
        font-weight: bold;
        color: #c33;
    }
    .modal-teams {
        display: flex;
        flex-direction: column;
        gap: 1px;
        font-size: 1.2rem;
        margin-top: 6px;
    }
    .modal-team {
        display: flex;
        align-items: center;
        gap: 12px;
    }
    .modal-logo {
        height: 48px;
        width: 48px;
        flex-shrink: 0;
    }
    .modal-team strong,
    .modal-team-link {
        width: 8em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .modal-team-link {
        color: inherit;
        text-decoration: none;
    }
    .modal-team-link:hover {
        text-decoration: underline;
    }
    .modal-team-info {
        display: flex;
        flex-direction: column;
        gap: 1px;
        min-width: 0;
    }
    .modal-gfr {
        font-size: 0.7rem;
        opacity: 0.6;
        color: inherit;
        text-decoration: none;
        white-space: nowrap;
    }
    .modal-gfr:hover {
        text-decoration: underline;
    }
    .modal-score {
        font-size: 1.4rem;
        font-weight: bold;
    }
    .venue-address {
        opacity: 0.7;
    }
    .modal-header {
        padding-bottom: 4px;
        border-bottom: 1pt solid lightgray;
    }
    .modal-body {
        display: flex;
        flex-direction: column;
        gap: 12px;
        padding: 16px 0 8px;
        font-size: 1.05rem;
    }
    .modal-row {
        display: flex;
        gap: 14px;
        align-items: baseline;
    }
    .modal-row + .modal-row {
        border-top: 1px solid rgba(128, 128, 128, 0.2);
        padding-top: 12px;
    }
    .modal-label {
        width: 58px;
        flex-shrink: 0;
        font-size: 0.82rem;
        opacity: 0.55;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .modal-winprob-row {
        align-items: flex-start;
    }
    .winbars {
        flex: 1;
        display: flex;
        flex-direction: column;
        gap: 5px;
        min-width: 0;
    }
    .prow {
        display: flex;
        align-items: center;
        gap: 8px;
    }
    .prow-label {
        width: 58px;
        flex-shrink: 0;
        display: flex;
        align-items: center;
        gap: 4px;
        font-size: 0.8rem;
        font-weight: 600;
    }
    .prow-logo {
        width: 16px;
        height: 16px;
        flex-shrink: 0;
        object-fit: contain;
    }
    .prow-name {
        overflow: hidden;
        white-space: nowrap;
        text-overflow: ellipsis;
    }
    .prow-track {
        flex: 1;
        display: flex;
        align-items: center;
        min-width: 0;
    }
    .prow-fill {
        height: 18px;
        flex-shrink: 0;
        min-width: 2px;
        box-sizing: border-box;
        border-radius: 3px;
        display: flex;
        align-items: center;
        justify-content: flex-end;
        font-size: 0.7rem;
        font-weight: 600;
    }
    .prow-pct {
        padding: 0 5px;
    }
    .prow-pct-out {
        padding-left: 5px;
        font-size: 0.7rem;
        font-weight: 600;
        opacity: 0.85;
        white-space: nowrap;
    }
    .modal-form {
        display: flex;
        gap: 16px;
    }
    .form-team {
        display: flex;
        gap: 3px;
        align-items: baseline;
    }
    .form-team > :first-child {
        margin-right: 3px;
        opacity: 0.7;
        font-size: 0.85em;
    }
    .statgrid {
        flex: 1;
        max-width: 240px;
        display: flex;
        flex-direction: column;
        gap: 4px;
        min-width: 0;
    }
    .stat-line {
        display: grid;
        grid-template-columns: 3.5em 1fr 3.5em;
        align-items: baseline;
        font-size: 0.9rem;
    }
    .stat-c0 { text-align: left; font-weight: 600; }
    .stat-c1 { text-align: right; font-weight: 600; }
    .stat-mid { text-align: center; opacity: 0.7; }
    .stat-head {
        font-size: 0.75rem;
        opacity: 0.55;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .modal-timeline-row {
        align-items: flex-start;
    }
    .timeline {
        flex: 1;
        max-width: 340px;
        display: grid;
        grid-template-columns: 1fr auto 1fr;
        align-items: center;
        gap: 7px 10px;
        min-width: 0;
        font-size: 0.85rem;
        line-height: 1.3;
    }
    .tl-head {
        font-size: 0.75rem;
        font-weight: 600;
        opacity: 0.55;
        text-transform: uppercase;
        letter-spacing: 0.04em;
    }
    .tl-side {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
    }
    .tl-right {
        justify-content: flex-end;
        text-align: right;
    }
    .tl-player {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .tl-icon {
        flex-shrink: 0;
    }
    /* The icon + player name double as the tooltip trigger; strip the native
       button chrome so it reads like the surrounding text. */
    .tl-trigger {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
        max-width: 100%;
        background: none;
        border: none;
        padding: 1px 3px;
        margin: -1px 0;
        border-radius: 4px;
        color: inherit;
        font: inherit;
        text-align: left;
        cursor: pointer;
    }
    .tl-trigger-right {
        text-align: right;
    }
    .tl-trigger:hover,
    .tl-trigger.active {
        background: rgba(128, 128, 128, 0.18);
    }
    .tl-detail {
        grid-column: 1 / -1;
        margin-top: -2px;
        padding: 6px 9px;
        border-radius: 5px;
        background: rgba(128, 128, 128, 0.16);
        font-size: 0.8rem;
        line-height: 1.35;
        opacity: 0.9;
    }
    .tl-mid {
        display: flex;
        flex-direction: column;
        align-items: center;
        line-height: 1.1;
    }
    .tl-clock {
        opacity: 0.6;
        font-size: 0.8rem;
        font-variant-numeric: tabular-nums;
    }
    .tl-detail-score {
        font-variant-numeric: tabular-nums;
        font-size: 0.95rem;
        padding: 1px 6px;
        border-radius: 4px;
        background: rgba(128, 128, 128, 0.28);
        color: light-dark(#111, #fff);
    }
    .modal-footer {
        display: flex;
        justify-content: space-between;
        align-items: center;
    }
    .modal-footer-links {
        display: flex;
        gap: 12px;
    }
    .modal-footer a {
        text-decoration: none;
    }
    .modal-footer a:hover {
        text-decoration: underline;
    }
    .fc-W { color: #4a4; }
    .fc-L { color: #c44; }
    .fc-D { opacity: 0.55; }
    .noShow {
        font-style: italic;
    }
    .linkAfter {
        margin-left: 0.5rem;
        text-decoration: none;
    }
</style>

