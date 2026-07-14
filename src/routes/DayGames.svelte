<script lang="ts">
    import { goodBcsts, bcstCountsByDay, windowInfo, accordionShow, filterInterest, minInterest } from "$lib/stores";
    import { canonicalBcst } from "$lib/broadcasters";
    import Accordion from "./Accordion.svelte";
    import Modal from "./Modal.svelte";
    import { fetchStandings, type Standings } from "$lib/standings";
    import { fetchBracket, layoutBracket, rowsForAnchor, type Bracket, type BracketTreeLayout } from "$lib/bracket";
    import { tick } from "svelte";

    let { dayData, dt, hideIfNoLive = false, goodStatuses, filterBroadcasts, broadcasts, leagueOrder, teamRanks, sortMode } = $props();

    // Yesterday is fetched/bucketed like any other day, but only worth showing
    // once it's fully out of the display window while a game is still live (a
    // late kickoff that ran past local midnight) — otherwise it'd resurrect
    // finished games from the day before every morning. Starts hidden (rather
    // than flashing "Loading games...") and only reveals once the data proves
    // there's a live game, irrespective of the user's status/broadcast filters.
    let hideDay = $state(hideIfNoLive);

    // GFR data by ESPN team id ({ rank, intl, strength }). `rank` drives the inline
    // labels below; `strength` (0..1, normalized upstream in +page.ts) feeds the
    // interest score. intl=true means a FIFA national team (different scale, already
    // normalized). Populated from the resolved map in the main effect below.
    let teamRankMap = $state<Record<string, { rank: number; intl: boolean; strength: number; points: number; url: string; grade?: string | null }>>({});
    const rankOf = (c: any) => teamRankMap[String(c?.id)] ?? null;
    // Resolved livesoccertv games, stashed from the main effect so bracket games
    // (which skip the day-list merge) can still pick up their supplemental TV.
    let lstvGames = $state<any[]>([]);

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
    let loaded = $state(false);
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
        // Read these synchronously so the effect tracks them as dependencies and
        // re-runs when the slider moves — reads inside the async .then() below are
        // not tracked by Svelte.
        const interestOn = $filterInterest;
        const interestMin = Number($minInterest);
        const selectedBcsts = $goodBcsts;
        Promise.all([dayData, broadcasts, leagueOrder, teamRanks]).then(([d, bcstData, leagueRank, ranks]) => {
            const wstGames = bcstData?.games ?? [];
            lstvGames = wstGames;
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
            // Per-canonical-broadcaster game counts for this day, feeding the
            // picker's count badges. Written once at the end (idempotent re-run).
            const dayCounts: Record<string, number> = {};
            for (const [leagueIndex, league] of leagueData.entries()) {
                league.numToShow = 0;
                for (const event of league.events) {
                    event.bcstsToShow = [];
                    event.show = false;
                    // All canonical broadcasters for this event (ESPN + livesoccertv),
                    // independent of the user's filter — drives the availability counts.
                    const eventBcsts = new Set<string>();

                    // ESPN broadcasts (already canonical from +page.ts)
                    for (const bcst of event.broadcasts || []) {
                        eventBcsts.add(bcst.name);
                        if (!filterBroadcasts || selectedBcsts.includes(bcst.name)) {
                            if (!event.bcstsToShow.includes(bcst.name)) event.bcstsToShow.push(bcst.name)
                        }
                    }

                    // Additional broadcasts from livesoccertv.com
                    const wstGame = findLstvGame(event, wstGames);
                    event.lstv_matched = !!wstGame;
                    event.topmatch = wstGame?.topmatch ?? false;
                    const scored = interestScore(event, league, leagueIndex, leagueRank, ranks ?? {});
                    event.interest = scored.total;
                    event.interestParts = scored.parts;
                    if (wstGame) {
                        for (const raw of wstGame.broadcasts) {
                            const bcst = canonicalBcst(raw);
                            eventBcsts.add(bcst);
                            if (!event.bcstsToShow.includes(bcst)) {
                                if (!filterBroadcasts || selectedBcsts.includes(bcst)) {
                                    event.bcstsToShow.push(bcst);
                                }
                            }
                        }
                    }

                    // Count availability among still-watchable (upcoming/live) games.
                    if (event.status === 'pre' || event.status === 'in') {
                        for (const name of eventBcsts) dayCounts[name] = (dayCounts[name] ?? 0) + 1;
                    }

                    event.bcstStr = event.bcstsToShow.join('/');
                    // De-emphasize networks the user hasn't picked. When no
                    // networks are selected, nothing is dimmed (all are "good").
                    event.bcstParts = event.bcstsToShow.map((name: string) => ({
                        name,
                        good: selectedBcsts.length === 0 || selectedBcsts.includes(name),
                    }));
                    if (!filterBroadcasts || event.bcstsToShow.length > 0) {
                        if (goodStatuses.includes(event.status)) {
                            if (!interestOn || (event.interest ?? 0) >= interestMin) {
                                numToShow += 1;
                                league.numToShow += 1;
                                event.show = true;
                            }
                        }
                    }
                }
            }
            bcstCountsByDay.update((m) => ({ ...m, [dt]: dayCounts }));
            for (const ld of leagueData) {
                if (!Object.keys($accordionShow).includes(dt + '-' + ld.name)) {
                    $accordionShow[dt + '-' + ld.name] = true;
                }
            }
            if (hideIfNoLive) {
                hideDay = !leagueData.some((lg: any) => lg.events.some((e: any) => e.status === 'in'));
            }
            loaded = true;
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
    // Light/dark follows the OS preference: the app declares `color-scheme: light
    // dark` and paints the body with light-dark(#fafafa, #212121) — there's no
    // in-app toggle. Read the preference directly rather than sniffing the
    // rendered body background. In production the bundled stylesheet can still be
    // unapplied when this runs, so getComputedStyle reports the default
    // transparent background and mis-detects dark mode — which then drops the
    // border on bars that are actually near the (light) background.
    const prefersDark = typeof window !== 'undefined'
        && !!window.matchMedia?.('(prefers-color-scheme: dark)').matches;
    let mode = prefersDark ? 'dark' : 'light';
    // Page background as hex (mirrors the light-dark() values in +page.svelte),
    // used to detect bars that would blend into it.
    const bgHex = mode === 'dark' ? '212121' : 'fafafa';
    // Border color for bars that are too close to the background.
    const barBorder = mode === 'light' ? 'rgba(0,0,0,0.35)' : 'rgba(255,255,255,0.45)';

    let selectedEvent = $state<any>(null);
    let selectedLeague = $state<any>(null);
    let showInfoModal = $state(false);
    // True when the game modal was opened from a bracket card (footer reads
    // "Back" and returns to the still-open standings/bracket modal underneath).
    let infoFromStandings = $state(false);
    // Interest-score breakdown modal (opened by clicking a game's score badge).
    let scoreEvent = $state<any>(null);
    let scoreLeague = $state<any>(null);
    let showScoreModal = $state(false);
    function showScore(event: any, league: any) {
        scoreEvent = event;
        scoreLeague = league;
        showScoreModal = true;
    }
    // Competition standings modal (opened by a league's 📊 trigger). Fetched
    // on demand and cached per session; null means no table (knockout cups).
    let standingsLeague = $state<any>(null);
    let standingsData = $state<Standings | null>(null);
    let standingsLoading = $state(false);
    let showStandingsModal = $state(false);
    // Knockout bracket for the same competition, fetched after standings (it needs
    // the season window from the standings response). null = no knockout rounds.
    let bracketData = $state<Bracket | null>(null);
    let bracketLoading = $state(false);
    // Tree layout (col/row per match + feeder edges) when the bracket has feeder
    // links; null falls back to the plain date-ordered columns.
    let bracketTree = $derived(bracketData ? layoutBracket(bracketData) : null);
    // Wide brackets collapse the rounds you've scrolled past into thin rails on the
    // left; the leftmost still-expanded round (= nCollapsed) becomes the vertical
    // "anchor" the remaining rounds compact onto.
    let nCollapsed = $state(0);
    let btScrollLeft = $state(0); // mirrors the scroller's scrollLeft so the sticky header bar can track it
    let btScroller: HTMLElement | undefined;
    let btAdjusting = false; // suppress the scroll handler during our own scrollLeft fix
    let btDragging = $state(false);
    let btDragOrigin: { x: number; scrollLeft: number } | null = null;
    // Vertical positions re-anchored on the leftmost expanded round, so scrolling
    // toward the final stacks the visible rounds together instead of spreading them.
    let btRows = $derived(bracketTree ? rowsForAnchor(bracketTree, nCollapsed) : null);
    // Only collapse leading rounds big enough to spread the tree out (>4 matches);
    // a round of 4 or fewer is already compact, so anchoring on it buys nothing.
    let btMaxCollapse = $derived.by(() => {
        let n = 0;
        for (const r of bracketData?.rounds ?? []) {
            if (r.matches.length > 4) n++;
            else break;
        }
        return n;
    });
    // Active view when the competition has both a table and a bracket.
    let standingsTab = $state<'table' | 'bracket'>('table');
    // When opened from a game modal, the two team ids whose group to scroll to
    // and whose rows to highlight; null when opened from a league header.
    let standingsFocusIds = $state<Set<string> | null>(null);
    // The focused game's id, to highlight/scroll to its match in the bracket.
    let standingsFocusMatchId = $state<string | null>(null);
    // True when opened from a game modal (so the footer reads "Back", and a
    // backdrop dismiss also closes the game modal underneath).
    let standingsFromGame = $state(false);
    let groupEls: HTMLElement[] = [];
    let matchEls: Record<string, HTMLElement> = {};
    async function showStandings(league: any, focusEvent: any = null) {
        // If this game modal was opened from the standings/bracket modal (still
        // open underneath), the link back just returns to it — close the game
        // modal to bring it to the front, rather than re-opening it behind.
        if (infoFromStandings && showStandingsModal) {
            showInfoModal = false;
            infoFromStandings = false;
            return;
        }
        standingsLeague = league;
        standingsData = null;
        standingsLoading = true;
        bracketData = null;
        bracketLoading = false;
        standingsFromGame = !!focusEvent;
        standingsFocusIds = focusEvent
            ? new Set<string>(focusEvent.competitors.map((c: any) => String(c.id)))
            : null;
        standingsFocusMatchId = focusEvent?.id ?? null;
        nCollapsed = 0; // start every bracket fully expanded
        btScrollLeft = 0;
        cancelAnimationFrame(btRaf);
        btPose = {};
        btAnimT = 1;
        // A knockout game opens straight to the bracket; otherwise the table.
        const koGame = !!focusEvent && /round of|quarter|semi|\bfinal|knockout|playoff/i.test(focusEvent.group?.name ?? '');
        standingsTab = koGame ? 'bracket' : 'table';
        showStandingsModal = true;

        const d = await fetchStandings(league.slug);
        // Guard against a slower fetch landing after the user opened another league.
        if (standingsLeague?.slug !== league.slug) return;
        standingsData = d;
        standingsLoading = false;

        // Bracket fetch needs the season date window from the standings response.
        if (d?.season) {
            bracketLoading = true;
            const b = await fetchBracket(league.slug, d.season.startDate, d.season.endDate);
            if (standingsLeague?.slug !== league.slug) return;
            bracketData = b ? mergeBracket3rdPlace(b) : null;
            bracketLoading = false;
        }

        // Once knockout play is under way, a plain (league-header) open lands on the
        // bracket rather than the table. A knockout game already opens to the bracket;
        // a group game keeps its table focus.
        const koStarted = !!bracketData?.rounds.some((r) => r.matches.some((m) => m.state !== 'pre'));
        if (!focusEvent && koStarted) standingsTab = 'bracket';

        // Settle the active tab against what actually loaded.
        const hasTable = !!d?.groups.length;
        const hasBracket = !!bracketData?.rounds.length;
        if (standingsTab === 'bracket' && !hasBracket) standingsTab = 'table';
        else if (standingsTab === 'table' && !hasTable && hasBracket) standingsTab = 'bracket';

        // Scroll the focused group/match into view.
        await tick();
        if (standingsTab === 'table' && standingsFocusIds) {
            const idx = d!.groups.findIndex((g) => g.entries.some((e) => standingsFocusIds!.has(e.teamId)));
            if (idx > 0) scrollModalElementIntoView(groupEls[idx]);
        } else if (standingsTab === 'bracket' && standingsFocusMatchId) {
            // Clear the sticky round-name header (headerH + its margin/border) so the
            // focused card isn't tucked underneath it.
            scrollModalElementIntoView(matchEls[standingsFocusMatchId], BT.headerH + 15);
        }
    }
    // Scroll the modal's own scroll containers (vertical body and/or the bracket's
    // horizontal scroller) to reveal an element — never the page. (scrollIntoView
    // would also scroll the document, moving the whole page behind the modal.)
    function scrollModalElementIntoView(el: HTMLElement | undefined, topInset = 8) {
        if (!el) return;
        let c = el.parentElement;
        while (c && c !== document.body) {
            const cs = getComputedStyle(c);
            const sy = c.scrollHeight > c.clientHeight && /(auto|scroll)/.test(cs.overflowY);
            const sx = c.scrollWidth > c.clientWidth && /(auto|scroll)/.test(cs.overflowX);
            if (sx || sy) {
                const r = el.getBoundingClientRect();
                const rc = c.getBoundingClientRect();
                c.scrollTo({
                    top: sy ? r.top - rc.top + c.scrollTop - topInset : c.scrollTop,
                    left: sx ? r.left - rc.left + c.scrollLeft - 8 : c.scrollLeft,
                    behavior: 'smooth',
                });
            }
            c = c.parentElement;
        }
    }
    // Merge the 3rd-place round into the Final round so they share a column.
    // The final round is renamed "Final/3rd-Place" and its matches array gains the
    // 3rd-place match. The tree layout parks it at the bottom of the final column
    // since it has no resolved feeders, matching the user's desired placement.
    function mergeBracket3rdPlace(b: Bracket): Bracket {
        const thirdIdx = b.rounds.findIndex((r) => /3rd.?place|third.?place/i.test(r.slug));
        const finalIdx = b.rounds.findIndex((r) => r.slug === 'final');
        if (thirdIdx < 0 || finalIdx < 0) return b;
        const thirdRound = b.rounds[thirdIdx];
        return {
            ...b,
            rounds: b.rounds
                .filter((_, i) => i !== thirdIdx)
                .map((r) =>
                    r.slug === 'final'
                        ? { ...r, name: 'Final / 3rd Place', matches: [...r.matches, ...thirdRound.matches] }
                        : r,
                ),
        };
    }

    // Open a bracket card's match modal (over the still-open standings modal, so
    // its footer reads "Back"). Uses the standings competition as the league.
    // Bracket events skip the day-list merge loop, so compose their TV string
    // (ESPN's canonical broadcasts + livesoccertv supplementation) here, the same
    // way that loop does, plus livesoccertv's top-match flag.
    async function openBracketGame(m: any) {
        const ev = m.event;
        const names: string[] = [];
        for (const b of ev.broadcasts || []) if (!names.includes(b.name)) names.push(b.name);
        const lstv = findLstvGame(ev, lstvGames);
        if (lstv) {
            for (const raw of lstv.broadcasts) {
                const c = canonicalBcst(raw);
                if (!names.includes(c)) names.push(c);
            }
            ev.topmatch = ev.topmatch || !!lstv.topmatch;
        }
        ev.bcstStr = names.join('/');
        // If a game modal is already mounted, it's pinned behind the standings
        // modal we're inside (modals stack by mount order). Unmount it first so it
        // re-stacks on top when reopened with this game.
        if (showInfoModal) {
            showInfoModal = false;
            await tick();
        }
        showInfo(ev, standingsLeague, true);
    }
    function onBracketCardKey(e: KeyboardEvent, m: any) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            openBracketGame(m);
        }
    }
    // Bracket-tree geometry (px). cellW/H size a match card; the strides add the
    // gaps that connectors run through; headerH reserves the round-name row.
    // railW is the width an earlier round shrinks to once it's scrolled past.
    // railW must stay GREATER than btCollapseLead (below): the post-collapse scroll
    // position is railW − lead, and if that goes negative it clamps to 0 and the
    // hard-left safeguard re-expands the round (the "snap-back"). Wide rails keep it +.
    const BT = { cellW: 156, cellH: 74, colGap: 30, rowGap: 12, headerH: 19, railW: 60 };
    const btColStride = BT.cellW + BT.colGap;
    const btRowUnit = BT.cellH + BT.rowGap;
    // How early a leading round collapses to a rail: this much is added to the virtual
    // scroll position, so a round rails up once ~half its card has scrolled off the left
    // (rather than waiting until it's fully gone). Must stay below BT.railW (see above).
    const btCollapseLead = (BT.colGap + BT.cellW / 2) / 2;
    const btCellTop = (id: string) => (btRows?.row[id] ?? 0) * btRowUnit;
    // Left edge / card width of column `ci` for a given collapse count.
    const colLeftFor = (ci: number, nc: number) =>
        ci < nc ? ci * BT.railW : nc * BT.railW + (ci - nc) * btColStride;
    const colLeft = (ci: number) => colLeftFor(ci, nCollapsed);
    const colCardW = (ci: number) => (ci < nCollapsed ? BT.railW : BT.cellW);
    // Total drawn width for `cols` rounds at the current collapse state.
    const btTreeWidth = (cols: number) => (cols ? colLeft(cols - 1) + colCardW(cols - 1) : 0);

    // --- Card-movement animation -------------------------------------------
    // When a round collapses/expands, the rounds that *stay* expanded glide to their new
    // positions while the collapsing/expanding round itself just snaps. We snap scrollLeft
    // to its final value immediately (keeps the scroll trigger stable and never fights
    // momentum scrolling) and tween only the rendered card positions — the from-x carries
    // the scrollLeft delta so cards still start exactly where they appeared. Cards AND the
    // SVG connectors read the same tweened positions, so the lines stay attached.
    const lerp = (a: number, b: number, t: number) => a + (b - a) * t;
    const easeInOut = (t: number) => (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2);
    let btAnimT = $state(1); // 1 = settled (no animation in progress)
    let btAnimH = $state(0); // tallest layout spanned during the animation (so nothing clips)
    let btPose = $state<Record<string, { x0: number; y0: number; x1: number; y1: number }>>({});
    let btRaf = 0;
    const btEaseT = $derived(easeInOut(btAnimT));
    const btCardX = (id: string, ci: number) => {
        const p = btPose[id];
        return btAnimT < 1 && p ? lerp(p.x0, p.x1, btEaseT) : colLeft(ci);
    };
    const btCardY = (id: string) => {
        const p = btPose[id];
        return btAnimT < 1 && p ? lerp(p.y0, p.y1, btEaseT) : btCellTop(id);
    };
    function startBracketAnim(oldNC: number, newNC: number, fromSL: number, toSL: number) {
        cancelAnimationFrame(btRaf);
        const reduce = typeof matchMedia !== 'undefined' && matchMedia('(prefers-reduced-motion: reduce)').matches;
        if (!bracketTree || reduce) { btPose = {}; btAnimT = 1; btAdjusting = false; return; }
        const dxl = toSL - fromSL; // scroll snapped by this; from-x absorbs it so cards don't jolt
        const fromRows = rowsForAnchor(bracketTree, oldNC);
        const toRows = rowsForAnchor(bracketTree, newNC);
        const both = Math.max(oldNC, newNC); // only rounds expanded in both states glide
        const pose: Record<string, { x0: number; y0: number; x1: number; y1: number }> = {};
        let maxBottom = 0;
        (bracketData?.rounds ?? []).forEach((r, ci) => {
            if (ci < both) return;
            for (const m of r.matches) {
                const e = {
                    x0: colLeftFor(ci, oldNC) + dxl,
                    y0: (fromRows.row[m.id] ?? 0) * btRowUnit,
                    x1: colLeftFor(ci, newNC),
                    y1: (toRows.row[m.id] ?? 0) * btRowUnit,
                };
                pose[m.id] = e;
                maxBottom = Math.max(maxBottom, e.y0, e.y1);
            }
        });
        btPose = pose;
        btAnimH = maxBottom + BT.cellH;
        btAnimT = 0;
        const start = performance.now();
        const step = (now: number) => {
            btAnimT = Math.min(1, (now - start) / 240);
            if (btAnimT < 1) btRaf = requestAnimationFrame(step);
            else { btPose = {}; }
        };
        btRaf = requestAnimationFrame(step);
    }
    // Re-collapse / re-expand leading rounds as the user scrolls. We track a "virtual"
    // scroll position in the fully-expanded layout (invariant under relayout), pick how
    // many columns that puts off-screen, then compensate scrollLeft so nothing on screen
    // jumps. The virtual position is a fixed point of this map, so it can't oscillate.
    async function onBracketScroll() {
        if (!btScroller) return;
        btScrollLeft = btScroller.scrollLeft; // keep the sticky header bar aligned (always, even mid-adjust)
        if (btAdjusting) return;
        const cols = bracketData?.rounds.length ?? 0;
        if (!cols) return;
        const drift = btColStride - BT.railW; // px each collapse removes to the left
        // Collapsing shifts scrollLeft left, so the hard-left edge maps to a non-zero
        // virtual position — special-case it so scrolling fully left always restores the
        // first round (otherwise the hysteresis below strands it collapsed).
        const atLeft = btScroller.scrollLeft <= 1;
        const vScroll = btScroller.scrollLeft + nCollapsed * drift;
        // Bias the collapse decision earlier (see btCollapseLead); the compensation
        // below still uses the true vScroll, so nothing on screen jumps.
        const vEff = vScroll + btCollapseLead;
        let target = atLeft ? 0 : Math.floor(vEff / btColStride);
        // Hysteresis: don't re-expand the round we just passed until clearly back over it.
        if (!atLeft && target === nCollapsed - 1 && vEff > nCollapsed * btColStride - 40) target = nCollapsed;
        target = Math.max(0, Math.min(btMaxCollapse, target));
        if (target === nCollapsed) return;
        const oldNC = nCollapsed;
        const fromSL = btScroller.scrollLeft;
        nCollapsed = target;
        const toSL = atLeft ? 0 : vScroll - nCollapsed * drift;
        btAdjusting = true;
        await tick(); // let the new widths render before correcting scrollLeft
        if (btScroller) { btScroller.scrollLeft = toSL; btScrollLeft = toSL; }
        btAdjusting = false;
        startBracketAnim(oldNC, target, fromSL, toSL);
    }
    // Clicking a rail brings that round back into view as the leftmost expanded column.
    async function expandRound(ci: number) {
        if (!btScroller || ci === nCollapsed) return;
        const oldNC = nCollapsed;
        const fromSL = btScroller.scrollLeft;
        nCollapsed = ci;
        const toSL = ci * BT.railW;
        btAdjusting = true;
        await tick();
        if (btScroller) { btScroller.scrollLeft = toSL; btScrollLeft = toSL; }
        btAdjusting = false;
        startBracketAnim(oldNC, ci, fromSL, toSL);
    }
    function onRailKey(e: KeyboardEvent, ci: number) {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            expandRound(ci);
        }
    }
    function onBracketMouseDown(e: MouseEvent) {
        if (e.button !== 0 || !btScroller) return;
        const target = e.target as HTMLElement;
        if (target.closest('.bracket-card') || target.closest('.btree-rail')) return;
        // Find the nearest ancestor that scrolls vertically (the modal body).
        let vScroller: HTMLElement | null = btScroller.parentElement;
        while (vScroller && vScroller !== document.body) {
            const cs = getComputedStyle(vScroller);
            if (vScroller.scrollHeight > vScroller.clientHeight && /(auto|scroll)/.test(cs.overflowY)) break;
            vScroller = vScroller.parentElement;
        }
        if (vScroller === document.body) vScroller = null;
        btDragOrigin = { x: e.clientX, scrollLeft: btScroller.scrollLeft };
        const startY = e.clientY;
        const startScrollTop = vScroller?.scrollTop ?? 0;
        const onMove = (ev: MouseEvent) => {
            if (!btDragOrigin || !btScroller) return;
            const dx = ev.clientX - btDragOrigin.x;
            const dy = ev.clientY - startY;
            if (!btDragging && Math.hypot(dx, dy) > 4) btDragging = true;
            if (btDragging) {
                btScroller.scrollLeft = btDragOrigin.scrollLeft - dx;
                if (vScroller) vScroller.scrollTop = startScrollTop - dy;
            }
        };
        const onUp = () => {
            btDragOrigin = null;
            btDragging = false;
            document.removeEventListener('mousemove', onMove);
            document.removeEventListener('mouseup', onUp);
        };
        document.addEventListener('mousemove', onMove);
        document.addEventListener('mouseup', onUp);
    }
    // Elbow connector from a feeder card's right-center to its consumer's left-center.
    function btEdgePath(t: BracketTreeLayout, e: { from: string; to: string }): string {
        const fromX = btCardX(e.from, t.col[e.from]) + colCardW(t.col[e.from]);
        const fromY = btCardY(e.from) + BT.cellH / 2;
        const toX = btCardX(e.to, t.col[e.to]);
        const toY = btCardY(e.to) + BT.cellH / 2;
        const midX = (fromX + toX) / 2;
        return `M${fromX},${fromY} H${midX} V${toY} H${toX}`;
    }
    // Concise kickoff label for an upcoming bracket match, e.g. "Jul 4, 3:00pm".
    const fmtMatchDate = (iso: string) => {
        const d = new Date(iso);
        const day = d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
        const time = d.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true })
            .replace(' AM', 'am').replace(' PM', 'pm');
        return `${day}, ${time}`;
    };
    // Unique qualification colors/labels across all groups, in first-seen order
    // (top teams first), for the legend below the tables.
    let standingsLegend = $derived.by(() => {
        const seen = new Map<string, string>();
        for (const g of standingsData?.groups ?? [])
            for (const e of g.entries)
                if (e.note && !seen.has(e.note.description))
                    seen.set(e.note.description, e.note.color);
        return [...seen].map(([description, color]) => ({ description, color }));
    });
    let anyClinched = $derived(
        (standingsData?.groups ?? []).some((g) => g.entries.some((e) => e.clinched)),
    );
    // Teams with a points deduction, surfaced as a footnote under the table since
    // the deducted total in the Pts column otherwise looks like a math error.
    let standingsDeductions = $derived.by(() => {
        const out: { name: string; deduction: number }[] = [];
        for (const g of standingsData?.groups ?? [])
            for (const e of g.entries)
                if (e.deduction) out.push({ name: e.name, deduction: e.deduction });
        return out;
    });
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

    function showInfo(event: any, league: any, fromStandings = false) {
        selectedEvent = event;
        selectedLeague = league;
        infoFromStandings = fromStandings;
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
    // Women's competitions are de-emphasized: their league base is capped at
    // WOMEN_LEAGUE_CAP rather than dropped entirely, so a women's game never leads
    // on league prominence alone but can still surface via team strength /
    // competitiveness / stage. Per-slug exceptions pin the marquee women's
    // competitions to a fixed base above the cap. (Gender comes from ESPN's core
    // league endpoint, baked into league_order.json's `meta` by the scraper.)
    const WOMEN_LEAGUE_CAP = 15;
    const WOMEN_LEAGUE_BASE: Record<string, number> = {
        'fifa.wwc': 40,        // FIFA Women's World Cup
        'uefa.wchampions': 25, // UEFA Women's Champions League
    };
    // Drive the gradient badge fill with a two-segment ramp: gray (≤40) → yellow
    // (70) → green (100+). --t1 fades cold→mid over 40–70, --t2 fades mid→hot
    // over 70–100; the CSS nests two color-mixes so the midpoint is yellow.
    function interestRamp(score: number | undefined): string {
        const s = score ?? 0;
        const t1 = Math.max(0, Math.min(1, (s - 40) / 30));
        const t2 = Math.max(0, Math.min(1, (s - 70) / 30));
        return `--t1:${t1};--t2:${t2}`;
    }

    // Per-game interest score (higher = more compelling). Combines a league base
    // (from ESPN's master prominence list), a GFR/FIFA team-strength bonus, a
    // ranking-based competitiveness (how evenly matched), stage stakes, and ESPN
    // coverage prominence. (The livesoccertv topmatch flag no longer feeds the
    // score — it survives only as the ⭐ UI marker.) Weights are easy to tune.
    function interestScore(event: any, league: any, leagueIndex: number, leagueRank: Record<string, number>, ranks: Record<string, { strength: number }>): { total: number; parts: { label: string; value: number; detail?: string }[] } {
        const hasMap = leagueRank && Object.keys(leagueRank).length > 0;
        // Fall back to the per-day index only if the whole map failed to load.
        const rank = hasMap ? (leagueRank[league.slug] ?? LEAGUE_MISSING_RANK) : leagueIndex;
        let leagueBase = Math.max(0, LEAGUE_TOP - rank * LEAGUE_STEP);
        if (league.gender === 'women') {
            leagueBase = WOMEN_LEAGUE_BASE[league.slug] ?? Math.min(leagueBase, WOMEN_LEAGUE_CAP);
        }
        const teamStrength = teamStrengthBonus(event, ranks);
        const competitive = competitiveness(event, ranks) * 15;
        const stage = stageBonus(event, league);
        const onWatch = event.onWatch ? 5 : 0;
        const national = (event.broadcasts ?? []).some((b: any) => b.isNational) ? 3 : 0;
        const prominence = onWatch + national;
        // Per-component breakdown shown in the score modal; mirrors the sum below.
        const parts = [
            { label: 'League / competition', value: leagueBase, detail: league.name },
            { label: 'Team strength', value: teamStrength },
            { label: 'Competitiveness', value: competitive },
            { label: 'Stage', value: stage, detail: eventStage(event, league) ?? undefined },
            { label: 'Coverage', value: prominence, detail: [onWatch ? 'on watchlist' : '', national ? 'national broadcast' : ''].filter(Boolean).join(' · ') || undefined },
        ];
        return { total: leagueBase + teamStrength + competitive + stage + prominence, parts };
    }
</script>

{#snippet gameEntry(event: any, league: any)}
    {@const r0 = rankOf(event.competitors[0])}
    {@const r1 = rankOf(event.competitors[1])}
    <div class=gameLine>
        <button class="matchup" onclick={() => showInfo(event, league)} title="More info">
            <span class={`teamGroup teamGroup0${narrowScreen ? ' teamGroupNarrow' : ''}`}>
                <span class={`teamRank${r0?.intl ? ' teamRankIntl' : ''}`} title={r0 ? (r0.intl ? 'FIFA national rank' : 'GFR club grade') : ''}>{r0 ? (r0.intl ? `${r0.rank}` : (r0.grade ?? '')) : ''}</span>
                <span class={`teamName${event.status === 'post' && event.competitors[0].winner ? ' teamNameWin' : ''}`}>{event.competitors[0][narrowScreen ? 'abbreviation' : 'name']}</span>
            </span>
            <img class=teamLogo alt="" src={event.competitors[0][`logo${mode === 'dark' ? 'Dark' : ''}`]}/>
            <span class={`betweenTeams${event.status === 'in' ? ' betweenTeamsLive' : ''}`}>{
                event.status === 'pre' ? (
                    'vs'
                ) : `${event.competitors[0].score}-${event.competitors[1].score}`
            }</span>
            <img class=teamLogo alt="" src={event.competitors[1].logo}/>
            <span class={`teamGroup teamGroup1${narrowScreen ? ' teamGroupNarrow' : ''}`}>
                <span class={`teamName${event.status === 'post' && event.competitors[1].winner ? ' teamNameWin' : ''}`}>{event.competitors[1][narrowScreen ? 'abbreviation' : 'name']}</span>
                <span class={`teamRank${r1?.intl ? ' teamRankIntl' : ''}`} title={r1 ? (r1.intl ? 'FIFA national rank' : 'GFR club grade') : ''}>{r1 ? (r1.intl ? `${r1.rank}` : (r1.grade ?? '')) : ''}</span>
            </span>
        </button>
        <span class={`when${event.status === 'in' ? ' whenLive' : ''}`}>{#if event.status === 'in'}<span class="live-dot" title="in progress"></span>{/if}{
            event.status === 'pre' ? (
                new Date(event.date).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true})
                    .replace(' AM', 'am').replace(' PM', 'pm')
            ) : event.summary
        }</span>
        <button type="button" class={`interest-score${event.topmatch ? ' interest-score-top' : ''}`} style={interestRamp(event.interest)} onclick={() => showScore(event, league)} title={event.topmatch ? 'interest score · livesoccertv top match — click for breakdown' : 'interest score — click for breakdown'}>{Math.round(event.interest ?? 0)}</button>
        <span class="broadcast">{#each event.bcstParts ?? [] as part, i}{#if i > 0}<span class="bcst-sep">/</span>{/if}<span class={part.good ? '' : 'bcst-dim'}>{part.name}</span>{/each}</span>
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

{#if !hideDay}
<hr>
<Accordion
    headerText={dtStr}
    headerStyle='font-weight:bold;font-size:1.9rem;line-height:1;display:inline-block;margin-bottom:0;cursor:pointer;'
    bind:showContent={$accordionShow[dt]}
>
    <div class=dayLinks>
        <a
            class=linkAfter
            href={`https://www.espn.com/soccer/scoreboard/_/date/${dt.replaceAll('-', '')}`}
            target=_blank
        >ESPN ↗</a>
        <a
            class=linkAfter
            href={`https://www.livesoccertv.com/schedules/${dt}`}
            target=_blank
        >LSTV ↗</a>
    </div>
    <div class=spacing style="height:5pt"></div>
    {#if !loaded}
        Loading games...
    {:else}
        {#if numToShow > 0}
            {#if sortMode === 'time' || sortMode === 'interest'}
                {@const list = sortMode === 'interest' ? flatEventsByInterest : flatEvents}
                {#each list as { event, league }, i}
                    <div class="timeGameGroup">
                        {#if i === 0 || list[i - 1].league.name !== league.name}
                            <div class="leagueName" class:narrowLeague={narrowScreen}><span>{league.name}</span>{@render standingsBtn(league)}</div>
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
                            <span slot="inlineAfter">{@render standingsBtn(league)}</span>
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
    {/if}
    <div class=spacing></div>
</Accordion>
{/if}

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
            <span class="modal-score">{comp.score}{#if comp.shootoutScore != null}<span class="modal-pk" title="penalty shootout">({comp.shootoutScore})</span>{/if}</span>
        {/if}
    </div>
{/snippet}

{#if showInfoModal && selectedEvent}
<Modal bind:showModal={showInfoModal}>
    <div slot="header" class="modal-header">
        <div class="modal-meta">{selectedLeague.name} {@render standingsBtn(selectedLeague, selectedEvent)} <a class="modal-league-link" href={`https://www.espn.com/soccer/league/_/name/${selectedLeague.slug}`} target="_blank">ESPN ↗</a> <a class="modal-league-link" href={`https://www.google.com/search?q=${encodeURIComponent(selectedLeague.name)}`} target="_blank">Google ↗</a></div>
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
        <button onclick={() => { showInfoModal = false; infoFromStandings = false; }}>{infoFromStandings ? 'Back' : 'Close'}</button>
    </div>
</Modal>
{/if}

{#if showScoreModal && scoreEvent}
<Modal bind:showModal={showScoreModal}>
    <div slot="header" class="modal-header">
        <div class="modal-meta">{scoreLeague.name}</div>
        <div class="score-modal-title">{scoreEvent.competitors[0].name} vs {scoreEvent.competitors[1].name}</div>
        <div class="score-modal-total">Interest score: <strong>{Math.round(scoreEvent.interest ?? 0)}</strong></div>
    </div>
    <div class="modal-body">
        <div class="score-breakdown">
            {#each scoreEvent.interestParts ?? [] as part}
                <div class="score-part" class:score-part-zero={Math.round(part.value) === 0}>
                    <span class="score-part-label">
                        {part.label}
                        {#if part.detail}<span class="score-part-detail">{part.detail}</span>{/if}
                    </span>
                    <span class="score-part-value">+{Math.round(part.value)}</span>
                </div>
            {/each}
            <div class="score-part score-part-total">
                <span class="score-part-label">Total</span>
                <span class="score-part-value">{Math.round(scoreEvent.interest ?? 0)}</span>
            </div>
        </div>
    </div>
    <div slot="footer" class="modal-footer">
        <button onclick={() => showScoreModal = false}>Close</button>
    </div>
</Modal>
{/if}

{#snippet standingsBtn(league: any, focusEvent: any = null)}
    <button
        type="button"
        class="standings-btn"
        title="Standings"
        aria-label="Show {league.name} standings"
        onclick={(e) => { e.stopPropagation(); showStandings(league, focusEvent); }}
    >📊</button>
{/snippet}

{#if showStandingsModal && standingsLeague}
<Modal bind:showModal={showStandingsModal} onDismiss={() => { showInfoModal = false; showScoreModal = false; }}>
    <div slot="header" class="modal-header">
        <div class="modal-meta">{standingsLeague.name} <a class="modal-league-link" href={`https://www.espn.com/soccer/league/_/name/${standingsLeague.slug}/standings`} target="_blank">ESPN ↗</a> <a class="modal-league-link" href={`https://www.google.com/search?q=${encodeURIComponent(standingsLeague.name + ' standings')}`} target="_blank">Google ↗</a></div>
    </div>
    <div class="modal-body">
        {#if standingsLoading}
            <div class="standings-msg">Loading…</div>
        {:else}
            {@const hasTable = !!standingsData?.groups.length}
            {@const hasBracket = !!bracketData?.rounds.length}
            {#if hasTable && hasBracket}
                <div class="seg-toggle">
                    <button class:seg-active={standingsTab === 'table'} onclick={() => standingsTab = 'table'}>Table</button>
                    <button class:seg-active={standingsTab === 'bracket'} onclick={() => standingsTab = 'bracket'}>Bracket</button>
                </div>
            {/if}
            {#if standingsTab === 'bracket' && hasBracket}
                {@render bracketView()}
            {:else if hasTable}
                {@render tableView()}
            {:else if bracketLoading}
                <div class="standings-msg">Loading bracket…</div>
            {:else if hasBracket}
                {@render bracketView()}
            {:else}
                <div class="standings-msg">No standings or bracket available for this competition.</div>
            {/if}
        {/if}
    </div>
    <div slot="footer" class="modal-footer">
        <button style="margin-left:auto" onclick={() => showStandingsModal = false}>{standingsFromGame ? 'Back' : 'Close'}</button>
    </div>
</Modal>
{/if}

{#snippet tableView()}
    {#each standingsData?.groups ?? [] as group, gi}
        <div class="standings-group" bind:this={groupEls[gi]}>
        {#if (standingsData?.groups.length ?? 0) > 1 || group.name !== standingsLeague.name}
            <div class="standings-group-name">{group.name}</div>
        {/if}
        <table class="standings-table" class:standings-narrow={narrowScreen}>
            <thead>
                <tr>
                    <th class="st-rank">#</th>
                    <th class="st-team">Team</th>
                    <th>P</th>
                    <th>W</th>
                    <th>D</th>
                    <th>L</th>
                    {#if !narrowScreen}<th>GF</th><th>GA</th>{/if}
                    <th>GD</th>
                    <th class="st-pts">Pts</th>
                </tr>
            </thead>
            <tbody>
                {#each group.entries as row}
                    <tr class:st-focus-row={standingsFocusIds?.has(row.teamId)}>
                        <td class="st-rank">
                            {#if row.note}<span class="st-flag" style={`background:${row.note.color}`} title={row.note.description}></span>{/if}
                            {row.rank}
                        </td>
                        <td class="st-team">
                            <div class="st-team-inner">
                                <img class="st-logo" src={(mode === 'dark' ? row.logoDark : row.logo) ?? row.logo} alt=""/>
                                {#if row.link}
                                    <a class="st-name st-name-link" href={row.link} target="_blank">{narrowScreen ? row.abbrev : row.name}</a>
                                {:else}
                                    <span class="st-name">{narrowScreen ? row.abbrev : row.name}</span>
                                {/if}
                                {#if row.clinched}<span class="st-clinch" title="Clinched advancement">✓</span>{/if}
                            </div>
                        </td>
                        <td>{row.played}</td>
                        <td>{row.wins}</td>
                        <td>{row.draws}</td>
                        <td>{row.losses}</td>
                        {#if !narrowScreen}<td>{row.gf}</td><td>{row.ga}</td>{/if}
                        <td>{row.gd}</td>
                        <td class="st-pts">{row.points}{#if row.deduction}<sup class="st-ded" title={`Includes ${row.deduction}-point deduction`}>*</sup>{/if}</td>
                    </tr>
                {/each}
            </tbody>
        </table>
        </div>
    {/each}
    {#if standingsLegend.length || anyClinched}
        <div class="standings-legend">
            {#each standingsLegend as item}
                <span class="legend-item"><span class="legend-swatch" style={`background:${item.color}`}></span>{item.description}</span>
            {/each}
            {#if anyClinched}
                <span class="legend-item"><span class="st-clinch">✓</span>Clinched advancement</span>
            {/if}
        </div>
    {/if}
    {#if standingsDeductions.length}
        <div class="standings-footnote">
            {#each standingsDeductions as d}
                <div><span class="st-ded">*</span> {d.name}: {d.deduction}-point deduction</div>
            {/each}
        </div>
    {/if}
{/snippet}

{#snippet bracketTeam(t: any, showScore: boolean)}
    <div class="bk-team" class:bk-winner={t.winner}>
        {#if t.logo}
            <img class="bk-logo" src={mode === 'dark' ? t.logoDark : t.logo} alt=""/>
        {:else}
            <span class="bk-logo bk-logo-empty"></span>
        {/if}
        <!-- When we know the exact feeder game (a connector points to it), the verbose
             "Round of 32 5 Winner" is redundant, so just show "TBD". Placeholders we
             can't resolve by context (group finishers, feeder-less tournaments) keep
             their descriptive name. -->
        <span class="bk-name" class:bk-ph={t.placeholder}>{t.feedsFrom?.matchId ? 'TBD' : t.name}</span>
        {#if showScore}<span class="bk-score">{t.score}</span>{/if}
    </div>
{/snippet}

{#snippet bracketView()}
    {#if bracketTree}
        {@render bracketTreeView(bracketTree)}
    {:else}
        {@render bracketColumns()}
    {/if}
{/snippet}

<!-- Classic single-elimination tree: matches positioned by feeder edges, with
     SVG connectors from each feeder to the match it feeds. -->
{#snippet bracketTreeView(tree: BracketTreeLayout)}
    {@const cols = bracketData?.rounds.length ?? 0}
    {@const w = btTreeWidth(cols)}
    {@const rows = btRows ?? tree}
    <!-- Height of the lowest card's bottom, so parked matches (3rd-place sits below
         the tree at a fractional row) are fully contained — otherwise they overflow
         and the scroller sprouts a spurious second vertical scrollbar. -->
    {@const baseH = Math.max(0, ...Object.values(rows.row)) * btRowUnit + BT.cellH}
    <!-- While cards tween, keep the canvas as tall as the taller of the two layouts
         so nothing clips as rows compact/spread. -->
    {@const h = btAnimT < 1 ? Math.max(baseH, btAnimH) : baseH}
    <div class="bracket-tree-wrap">
        <!-- Round names stay pinned to the top of the modal while you scroll down the
             bracket, and slide horizontally to track the bracket's own scroll. -->
        <div class="btree-header-bar" style="height:{BT.headerH}px">
            <div class="btree-header-track" style="width:{w}px; transform:translateX({-btScrollLeft}px)">
                {#each bracketData?.rounds ?? [] as round, ci}
                    {#if ci >= nCollapsed}
                        <div class="bracket-round-name btree-header" style="left:{colLeft(ci)}px; width:{BT.cellW}px">{round.name}</div>
                    {/if}
                {/each}
            </div>
        </div>
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="bracket-tree-scroll" bind:this={btScroller} onscroll={onBracketScroll} onmousedown={onBracketMouseDown} class:bt-dragging={btDragging}>
            <div class="bracket-tree" style="width:{w}px; height:{h}px">
                <svg class="bracket-edges" width={w} height={h}>
                    <!-- Only edges between expanded rounds; rails draw no connectors. -->
                    {#each tree.edges.filter((e) => tree.col[e.from] >= nCollapsed) as e}
                        <path d={btEdgePath(tree, e)} />
                    {/each}
                </svg>
                {#each bracketData?.rounds ?? [] as round, ci}
                    {#if ci < nCollapsed}
                        <!-- Scrolled past: a thin rail; click to bring this round back. -->
                        <div class="btree-rail" style="left:{colLeft(ci)}px; width:{BT.railW}px; top:0; height:{h}px"
                             title="Show {round.name}" role="button" tabindex="0"
                             onclick={() => expandRound(ci)} onkeydown={(e) => onRailKey(e, ci)}>
                            <span class="btree-rail-label">{round.name}</span>
                        </div>
                    {:else}
                        {#each round.matches as m}
                            {@const showScore = m.state !== 'pre'}
                            <div class="bracket-match btree-cell bracket-card" class:bracket-focus={standingsFocusMatchId === m.id} class:bracket-live={m.state === 'in'} bind:this={matchEls[m.id]}
                                 style="left:{btCardX(m.id, ci)}px; top:{btCardY(m.id)}px; width:{BT.cellW}px; height:{BT.cellH}px"
                                 title={m.location ? (m.venue ? `${m.venue} · ${m.location}` : m.location) : null}
                                 role="button" tabindex="0" onclick={() => openBracketGame(m)} onkeydown={(e) => onBracketCardKey(e, m)}>
                                {@render bracketTeam(m.home, showScore)}
                                {@render bracketTeam(m.away, showScore)}
                                <div class="bracket-when">{m.state === 'pre' ? fmtMatchDate(m.date) : m.summary}</div>
                            </div>
                        {/each}
                    {/if}
                {/each}
            </div>
        </div>
    </div>
{/snippet}

<!-- Fallback when a tournament has no feeder edges: plain date-ordered columns. -->
{#snippet bracketColumns()}
    <div class="bracket">
        {#each bracketData?.rounds ?? [] as round}
            <div class="bracket-round">
                <div class="bracket-round-name">{round.name}</div>
                {#each round.matches as m}
                    {@const showScore = m.state !== 'pre'}
                    <div class="bracket-match bracket-card" class:bracket-focus={standingsFocusMatchId === m.id} class:bracket-live={m.state === 'in'} bind:this={matchEls[m.id]}
                         role="button" tabindex="0" onclick={() => openBracketGame(m)} onkeydown={(e) => onBracketCardKey(e, m)}>
                        {@render bracketTeam(m.home, showScore)}
                        {@render bracketTeam(m.away, showScore)}
                        <div class="bracket-when">{m.state === 'pre' ? fmtMatchDate(m.date) : m.summary}</div>
                        {#if m.location}
                            <div class="bracket-venue" title={m.venue ? `${m.venue} · ${m.location}` : m.location}>{m.location}</div>
                        {/if}
                    </div>
                {/each}
            </div>
        {/each}
    </div>
{/snippet}

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
    /* Finished game: the winning side's name is bolded. */
    .teamNameWin {
        font-weight: bold;
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
    .betweenTeamsLive {
        color: light-dark(#d32f2f, #ef5350);
        font-weight: 600;
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
    .broadcast .bcst-dim {
        opacity: 0.4;
    }
    .broadcast .bcst-sep {
        opacity: 0.4;
        margin: 0 1px;
    }
    .interest-score {
        position: relative;   /* anchors the top-match ★ marker */
        margin-left: 10px;
        padding: 1px 6px;
        border-radius: 4px;
        font-size: 0.75rem;
        font-weight: 600;
        /* Gradient fill: gray → yellow → green, driven by --t1 (cold→mid) and
           --t2 (mid→hot). Nesting the mixes puts the yellow midpoint at t1=1. */
        --cold: light-dark(#e8eef5, #2b333f);
        --mid: light-dark(#f2d544, #c9a227);
        --hot: light-dark(#2dc942, #2e8b40);
        background: color-mix(in oklab,
            color-mix(in oklab, var(--cold), var(--mid) calc(var(--t1, 0) * 100%)),
            var(--hot) calc(var(--t2, 0) * 100%));
        opacity: 1;
        flex-shrink: 0;
        /* It's a <button> now (opens the breakdown modal) — strip the defaults. */
        border: none;
        font-family: inherit;
        color: inherit;
        cursor: pointer;
    }
    .interest-score:hover {
        filter: brightness(1.1);
    }
    .score-modal-title {
        font-weight: bold;
        font-size: 1.2rem;
        margin: 4px 0;
    }
    .score-modal-total {
        opacity: 0.85;
    }
    .score-breakdown {
        display: flex;
        flex-direction: column;
        gap: 2px;
        min-width: 240px;
    }
    .score-part {
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 16px;
        padding: 5px 0;
        border-bottom: 1px solid rgba(128, 128, 128, 0.2);
    }
    .score-part-zero {
        opacity: 0.5;
    }
    .score-part-detail {
        margin-left: 6px;
        font-size: 0.8rem;
        opacity: 0.7;
    }
    .score-part-value {
        font-weight: 600;
        white-space: nowrap;
    }
    .score-part-total {
        border-bottom: none;
        border-top: 2px solid rgba(128, 128, 128, 0.4);
        margin-top: 4px;
        font-weight: bold;
        font-size: 1.1rem;
        opacity: 1;
    }
    /* Top matches (livesoccertv topmatch) keep the score gradient fill and get a
       small corner ★ — a shape marker, so it stays legible over any fill color. */
    .interest-score-top::after {
        content: "★";
        position: absolute;
        top: -6px;
        right: -5px;
        font-size: 0.6rem;
        color: light-dark(#eab308, #ffd24d);
        text-shadow: 0 0 2px light-dark(#fff, #000);
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
        font-size: 1.25rem;
        opacity: 0.8;
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
        font-size: 0.6em;
        opacity: 0.7;
    }
    .modal-league-link:hover {
        text-decoration: underline;
    }
    .modal-datetime {
        font-size: 1rem;
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
    /* Penalty-shootout tally shown beside the regulation score, e.g. 1 (4). */
    .modal-pk {
        font-size: 1.1rem;
        font-weight: normal;
        opacity: 0.7;
        margin-left: 2px;
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
    .dayLinks {
        margin-top: -2px;
    }
    .dayLinks .linkAfter:first-child {
        margin-left: 0;
    }
    .linkAfter {
        margin-left: 0.5rem;
        text-decoration: none;
        color: light-dark(#0066cc, #4da6ff);
        font-size: 0.7rem;
        font-weight: normal;
    }
    .linkAfter:hover {
        text-decoration: underline;
    }
    /* 📊 trigger shown next to any league/competition name. */
    .standings-btn {
        background: none;
        border: none;
        padding: 0 2px;
        margin-left: 5px;
        font-size: 0.85em;
        line-height: 1;
        cursor: pointer;
        opacity: 0.55;
        flex-shrink: 0;
        -webkit-tap-highlight-color: transparent;
    }
    .standings-btn:hover {
        opacity: 1;
    }
    .standings-msg {
        opacity: 0.7;
        padding: 8px 0;
    }
    /* Table / Bracket segmented toggle. */
    .seg-toggle {
        display: flex;
        gap: 4px;
        margin-bottom: 4px;
    }
    .seg-toggle button {
        flex: 1;
        padding: 5px 10px;
        font: inherit;
        font-size: 0.9rem;
        cursor: pointer;
        border: 1px solid rgba(128, 128, 128, 0.35);
        border-radius: 6px;
        background: none;
        color: inherit;
        opacity: 0.7;
    }
    .seg-toggle button.seg-active {
        background: rgba(128, 128, 128, 0.2);
        opacity: 1;
        font-weight: bold;
    }
    /* Bracket: horizontally-scrolling columns, one per knockout round. */
    .bracket {
        display: flex;
        gap: 14px;
        overflow-x: auto;
        padding-bottom: 6px;
        align-items: flex-start;
    }
    .bracket-round {
        display: flex;
        flex-direction: column;
        gap: 8px;
        flex: 0 0 auto;
        min-width: 150px;
    }
    .bracket-round-name {
        font-size: 0.72rem;
        text-transform: uppercase;
        font-weight: bold;
        opacity: 0.55;
        position: sticky;
        top: 0;
        background: light-dark(white, #444444);
        padding: 2px 0;
        z-index: 1;
    }
    .bracket-match {
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 6px;
        padding: 5px 7px;
        background: rgba(128, 128, 128, 0.06);
    }
    .bracket-match.bracket-focus {
        border-color: light-dark(#0066cc, #4da6ff);
        box-shadow: 0 0 0 1px light-dark(#0066cc, #4da6ff);
    }
    /* Whole card opens the match modal. */
    .bracket-card {
        cursor: pointer;
    }
    .bracket-card:hover {
        border-color: light-dark(#888, #aaa);
    }
    .bracket-card:focus-visible {
        outline: 2px solid light-dark(#0066cc, #4da6ff);
        outline-offset: 1px;
    }
    .bracket-live {
        border-left: 3px solid #d33;
    }
    /* Bracket tree: absolutely-positioned cards on an SVG connector layer.
       Geometry (left/top/width/height) is set inline from the computed layout. */
    .bracket-tree-wrap {
        position: relative;
    }
    /* Round-name strip that pins to the top of the modal's vertical scroll (sticky
       against Modal's `.body`) while the columns scroll under it. The inner track is
       translated horizontally to mirror the bracket's own horizontal scroll. */
    .btree-header-bar {
        position: sticky;
        top: 0;
        z-index: 5;
        overflow: hidden;
        background: light-dark(white, #444444);
        border-bottom: 1px solid rgba(128, 128, 128, 0.25);
        margin-bottom: 6px;
    }
    .btree-header-track {
        position: relative;
        height: 100%;
    }
    .bracket-tree-scroll {
        overflow-x: auto;
        /* Horizontal-only: the modal body owns vertical scrolling (the sticky header
           pins against it). Without this, `overflow-x: auto` makes `overflow-y`
           compute to `auto`, adding a second, competing vertical scrollbar. */
        overflow-y: hidden;
        padding-bottom: 6px;
        cursor: grab;
    }
    .bracket-tree-scroll.bt-dragging {
        cursor: grabbing;
        user-select: none;
    }
    .bracket-tree {
        position: relative;
    }
    .bracket-edges {
        position: absolute;
        top: 0;
        left: 0;
        pointer-events: none;
        overflow: visible;
    }
    .bracket-edges path {
        fill: none;
        stroke: rgba(128, 128, 128, 0.5);
        stroke-width: 1.5;
    }
    .btree-header {
        position: absolute;
        /* override the column view's sticky positioning */
        top: 0;
    }
    .btree-cell {
        position: absolute;
        box-sizing: border-box;
        overflow: hidden;
        /* opaque (not the column view's translucent grey) so connector lines
           stop at the card edge; slightly off the modal bg to read as a card */
        background: light-dark(#f4f4f4, #4d4d4d);
    }
    /* Collapsed round: a thin clickable rail showing the round name down its length. */
    .btree-rail {
        position: absolute;
        box-sizing: border-box;
        border: 1px solid rgba(128, 128, 128, 0.3);
        border-radius: 6px;
        background: light-dark(#ececec, #5a5a5a);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        overflow: hidden;
        z-index: 2; /* over the connector lines that pass behind it */
    }
    .btree-rail:hover {
        background: light-dark(#e0e0e0, #6a6a6a);
    }
    .btree-rail:focus-visible {
        outline: 2px solid light-dark(#0066cc, #4da6ff);
        outline-offset: 1px;
    }
    .btree-rail-label {
        writing-mode: vertical-rl;
        transform: rotate(180deg);
        font-size: 0.7rem;
        font-weight: bold;
        text-transform: uppercase;
        opacity: 0.6;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-height: 100%;
    }
    .bk-team {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 2px 0;
    }
    .bk-team + .bk-team {
        border-top: 1px solid rgba(128, 128, 128, 0.15);
    }
    .bk-winner {
        font-weight: bold;
    }
    .bk-logo {
        width: 18px;
        height: 18px;
        object-fit: contain;
        flex-shrink: 0;
    }
    .bk-logo-empty {
        opacity: 0;
    }
    .bk-name {
        flex: 1;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
        font-size: 0.85rem;
    }
    .bk-ph {
        opacity: 0.6;
        font-style: italic;
        font-weight: normal;
    }
    .bk-score {
        font-variant-numeric: tabular-nums;
        font-size: 0.85rem;
    }
    .bracket-when {
        font-size: 0.68rem;
        opacity: 0.6;
        margin-top: 3px;
        white-space: nowrap;
    }
    .bracket-venue {
        font-size: 0.66rem;
        opacity: 0.55;
        margin-top: 1px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .standings-group {
        scroll-margin-top: 8px;
    }
    .standings-group-name {
        font-weight: bold;
        font-size: 1.05rem;
        margin: 0 0 4px;
        opacity: 0.85;
    }
    .st-focus-row td {
        background: rgba(128, 128, 128, 0.18);
    }
    .st-focus-row .st-name {
        font-weight: bold;
    }
    /* Fixed layout + identical column widths so every group's table lines up,
       regardless of team-name length. The team column (auto) absorbs the rest. */
    .standings-table {
        width: auto;          /* shrink to the fixed column widths, no trailing gap */
        max-width: 100%;
        align-self: flex-start;
        border-collapse: collapse;
        table-layout: fixed;
        font-size: 0.9rem;
    }
    .standings-table th {
        font-size: 0.7rem;
        text-transform: uppercase;
        opacity: 0.55;
        font-weight: bold;
        text-align: center;
        padding: 2px 4px;
    }
    .standings-table td {
        text-align: center;
        padding: 4px;
        border-top: 1px solid rgba(128, 128, 128, 0.2);
        white-space: nowrap;
    }
    /* Numeric columns: fixed, shared width across all tables. */
    .standings-table th,
    .standings-table td {
        width: 2.4em;
    }
    .standings-table th.st-team,
    .standings-table td.st-team {
        text-align: left;
        width: 14em;
    }
    .standings-narrow th.st-team,
    .standings-narrow td.st-team {
        width: 6em;
    }
    .standings-table th.st-rank,
    .standings-table td.st-rank {
        position: relative;
        width: 2.6em;
        padding-left: 12px;
    }
    .standings-table .st-pts {
        font-weight: bold;
    }
    .st-flag {
        position: absolute;
        left: 2px;
        top: 50%;
        transform: translateY(-50%);
        width: 4px;
        height: 16px;
        border-radius: 2px;
    }
    .st-team-inner {
        display: flex;
        align-items: center;
        gap: 6px;
        min-width: 0;
    }
    .st-logo {
        width: 20px;
        height: 20px;
        object-fit: contain;
        flex-shrink: 0;
    }
    .st-name {
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
    }
    .st-name-link {
        color: inherit;
        text-decoration: none;
    }
    .st-name-link:hover {
        text-decoration: underline;
    }
    .st-clinch {
        flex-shrink: 0;
        color: #1a9e5f;
        font-weight: bold;
    }
    .st-ded {
        color: #d23;
        font-weight: bold;
    }
    .standings-footnote {
        font-size: 0.78rem;
        opacity: 0.85;
        margin-top: 6px;
    }
    .standings-legend {
        display: flex;
        flex-wrap: wrap;
        gap: 5px 16px;
        font-size: 0.8rem;
        opacity: 0.85;
        margin-top: 6px;
    }
    .legend-item {
        display: inline-flex;
        align-items: center;
        gap: 6px;
    }
    .legend-swatch {
        width: 10px;
        height: 10px;
        border-radius: 2px;
        flex-shrink: 0;
    }
    .standings-narrow {
        font-size: 0.82rem;
    }
    .standings-narrow td,
    .standings-narrow th {
        padding: 3px 2px;
    }
</style>

