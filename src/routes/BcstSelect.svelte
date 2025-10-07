<script lang="ts">
    import { goodBcsts } from "$lib/stores";

    export let allBcsts;

    const fullBcstList = [...new Set(allBcsts.concat($goodBcsts))].sort();
</script>

<div class="bcstSelectContainer">
    {#each fullBcstList as bcst}
        <span class="bcstSelect">
            <input id={'bcstCheck' + bcst} type="checkbox" checked={$goodBcsts.includes(bcst)} onchange={(e) => {
                if (e.target.checked) {
                    goodBcsts.update(gb => {
                        gb.push(bcst)
                        return gb
                    })
                } else {
                    goodBcsts.update(gb => {
                        gb = gb.filter(b => b !== bcst);
                        return gb
                    })                    
                }
            }}/>
            <label for={'bcstCheck' + bcst}>{bcst}</label>
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
</style>