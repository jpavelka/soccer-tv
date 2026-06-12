<script lang="ts">
    import { goodBcsts, allBcsts, windowInfo, accordionShow } from "$lib/stores";
    import Accordion from "./Accordion.svelte";
    import Modal from "./Modal.svelte";

    let { dayData, dt, goodStatuses, filterBroadcasts, broadcasts, groupByTime } = $props();

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
    $effect(() => {
        Promise.all([dayData, broadcasts]).then(([d, bcstData]) => {
            const wstGames = bcstData?.games ?? [];
            leagueData = d.sports[0].leagues;
            numToShow = 0;
            for (const league of leagueData) {
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
    let venueFetching = $state(false);
    // Measured width of the win-probability bar column; drives whether each
    // percentage label fits inside its bar. Updated on resize via bind:clientWidth.
    let winbarsWidth = $state(0);
    // Label column (.prow-label width) + row gap, subtracted from the measured
    // container width to get the bar track width.
    const PROW_LABEL_OFFSET = 66;

    async function showInfo(event: any, league: any) {
        selectedEvent = event;
        selectedLeague = league;
        venueAddress = null;
        showInfoModal = true;
        if (event.location) {
            venueFetching = true;
            try {
                const res = await fetch(`https://site.api.espn.com/apis/site/v2/sports/soccer/${league.slug}/summary?event=${event.id}`);
                const d = await res.json();
                const addr = d.gameInfo?.venue?.address;
                if (addr) {
                    venueAddress = [addr.city, addr.country].filter(Boolean).join(', ');
                }
            } catch { /* venue stays null */ }
            finally { venueFetching = false; }
        }
    }
    // Convert an American moneyline to a raw implied probability.
    function mlToProb(ml: number): number {
        return ml < 0 ? -ml / (-ml + 100) : 100 / (ml + 100);
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
        return {
            home: { abbr: odds.homeTeamOdds?.team?.abbreviation, pct: Math.round((100 * raw.home) / sum) },
            draw: { pct: Math.round((100 * raw.draw) / sum) },
            away: { abbr: odds.awayTeamOdds?.team?.abbreviation, pct: Math.round((100 * raw.away) / sum) },
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
</script>

{#snippet gameEntry(event: any, league: any)}
    <div class=gameLine>
        <span class={`teamName team0${narrowScreen ? ' teamNameNarrow' : ''}`}>
            {event.competitors[0][narrowScreen ? 'abbreviation' : 'name']}
        </span>
        <img class=teamLogo src={event.competitors[0][`logo${mode === 'dark' ? 'Dark' : ''}`]}/>
        <span class=betweenTeams>{
            event.status === 'pre' ? (
                'vs'
            ) : `${event.competitors[0].score}-${event.competitors[1].score}`
        }</span>
        <img class=teamLogo src={event.competitors[1].logo}/>
        <span class={`teamName${narrowScreen ? ' teamNameNarrow' : ''}`}>
            {event.competitors[1][narrowScreen ? 'abbreviation' : 'name']}
        </span>
        <button class="info-btn" onclick={() => showInfo(event, league)} title="More info">ⓘ</button>
        <span class=when>{
            event.status === 'pre' ? (
                new Date(event.date).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true})
                    .replace(' AM', 'am').replace(' PM', 'pm')
            ) : event.summary
        }</span>
        <span class="broadcast">
            {event.bcstStr}
        </span>
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
            {#if groupByTime}
                {#each flatEvents as { event, league }, i}
                    <div class="timeGameGroup">
                        {#if i === 0 || flatEvents[i - 1].league.name !== league.name}
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

{#if showInfoModal && selectedEvent}
<Modal bind:showModal={showInfoModal}>
    <div slot="header">
        <div class="modal-meta">{selectedLeague.name} <a class="modal-league-link" href={`https://www.espn.com/soccer/league/_/name/${selectedLeague.slug}`} target="_blank">↗</a></div>
        {#if eventStage(selectedEvent, selectedLeague) || eventNote(selectedEvent)}
            <div class="modal-stage">{[eventStage(selectedEvent, selectedLeague), eventNote(selectedEvent)].filter(Boolean).join(' · ')}</div>
        {/if}
        {#if selectedEvent.status === 'in'}
            <div class="modal-live">● {selectedEvent.summary}</div>
        {/if}
        <div class="modal-teams">
            <div class="modal-team">
                <img class="modal-logo" src={selectedEvent.competitors[0][`logo${mode === 'dark' ? 'Dark' : ''}`]} alt=""/>
                <strong>{selectedEvent.competitors[0].name}</strong>
                {#if selectedEvent.status !== 'pre'}
                    <span class="modal-score">{selectedEvent.competitors[0].score}</span>
                {/if}
            </div>
            <div class="modal-team">
                <img class="modal-logo" src={selectedEvent.competitors[1].logo} alt=""/>
                <strong>{selectedEvent.competitors[1].name}</strong>
                {#if selectedEvent.status !== 'pre'}
                    <span class="modal-score">{selectedEvent.competitors[1].score}</span>
                {/if}
            </div>
        </div>
        <div class="modal-meta modal-datetime">{
            new Date(selectedEvent.date).toLocaleDateString('en-US', {weekday: 'long', month: 'long', day: 'numeric'})
        } · {
            new Date(selectedEvent.date).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true}).replace(' AM', 'am').replace(' PM', 'pm')
        }{selectedEvent.status === 'post' ? ' · ' + selectedEvent.summary : ''}</div>
    </div>
    <div class="modal-body">
        {#if selectedEvent.location}
            <div class="modal-row">
                <span class="modal-label">Venue</span>
                <span>
                    {selectedEvent.location}{selectedEvent.neutralSite ? ' · neutral' : ''}
                    {#if venueFetching}<span class="venue-loading">…</span>
                    {:else if venueAddress}<span class="venue-address"> · {venueAddress}</span>
                    {/if}
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
        padding: 0 10px;
    }
    .teamName {
        width: 100px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .teamNameNarrow {
        width: 55px;
    }
    .team0 {
        text-align: right;
    }
    .betweenTeams {
        width: 30px;
        text-align: center;
    }
    .when {
        width: 60px;
        padding: 0 10px;
    }
    .broadcast {
        white-space: nowrap;
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
    .leagueName::before {
        content: '';
        width: 165px;
        flex-shrink: 0;
    }
    .narrowLeague::before {
        width: 120px;
    }
    .leagueName span {
        font-size: 0.75rem;
        opacity: 0.6;
        white-space: nowrap;
        transform: translateX(-50%);
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
    .info-btn {
        background: none;
        border: 1.5px solid currentColor;
        border-radius: 4px;
        cursor: pointer;
        font-size: 0.8rem;
        opacity: 0.45;
        padding: 1px 0;
        width: 28px;
        text-align: center;
        flex-shrink: 0;
        color: inherit;
        line-height: 1.4;
        margin: 0 5px;
    }
    .info-btn:hover {
        opacity: 0.85;
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
    .modal-team strong {
        width: 8em;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
    }
    .modal-score {
        font-size: 1.4rem;
        font-weight: bold;
    }
    .venue-loading {
        opacity: 0.4;
    }
    .venue-address {
        opacity: 0.7;
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

