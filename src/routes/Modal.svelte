<script>
    export let showModal = false;
    const padding = 20;

    // Move the overlay to <body> so `position: fixed` is always resolved
    // against the viewport, even if an ancestor establishes a containing
    // block (a transform/filter/etc.). Without this, on mobile the modal
    // gets positioned relative to the page content instead of the screen.
    //
    // Also locks background scrolling while the modal is open. iOS Safari
    // ignores `overflow: hidden` on <body>, so we pin the body with
    // `position: fixed` and restore the scroll position when the modal closes.
    /** @param {HTMLElement} node */
    function portal(node) {
        document.body.appendChild(node);

        const scrollY = window.scrollY;
        const { overflow, position, top, width } = document.body.style;
        document.body.style.overflow = 'hidden';
        document.body.style.position = 'fixed';
        document.body.style.top = `-${scrollY}px`;
        document.body.style.width = '100%';

        return {
            destroy() {
                document.body.style.overflow = overflow;
                document.body.style.position = position;
                document.body.style.top = top;
                document.body.style.width = width;
                window.scrollTo(0, scrollY);
                if (node.parentNode) node.parentNode.removeChild(node);
            }
        };
    }
</script>

{#if showModal}
    <div class="modal-overlay" use:portal on:click|self={() => (showModal = false)}>
        <div class="modal-content" style={`padding:${padding}px`}>
            <slot name="header"/>
            <div class="body">
                <slot>
                    <p>This is the modal content.</p>
                </slot>
            </div>
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
        width: 100vw;
        height: 100vh;
        z-index: 1000;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: 8vh;
    }

    .modal-content {
        box-sizing: border-box;
        width: min(700px, 90vw);
        max-width: 90vw;
        max-height: 90vh;
        background-color: light-dark(white, #444444);
        border-radius: 8px;
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.8);
        display: flex;
        flex-direction: column;
    }

    .body {
        overflow-y: auto;
        flex: 1;
    }

    .footer {
        border-top: 1pt solid lightgray;
        margin-top: 5pt;
        padding-top: 5pt;
        flex-shrink: 0;
    }
</style>
