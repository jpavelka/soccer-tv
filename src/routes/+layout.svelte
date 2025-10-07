<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children?.()}

<style>
    :global(button) {
        border-radius: 8px;
        box-shadow: 0 2px 4px rgba(0, 0, 0, 0.1);
        border: 1px solid #ccc;
        padding: 10px 15px;
        cursor: pointer;
        transition: all 0.2s ease;
        background-color: #eeeeee;
    }

    :global(button:active) {
        transform: translateY(2px);
        box-shadow: 0 0 2px rgba(0, 0, 0, 0.2);
    }
</style>
