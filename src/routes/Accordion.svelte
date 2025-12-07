<script>
    import { slide } from 'svelte/transition';

    export let headerText;
    export let tagType = 'span';
    export let headerStyle = '';
    export let showContent = true;
    export let searchAfterText = '';
</script>

<div>
    <svelte:element this={tagType} style={headerStyle} on:click={() => showContent = !showContent}>
        <slot name="header">
            {headerText}
        </slot>
    </svelte:element>
    <slot name=inlineAfter></slot>
    {#if showContent}
        <div transition:slide={{ duration: 200 }}>
            <slot></slot>
        </div>
    {/if}
</div>