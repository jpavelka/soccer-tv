<script lang="ts">
    import { goodBcsts, allBcsts, windowInfo, accordionShow } from "$lib/stores";
    import Accordion from "./Accordion.svelte";

    let { dayData, dt, goodStatuses, filterBroadcasts } = $props();
    
    let leagueData = $state([]);
    let numToShow = $state(0);
    $effect(() => {
        dayData.then(d => {
            leagueData = d.sports[0].leagues;
            for (const league of leagueData) {
                league.numToShow = 0;
                for (const event of league.events) {
                    event.bcstsToShow = [];
                    event.show = false;
                    for (const bcst of event.broadcasts || []) {
                        if (!$allBcsts.includes(bcst.name)) {
                            allBcsts.update((a) => [...a, bcst.name])
                        }
                        if (!filterBroadcasts || $goodBcsts.includes(bcst.name)) {
                            event.bcstsToShow.push(bcst.name)
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
    let mode = !!window ? (
        Math.max(...window.getComputedStyle( document.body ,null).getPropertyValue('background-color').match(/\d+/g).map(Number)) > 150 ? 'light' : 'dark'
    ) : 'light'
</script>

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
                                <div class=gameLine>
                                    <span class={`teamName team0${narrowScreen ? ' teamNameNarrow' : ''}`}>
                                        {event.competitors[0][narrowScreen ? 'abbreviation' : 'name']}
                                    </span>
                                    <img class=teamLogo src={event.competitors[0][`logo${mode === 'dark' ? 'Dark' : ''}`]}/>
                                    <a
                                        target=_blank
                                        href={`https://www.google.com/search?q=${event.competitors[0].name} vs ${event.competitors[1].name}`}
                                        class=betweenTeams>{
                                            event.status === 'pre' ? (
                                                'vs'
                                            ) : `${event.competitors[0].score}-${event.competitors[1].score}`
                                        }
                                    </a>
                                    <img class=teamLogo src={event.competitors[1].logo}/>
                                    <span class={`teamName${narrowScreen ? ' teamNameNarrow' : ''}`}>
                                        {event.competitors[1][narrowScreen ? 'abbreviation' : 'name']}
                                    </span>
                                    <span class=when>{
                                        event.status === 'pre' ? (
                                            new Date(event.date).toLocaleTimeString('en-US', {hour: 'numeric', minute: '2-digit', hour12: true})
                                                .replace(' AM', 'am').replace(' PM', 'pm')
                                        ) : event.summary
                                    }</span>
                                    <span class="broadcast">
                                        {event.bcstStr}
                                    </span>
                                </div>
                            {/if}
                        {/each}
                    </Accordion>
                {/if}
            {/each}
        {:else}
            <div class=noShow>No games for this date</div>
        {/if}
    {/await}
    <div class=spacing></div>
</Accordion>

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
    .noShow {
        font-style: italic;
    }
    .linkAfter {
        margin-left: 0.5rem;
        text-decoration: none;
    }
</style>

