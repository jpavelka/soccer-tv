<script>
    import { windowInfo } from "$lib/stores";
    export let showModal = false;

    const maxWidth = 700;
    const padding = 20;
    let width;
    let left;
    $: {
        if ($windowInfo.screenWidth > $windowInfo.gameContentWidth) {
            width = Math.min(maxWidth, 0.9 * ($windowInfo.screenWidth - padding));
        } else {
            width = 0.9 * ($windowInfo.screenWidth - padding);
        }
        left = ($windowInfo.screenWidth - width) / 2 - padding;
    }
</script>

{#if showModal}
    <div class="modal-overlay" on:click|self={() => (showModal = false)}>
        <div class="modal-content" style={`padding:${padding}px;width:${width}px;left:${left}px`}>
            <slot name="header"/>
            <slot>
                <p>This is the modal content.</p>
            </slot>
            <div class=footer>
                <slot name="footer"/>
            </div>
        </div>
    </div>
{/if}

<style>
    .modal-overlay {
        position: fixed;
        top: 0;
        left: 0;
        width: 100%;
        height: 100%;
        background-color: rgba(0, 0, 0, 0.5);
        /* display: flex;
        justify-content: center;
        align-items: center; */
    }

    .modal-content {
        position: absolute;
        top: 150px;
        background-color: light-dark(white, #444444);
        border-radius: 8px;
        max-width: 700px;
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.8);
    }

    .footer {
        border-top: 1pt solid lightgray;
        margin-top: 5pt;
        padding-top: 5pt;

    }
</style>
