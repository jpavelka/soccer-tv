<script>
    import { slide } from 'svelte/transition';

    export let headerText;
    export let tagType = 'span';
    export let headerStyle = '';
    export let showContent = true;
    // The slide only fires for a real click on this header. A filter change can
    // create or drop dozens of these at once, and animating each one's height
    // means re-laying-out a subtree of hundreds of rows every frame for 200ms —
    // which was most of the cost of clearing the last filter. Reset once the
    // animation is done so the next filter-driven open is instant again.
    let byClick = false;
    const toggle = () => {
        byClick = true;
        showContent = !showContent;
    };
</script>

<div>
    <svelte:element
        this={tagType}
        style={headerStyle}
        role="button"
        tabindex="0"
        aria-expanded={showContent}
        on:click={toggle}
        on:keydown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } }}
    >
        <slot name="header">
            {headerText}
        </slot>
    </svelte:element>
    <slot name=inlineAfter></slot>
    {#if showContent}
        <div
            transition:slide={{ duration: byClick ? 200 : 0 }}
            on:introend={() => (byClick = false)}
            on:outroend={() => (byClick = false)}
        >
            <slot></slot>
        </div>
    {/if}
</div>