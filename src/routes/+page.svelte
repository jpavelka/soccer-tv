<script>
    import { goodStatuses, filterBcsts, bcstCounts, windowInfo, sortMode } from "$lib/stores";
    import { onMount } from "svelte";
    import BcstSelect from "./BcstSelect.svelte";
    import DayGames from "./DayGames.svelte";
    import Modal from "./Modal.svelte";
    import ToggleButton from "./ToggleButton.svelte";

    export let data;

    /** @param {boolean} currentValue */
    const showCompletedFunc = (currentValue) => {
        if (currentValue) {
            goodStatuses.update(gs => {
                gs.push('post');
                return gs
            })
        } else {
            goodStatuses.update(gs => {
                gs = gs.filter(s => s !== 'post');
                return gs
            })
        }
    }
    /** @param {boolean} currentValue */
    const filterBroadcastsFunc = (currentValue) => {
        filterBcsts.set(currentValue);
    }
    let loaded = false;
    onMount(() => {
        const vv = window.visualViewport;
        if (vv) {
            // update (not set) so the gameContentWidth bound below survives
            windowInfo.update((wi) => ({ ...wi, screenWidth: vv.width }));
            vv.addEventListener('resize', () => {
                windowInfo.update((wi) => ({ ...wi, screenWidth: vv.width }));
            });
        }
        loaded = true;
    })
    let showBcstModal = false;
</script>

{#if !loaded}
    Loading...
{:else}
    <div class=titleText>Soccer Games</div>
    <div>
        <span style=display:inline-flex;align-items:center;margin-right:10px;margin-bottom:10px;>
            <span style=margin-right:5px;>Sort by</span>
            <select class="sort-select" bind:value={$sortMode}>
                <option value="league">League</option>
                <option value="interest">Interest</option>
                <option value="time">Time</option>
            </select>
        </span>
        <span style=display:inline-flex;align-items:center;margin-right:10px;margin-bottom:10px;>
            <span style=margin-right:5px;>Show completed</span>
            <ToggleButton onClickFunc={showCompletedFunc} initValue={$goodStatuses.includes('post')}/>
        </span>
        <span style=display:inline-flex;align-items:center;margin-right:10px;margin-bottom:10px;>
            <span style=margin-right:5px;>Filter broadcasts</span>
            <ToggleButton onClickFunc={filterBroadcastsFunc} initValue={$filterBcsts} />
        </span>
        <button onclick={() => {
            showBcstModal = true
        }}>Select Broadcasts</button>
    </div>

    <Modal bind:showModal={showBcstModal}>
        <div slot="header">
            <h2>Filter Broadcasts</h2>
        </div>
        <BcstSelect counts={$bcstCounts} />
        <div slot="footer">
            <button onclick={() => {
                showBcstModal = false
            }}>Continue</button>
        </div>
    </Modal>

    <div style=display:inline-block; bind:clientWidth={$windowInfo.gameContentWidth}>
        {#each Object.keys(data.days) as dt}
            {#key [$goodStatuses, $filterBcsts]}
                <DayGames
                    dayData={data.days[dt]}
                    dt={dt}
                    goodStatuses={$goodStatuses}
                    filterBroadcasts={$filterBcsts}
                    broadcasts={data.broadcasts}
                    leagueOrder={data.leagueOrder}
                    teamRanks={data.teamRanks}
                    sortMode={$sortMode}
                />
            {/key}
        {/each}
    </div>
{/if}

<style>
    :root {
        color-scheme: light dark;
    }
    :global(body) {
        background-color: light-dark(#fafafa, #212121);
        color: light-dark(#333b3c, #efefec)
    }
    :global(button) {
        color: black;
    }
    .sort-select {
        appearance: none;
        padding: 6px 28px 6px 12px;
        border-radius: 8px;
        border: 1px solid light-dark(#bbb, #555);
        background-color: light-dark(#fff, #333);
        color: light-dark(#333b3c, #efefec);
        font-size: 0.9rem;
        cursor: pointer;
        background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='10' height='6'%3E%3Cpath d='M0 0l5 6 5-6z' fill='%23888'/%3E%3C/svg%3E");
        background-repeat: no-repeat;
        background-position: right 8px center;
    }
    .sort-select:focus {
        outline: none;
        border-color: light-dark(#888, #888);
    }
    .titleText {
        font-size: 2.1rem;
        font-weight: bold;
        margin-bottom: 12pt;
    }
</style>
