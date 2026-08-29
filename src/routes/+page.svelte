<script>
    import { goodStatuses, filterBcsts, bcstCounts, windowInfo, sortMode, filterInterest, minInterest } from "$lib/stores";
    import { onMount, tick } from "svelte";
    import BcstSelect from "./BcstSelect.svelte";
    import DayGames from "./DayGames.svelte";
    import Modal from "./Modal.svelte";
    import ToggleButton from "./ToggleButton.svelte";

    export let data;

    // True while a filter or sort change is being applied — dims the game list
    // (see `.gameArea.updating` below).
    let pending = false;
    // Only the most recent change is allowed to clear the dim, so a second change
    // landing mid-rebuild can't un-dim while its own work is still pending.
    let pendingToken = 0;

    // Changing a filter or the sort order rebuilds every visible row — up to
    // ~1000 of them with nothing filtered — and that used to run in the *same*
    // Svelte flush as the control's own visual update. One flush means one paint,
    // so for the few hundred ms of work nothing on screen moved at all: no knob,
    // no list, no sign the click had registered. Setting `pending` synchronously
    // (so it batches with the control) and pushing the actual work out a frame
    // gives the browser a paint to show both before it gets busy. From there the
    // feedback is compositor-driven — the toggle knob's transform transition and
    // the list's opacity fade both keep running while the main thread is blocked.
    /**
     * @param {(v: boolean) => void} apply
     * @returns {(currentValue?: boolean) => void} the toggles pass their new
     *   value straight through; the slider and sort select take no argument
     */
    const deferUpdate = (apply) => (currentValue = false) => {
        pending = true;
        const token = ++pendingToken;
        // Two frames, not one: a single requestAnimationFrame callback runs
        // *before* that frame's paint, so doing the work there would block the
        // very paint we're trying to get. The first returns immediately, the
        // browser paints, and the second does the rebuild.
        requestAnimationFrame(() => requestAnimationFrame(() => {
            apply(currentValue);
            tick().then(() => requestAnimationFrame(() => {
                if (token === pendingToken) pending = false;
            }));
        }));
    };

    const showCompletedFunc = deferUpdate((currentValue) => {
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
    });
    const filterBroadcastsFunc = deferUpdate((currentValue) => {
        filterBcsts.set(currentValue);
    });
    const filterInterestFunc = deferUpdate((currentValue) => {
        filterInterest.set(currentValue);
    });

    // The select's own value, so the dropdown shows the new choice immediately
    // instead of only once the re-sorted list has been built.
    let sortValue = $sortMode;
    const commitSort = deferUpdate(() => {
        sortMode.set(sortValue);
    });

    // The slider's own value, so the thumb and the number readout track the drag
    // with no lag. The store — and with it the rebuild — is only written on
    // release, since re-filtering at every step of the drag meant a full rebuild
    // per notch. The list dims in the meantime to show the change is queued.
    let sliderValue = $minInterest;
    const commitInterest = deferUpdate(() => {
        minInterest.set(sliderValue);
    });
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
            <select class="sort-select" value={sortValue}
                    onchange={(e) => { sortValue = e.currentTarget.value; commitSort(); }}>
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
        <button style="margin-right:10px;" onclick={() => {
            showBcstModal = true
        }}>Select Broadcasts</button>
        <span style=display:inline-flex;align-items:center;margin-right:10px;margin-bottom:10px;>
            <span style=margin-right:5px;>Filter interest</span>
            <ToggleButton onClickFunc={filterInterestFunc} initValue={$filterInterest} />
            {#if $filterInterest}
                <span style="display:inline-flex;flex-direction:column;align-items:center;margin-left:8px;">
                    <span>Min interest score</span>
                    <input type="range" min="0" max="100" step="5" value={sliderValue}
                           oninput={(e) => { sliderValue = Number(e.currentTarget.value); pending = true; }}
                           onchange={() => commitInterest()}
                           style="vertical-align:middle;" aria-label="Min interest score" />
                </span>
                <span style="margin-left:6px;min-width:1.5em;">{sliderValue}</span>
            {/if}
        </span>
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

    <div class="gameArea" class:updating={pending} bind:clientWidth={$windowInfo.gameContentWidth}>
        <!-- No {#key} wrapper: DayGames reads goodStatuses/filterBroadcasts
             synchronously in its filter effect, so a toggle updates in place.
             Re-keying used to tear down and rebuild every day section (and play
             out every accordion's slide transition) on each flip. -->
        {#each Object.keys(data.days) as dt}
            <DayGames
                dayData={data.days[dt]}
                dt={dt}
                hideIfNoLive={dt === data.yesterdayDt}
                goodStatuses={$goodStatuses}
                filterBroadcasts={$filterBcsts}
                broadcasts={data.broadcasts}
                leagueOrder={data.leagueOrder}
                teamRanks={data.teamRanks}
                leagueAlt={data.leagueAlt}
                sortMode={$sortMode}
            />
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
    .gameArea {
        display: inline-block;
        transition: opacity 0.15s ease;
    }
    /* Held while a filter change is being applied. Opacity is composited, so the
       fade runs on the compositor and stays smooth even though the main thread is
       busy rebuilding the list. */
    .gameArea.updating {
        opacity: 0.45;
        /* Rows are about to move — don't let a click land on the wrong game. */
        pointer-events: none;
    }
    @media (prefers-reduced-motion: reduce) {
        .gameArea {
            transition: none;
        }
    }
    .titleText {
        font-size: 2.1rem;
        font-weight: bold;
        margin-bottom: 12pt;
    }
</style>
