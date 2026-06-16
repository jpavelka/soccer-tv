<script>
    export let showModal = false;
    const padding = 20;

    // Mobile Safari mis-anchors `position: fixed` to the document origin (the
    // modal ends up at the top of the page, off-screen once you've scrolled),
    // so we avoid `fixed` entirely. Instead the overlay is portaled to <body>
    // and positioned `absolute` at the current scroll offset, which `absolute`
    // handles reliably on every browser. We then lock background scrolling so
    // the scroll offset can't change, making the overlay behave exactly like a
    // viewport-pinned element. The page layout is never altered, so there's no
    // jump and no URL-bar shift.
    /** @param {HTMLElement} node */
    function viewportModal(node) {
        document.body.appendChild(node);
        // Anchor the overlay to the top of the *visible* viewport, in document
        // coordinates. `visualViewport.pageTop` accounts for the mobile URL bar
        // / visual-viewport offset, which `window.scrollY` (layout viewport)
        // does not — using scrollY anchors the overlay slightly too high, so
        // the modal lands higher on screen than the intended 8vh. Scroll is
        // locked below, so this value stays accurate while the modal is open.
        const vv = window.visualViewport;
        node.style.top = `${vv ? vv.pageTop : window.scrollY}px`;
        // Size the overlay to the *visible* viewport height in pixels. `vh`
        // units resolve against the large (URL-bar-hidden) viewport, so a modal
        // sized in `vh` can be taller than the area actually on screen, pushing
        // the footer below the fold. Scroll is locked, so this stays accurate.
        if (vv) node.style.setProperty('--vvh', `${vv.height}px`);

        /** @param {Event} e */
        const blockScroll = (e) => {
            // Let gestures inside a scrollable part of the modal through;
            // cancel everything else so the background can't scroll.
            let el = e.target instanceof HTMLElement ? e.target : null;
            while (el && el !== node) {
                if (el.scrollHeight > el.clientHeight) {
                    const overflowY = getComputedStyle(el).overflowY;
                    if (overflowY === 'auto' || overflowY === 'scroll') return;
                }
                el = el.parentElement;
            }
            e.preventDefault();
        };
        node.addEventListener('touchmove', blockScroll, { passive: false });
        node.addEventListener('wheel', blockScroll, { passive: false });

        return {
            destroy() {
                node.removeEventListener('touchmove', blockScroll);
                node.removeEventListener('wheel', blockScroll);
                if (node.parentNode) node.parentNode.removeChild(node);
            }
        };
    }

    /** @param {KeyboardEvent} e */
    function onOverlayKeydown(e) {
        if (e.key === 'Escape') showModal = false;
    }
</script>

{#if showModal}
    <div
        class="modal-overlay"
        use:viewportModal
        role="button"
        tabindex="-1"
        aria-label="Close modal"
        on:click|self={() => (showModal = false)}
        on:keydown={onOverlayKeydown}
    >
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
        position: absolute;
        /* `top` is set by the action to the current scroll offset */
        left: 0;
        width: 100%;
        height: var(--vvh, 100vh);
        z-index: 1000;
        background-color: rgba(0, 0, 0, 0.5);
        display: flex;
        align-items: flex-start;
        justify-content: center;
        padding-top: calc(var(--vvh, 100vh) * 0.08);
    }

    .modal-content {
        box-sizing: border-box;
        width: min(700px, 90vw);
        max-width: 90vw;
        /* Leave the 8% top padding plus a little breathing room at the bottom
           so the footer stays on screen. */
        max-height: calc(var(--vvh, 100vh) * 0.84);
        background-color: light-dark(white, #444444);
        border-radius: 8px;
        box-shadow: 0 5px 15px rgba(0, 0, 0, 0.8);
        display: flex;
        flex-direction: column;
    }

    .body {
        overflow-y: auto;
        overscroll-behavior: contain;
        flex: 1;
    }

    .footer {
        border-top: 1pt solid lightgray;
        padding-top: 5pt;
        flex-shrink: 0;
    }
</style>
