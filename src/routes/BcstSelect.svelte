<script lang="ts">
    import { goodBcsts } from "$lib/stores";

    // Canonical broadcaster -> upcoming game count.
    export let counts: Record<string, number> = {};

    // Universe = everything seen this week, plus anything already selected (so a
    // picked channel with no current games still shows up, checked).
    $: universe = [...new Set([...Object.keys(counts), ...$goodBcsts])].sort();

    const toggle = (bcst: string, checked: boolean) => {
        if (checked) {
            goodBcsts.update((gb) => (gb.includes(bcst) ? gb : [...gb, bcst]));
        } else {
            goodBcsts.update((gb) => gb.filter((b) => b !== bcst));
        }
    };
</script>

<div class="bcstSelectContainer">
    {#each universe as bcst}
        <span class="bcstSelect">
            <input id={'bcstCheck' + bcst} type="checkbox" checked={$goodBcsts.includes(bcst)}
                onchange={(e) => toggle(bcst, e.currentTarget.checked)}/>
            <label for={'bcstCheck' + bcst}>{bcst}{#if counts[bcst]}&nbsp;<span class="count">({counts[bcst]})</span>{/if}</label>
        </span>
    {/each}
</div>

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
</style>
