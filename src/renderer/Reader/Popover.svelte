<script lang="ts">
  import type { Snippet } from 'svelte'
  import type { ViewportRect } from '../engines/types'

  let {
    rect,
    children,
  }: {
    /** What the popover points at, in window coordinates. */
    rect: ViewportRect
    children: Snippet
  } = $props()

  let width = $state(0)
  let height = $state(0)

  const MARGIN = 8
  const TOOLBAR = 48
  const position = $derived.by(() => {
    let left = (rect.left + rect.right) / 2 - width / 2
    left = Math.max(MARGIN, Math.min(left, innerWidth - width - MARGIN))
    // Prefer sitting above the target; drop below when there is no room.
    let top = rect.top - height - 10
    if (top < TOOLBAR + MARGIN) top = Math.min(rect.bottom + 10, innerHeight - height - MARGIN)
    return { left, top: Math.max(MARGIN, top) }
  })
</script>

<div
  class="popover"
  role="dialog"
  bind:offsetWidth={width}
  bind:offsetHeight={height}
  style:left="{position.left}px"
  style:top="{position.top}px"
  style:visibility={width ? 'visible' : 'hidden'}
>
  {@render children()}
</div>

<style>
  .popover {
    position: fixed;
    z-index: 60;
    max-width: min(440px, calc(100vw - 16px));
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }
</style>
