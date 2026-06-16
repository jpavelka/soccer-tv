<script>
    import { slide } from 'svelte/transition';

    export let headerText;
    export let tagType = 'span';
    export let headerStyle = '';
    export let showContent = true;
</script>

<div>
    <svelte:element
        this={tagType}
        style={headerStyle}
        role="button"
        tabindex="0"
        aria-expanded={showContent}
        on:click={() => showContent = !showContent}
        on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); showContent = !showContent; } }}
    >
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