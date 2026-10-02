<script lang="ts">
  import type { Snippet } from 'svelte'
  import Icon from './Icon.svelte'

  let {
    title,
    onclose,
    width = 560,
    children,
    footer,
  }: {
    title: string
    onclose: () => void
    width?: number
    children: Snippet
    footer?: Snippet
  } = $props()

  let sheet = $state<HTMLElement>()

  // Focus moves into the dialog while it is open and back where it was after.
  $effect(() => {
    const previous = document.activeElement as HTMLElement | null
    const first = sheet?.querySelector<HTMLElement>('[data-autofocus]') ?? sheet
    first?.focus()
    return () => previous?.focus?.()
  })

  function onkeydown(event: KeyboardEvent) {
    // the dialog is modal: no shortcut of the screen behind it may fire
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      onclose()
    } else if (event.key === 'Tab' && sheet) {
      const stops = [...sheet.querySelectorAll<HTMLElement>('button, input, select, textarea, a[href]')].filter(
        el => !el.hasAttribute('disabled'),
      )
      if (!stops.length) return
      const first = stops[0]
      const last = stops[stops.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || active === sheet)) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && active === last) {
        event.preventDefault()
        first.focus()
      }
    }
  }
</script>

<!-- svelte-ignore a11y_no_static_element_interactions -->
<div
  class="backdrop"
  onpointerdown={event => {
    if (event.target === event.currentTarget) onclose()
  }}
>
  <div
    class="sheet"
    role="dialog"
    aria-modal="true"
    aria-label={title}
    tabindex="-1"
    style:width="min({width}px, 100%)"
    bind:this={sheet}
    {onkeydown}
  >
    <header>
      <h2>{title}</h2>
      <button class="icon-btn" aria-label="Close" onclick={onclose}>
        <Icon name="x" size={16} />
      </button>
    </header>
    <div class="body scroll">
      {@render children()}
    </div>
    {#if footer}
      <footer>{@render footer()}</footer>
    {/if}
  </div>
</div>

<style>
  .backdrop {
    position: fixed;
    inset: 0;
    z-index: 150;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 24px;
    background: rgb(0 0 0 / 0.38);
  }
  .sheet {
    display: flex;
    flex-direction: column;
    max-height: 100%;
    border-radius: 14px;
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    outline: none;
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 14px 14px 10px 20px;
  }
  h2 {
    font-size: 16px;
    font-weight: 600;
  }
  .body {
    padding: 0 20px 18px;
    user-select: text;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
    padding: 12px 20px 16px;
    border-top: 1px solid var(--border);
  }
</style>
