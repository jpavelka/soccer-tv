<script>
    import { goodStatuses, filterBcsts, allBcsts, windowInfo } from "$lib/stores";
    import { onMount } from "svelte";
    import BcstSelect from "./BcstSelect.svelte";
    import DayGames from "./DayGames.svelte";
    import Modal from "./Modal.svelte";
    import ToggleButton from "./ToggleButton.svelte";

    export let data;

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
    const filterBroadcastsFunc = (currentValue) => {
        filterBcsts.set(currentValue);
    }
    onMount(() => {
        windowInfo.set({
            screenWidth: window.visualViewport.width
        })
        window.visualViewport.addEventListener('resize', () => {
            windowInfo.update((wi) => {
                wi.screenWidth = window.visualViewport.width;
                return wi
            })
        });      
    })
    let showBcstModal = false;
</script>

<div class=titleText>Soccer Games</div>
<div>
    <span style=display:inline-flex;align-items:center;margin-right:10px;margin-bottom:10px;>
        <span style=margin-right:5px;>Show completed</span>
        <ToggleButton onClickFunc={showCompletedFunc} initValue={false}/>
    </span>
    <span style=display:inline-flex;align-items:center;margin-right:10px;margin-bottom:10px;>
        <span style=margin-right:5px;>Filter broadcasts</span>
        <ToggleButton onClickFunc={filterBroadcastsFunc} initValue={false} />
    </span>
    <button onclick={() => {
        showBcstModal = true
    }}>Select Broadcasts</button>
</div>

<Modal bind:showModal={showBcstModal}>
    <div slot="header">
        <h2>Filter Broadcasts</h2>
    </div>
    <BcstSelect allBcsts={$allBcsts} />
    <div slot="footer">
        <button onclick={() => {
            showBcstModal = false
        }}>Continue</button>
    </div>
</Modal>

<div style=display:inline-block; bind:clientWidth={$windowInfo.gameContentWidth}>
    {#each Object.keys(data) as dt}
        {#key [$goodStatuses, $filterBcsts]}
            <DayGames
                leagueData={data[dt].sports[0].leagues}
                dt={dt}
                goodStatuses={$goodStatuses}
                filterBroadcasts={$filterBcsts}
            />
        {/key}
    {/each}
</div>

<style>
    .titleText {
        font-size: 2.1rem;
        font-weight: bold;
        margin-bottom: 12pt;
    }

</style>
