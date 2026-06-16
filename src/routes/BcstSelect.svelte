<script lang="ts">
    import { goodBcsts } from "$lib/stores";
    import { isHiddenBcst } from "$lib/broadcasters";

    // Canonical broadcaster -> upcoming game count.
    export let counts: Record<string, number> = {};

    let showHidden = false;

    // Universe = everything seen this week, plus anything already selected (so a
    // picked channel with no current games still shows up, checked).
    $: universe = [...new Set([...Object.keys(counts), ...$goodBcsts])].sort();
    $: visibleBcsts = universe.filter((b) => !isHiddenBcst(b) || $goodBcsts.includes(b));
    $: hiddenBcsts = universe.filter((b) => isHiddenBcst(b) && !$goodBcsts.includes(b));

    const toggle = (bcst: string, checked: boolean) => {
        if (checked) {
            goodBcsts.update((gb) => (gb.includes(bcst) ? gb : [...gb, bcst]));
        } else {
            goodBcsts.update((gb) => gb.filter((b) => b !== bcst));
        }
    };
</script>

<div class="bcstSelectContainer">
    {#each visibleBcsts as bcst}
        <span class="bcstSelect">
            <input id={'bcstCheck' + bcst} type="checkbox" checked={$goodBcsts.includes(bcst)}
                onchange={(e) => toggle(bcst, e.currentTarget.checked)}/>
            <label for={'bcstCheck' + bcst}>{bcst}{#if counts[bcst]} <span class="count">({counts[bcst]})</span>{/if}</label>
        </span>
    {/each}
</div>

{#if hiddenBcsts.length}
    <button class="showMore" onclick={() => { showHidden = !showHidden }}>
        {showHidden ? 'Hide' : 'Show'} {hiddenBcsts.length} more
    </button>
    {#if showHidden}
        <div class="bcstSelectContainer">
            {#each hiddenBcsts as bcst}
                <span class="bcstSelect">
                    <input id={'bcstCheck' + bcst} type="checkbox" checked={$goodBcsts.includes(bcst)}
                        onchange={(e) => toggle(bcst, e.currentTarget.checked)}/>
                    <label for={'bcstCheck' + bcst}>{bcst}{#if counts[bcst]} <span class="count">({counts[bcst]})</span>{/if}</label>
                </span>
            {/each}
        </div>
    {/if}
{/if}

<style>
    .bcstSelectContainer {
        display: flex;
        flex-wrap: wrap;
        gap: 10px;
    }
    .bcstSelect {
        width: 160px;
    }
    .count {
        opacity: 0.6;
    }
    .showMore {
        margin-top: 12px;
        cursor: pointer;
    }
</style>
