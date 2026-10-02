<script lang="ts">
  import type { Book } from '@shared/types'
  import Icon from '../lib/Icon.svelte'
  import Cover from './Cover.svelte'
  import { FORMAT_LABELS } from './formats'

  let {
    book,
    list = false,
    onopen,
    onmenu,
  }: {
    book: Book
    list?: boolean
    onopen: (book: Book) => void
    onmenu: (book: Book, event: MouseEvent) => void
  } = $props()

  const percent = $derived(Math.round(book.progress * 100))
  const finished = $derived(book.progress >= 0.99)
  const state = $derived(finished ? 'Finished' : book.progress > 0 ? `${Math.max(1, percent)}% read` : '')
  /** Why the book cannot be read right now, if it cannot. */
  const trouble = $derived(
    book.missing ? 'File not found' : book.metaState === 'failed' ? 'Can’t be read' : '',
  )
</script>

<div
  class="card"
  class:list
  class:trouble={!!trouble}
  title={book.title}
  data-id={book.id}
  oncontextmenu={event => {
    event.preventDefault()
    onmenu(book, event)
  }}
  role="group"
  aria-label={book.title}
>
  <button class="open" onclick={() => onopen(book)}>
    <div class="cover">
      <Cover {book} bare={list} />
      {#if book.progress > 0 && !list}
        <div class="progress" aria-hidden="true"><div style:width="{percent}%"></div></div>
      {/if}
    </div>
    <div class="text">
      <div class="title">{book.title}</div>
      <div class="author muted">{book.author || ' '}</div>
      {#if list}
        <div class="muted">{FORMAT_LABELS[book.format]}</div>
        <div class="meta muted">
          {#if trouble}
            <span class="warn">{trouble}</span>
          {:else if book.progress > 0}
            <span class="bar" aria-hidden="true"><span style:width="{percent}%"></span></span>
            <span class:finished>{state}</span>
          {/if}
        </div>
      {:else}
        <div class="meta muted">
          <span class="format">{FORMAT_LABELS[book.format]}</span>
          {#if trouble}
            <span class="warn">{trouble}</span>
          {:else if state}
            <span class:finished>{state}</span>
          {/if}
        </div>
      {/if}
    </div>
  </button>
  <button
    class="icon-btn more"
    title="More actions"
    aria-label="More actions for {book.title}"
    aria-haspopup="menu"
    onclick={event => onmenu(book, event)}
  >
    <Icon name="more" size={16} />
  </button>
</div>

<style>
  .card {
    position: relative;
    min-width: 0;
    border-radius: var(--radius);
  }
  .card:hover,
  .card:focus-within {
    background: var(--hover);
  }
  .open {
    display: flex;
    flex-direction: column;
    gap: 9px;
    width: 100%;
    padding: 8px;
    border-radius: var(--radius);
    text-align: left;
  }
  .more {
    position: absolute;
    top: 14px;
    right: 14px;
    width: 28px;
    height: 28px;
    border-radius: 50%;
    color: #fff;
    background: rgb(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
    opacity: 0;
  }
  .card:hover .more,
  .more:focus-visible {
    opacity: 1;
  }
  .more:hover:not(:disabled) {
    background: rgb(0 0 0 / 0.75);
  }
  .card.trouble .cover {
    opacity: 0.55;
  }
  .warn {
    color: var(--danger);
  }
  .cover {
    position: relative;
    aspect-ratio: 2 / 3;
    border-radius: 5px;
    overflow: hidden;
    background: var(--surface-2);
    box-shadow: var(--shadow);
  }
  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgb(0 0 0 / 0.4);
  }
  .progress div {
    height: 100%;
    /* even one percent should be visible */
    min-width: 6px;
    background: var(--accent-strong);
  }
  .text {
    min-width: 0;
  }
  .title {
    font-weight: 600;
    line-height: 1.3;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .author {
    margin-top: 2px;
    font-size: 12.5px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .meta {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 4px;
    font-size: 11.5px;
    white-space: nowrap;
  }
  .format {
    padding: 0 5px;
    border-radius: 4px;
    border: 1px solid var(--border);
    font-size: 10.5px;
    font-weight: 600;
    line-height: 1.5;
  }
  .finished {
    color: var(--accent);
  }

  .card.list .open {
    flex-direction: row;
    align-items: center;
    gap: 16px;
    padding: 6px 44px 6px 10px;
  }
  .card.list .more {
    top: 50%;
    right: 8px;
    margin-top: -14px;
    color: var(--fg-muted);
    background: none;
    backdrop-filter: none;
    opacity: 1;
  }
  .card.list .more:hover {
    background: var(--hover);
  }
  .card.list .cover {
    width: 44px;
    flex: none;
  }
  .card.list .text {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr) 56px 130px;
    gap: 16px;
    align-items: center;
    font-size: 12.5px;
  }
  .card.list .title {
    font-size: 14px;
  }
  .card.list .title {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .card.list .author {
    margin: 0;
    font-size: 13px;
  }
  .card.list .meta {
    margin: 0;
    font-size: 12px;
  }
  .bar {
    flex: none;
    width: 56px;
    height: 4px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--fg-muted) 22%, transparent);
    overflow: hidden;
  }
  .bar span {
    display: block;
    height: 100%;
    background: var(--accent-strong);
  }
</style>
