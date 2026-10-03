<script module lang="ts">
  export type PanelTab = 'contents' | 'notes' | 'bookmarks' | 'search'
</script>

<script lang="ts">
  import type { Annotation, Bookmark, ExportFormat } from '@shared/types'
  import type { AnnotationStore } from '../annotations/store.svelte'
  import {
    HIGHLIGHT_HEX,
    type Engine,
    type SearchGroup,
    type SearchHit,
    type TocItem,
  } from '../engines/types'
  import Icon from '../lib/Icon.svelte'
  import TocTree from './TocTree.svelte'

  let {
    engine,
    store,
    tab = $bindable(),
    tocId,
    searchQuery = $bindable(),
    onnavigate,
    onannotation,
    onbookmark,
    onremovebookmark,
    onexport,
    onclose,
  }: {
    engine: Engine
    store: AnnotationStore
    tab: PanelTab
    tocId: string | null
    searchQuery: string
    onnavigate: (target: string) => void
    onannotation: (annotation: Annotation) => void
    onbookmark: (bookmark: Bookmark) => void
    onremovebookmark: (bookmark: Bookmark) => void
    onexport: (format: ExportFormat) => void
    onclose: () => void
  } = $props()

  const TABS: { id: PanelTab; label: string; icon: 'list' | 'highlighter' | 'bookmark' | 'search' }[] = [
    { id: 'contents', label: 'Contents', icon: 'list' },
    { id: 'notes', label: 'Highlights', icon: 'highlighter' },
    { id: 'bookmarks', label: 'Bookmarks', icon: 'bookmark' },
    { id: 'search', label: 'Search', icon: 'search' },
  ]

  /* ---------- search ---------- */

  let matchCase = $state(false)
  let wholeWords = $state(false)
  let groups = $state<SearchGroup[]>([])
  let progress = $state<number | null>(null)
  let searched = $state('')
  let input = $state<HTMLInputElement>()
  let run = 0

  const total = $derived(groups.reduce((sum, group) => sum + group.hits.length, 0))
  /** The result the reader is on (counting through all groups), or -1. */
  let active = $state(-1)
  /** Index of each group's first hit in that count. */
  const offsets = $derived.by(() => {
    let sum = 0
    return groups.map(group => (sum += group.hits.length) - group.hits.length)
  })
  let results = $state<HTMLElement>()

  function show(index: number) {
    const hit = groups.flatMap(group => group.hits)[index]
    if (!hit) return
    active = index
    onnavigate(hit.target)
    engine.markSearchHit?.(hit.target)
    requestAnimationFrame(() =>
      results?.querySelector('[aria-current="true"]')?.scrollIntoView({ block: 'nearest' }),
    )
  }

  /** Next (1) or previous (-1) result, going round at the ends. */
  function step(direction: 1 | -1) {
    if (!total) return
    show(active < 0 ? (direction > 0 ? 0 : total - 1) : (active + direction + total) % total)
  }

  export function focusSearch() {
    tab = 'search'
    requestAnimationFrame(() => {
      input?.focus()
      input?.select()
    })
  }

  export async function search() {
    const query = searchQuery.trim()
    const current = ++run
    groups = []
    active = -1
    searched = query
    if (!query) {
      progress = null
      engine.clearSearch()
      return
    }
    progress = 0
    try {
      for await (const update of engine.search(query, { matchCase, wholeWords })) {
        if (current !== run) return
        if ('group' in update) groups.push(update.group)
        else progress = update.progress
      }
    } catch (error) {
      console.warn('Search failed:', error)
    }
    if (current === run) progress = null
  }

  function clearSearch() {
    run++
    searchQuery = ''
    searched = ''
    groups = []
    active = -1
    progress = null
    engine.clearSearch()
    input?.focus()
  }

  // Scroll the current chapter into view when the contents tab is showing.
  let tocScroller = $state<HTMLElement>()
  $effect(() => {
    void tocId
    if (tab !== 'contents' || !tocScroller) return
    requestAnimationFrame(() =>
      tocScroller?.querySelector('[aria-current="location"]')?.scrollIntoView({ block: 'nearest' }),
    )
  })

  const day = (time: number) => new Date(time).toLocaleDateString(undefined, { dateStyle: 'medium' })
  const flat = (items: TocItem[]): number => items.reduce((n, item) => n + 1 + flat(item.children), 0)
  const hitKey = (hit: SearchHit, i: number) => hit.target + i
</script>

<aside class="panel">
  <div class="tabs">
    <div class="tablist" role="tablist" aria-label="Side panel">
    {#each TABS as item (item.id)}
      <button
        role="tab"
        aria-selected={tab === item.id}
        class:active={tab === item.id}
        title={item.label}
        onclick={() => (item.id === 'search' ? focusSearch() : (tab = item.id))}
      >
        <Icon name={item.icon} size={16} />
        <span class="tab-label">{item.label}</span>
        {#if item.id === 'notes' && store.annotations.length}
          <span class="count">{store.annotations.length}</span>
        {:else if item.id === 'bookmarks' && store.bookmarks.length}
          <span class="count">{store.bookmarks.length}</span>
        {/if}
      </button>
    {/each}
    </div>
    <button class="icon-btn close" title="Close panel" aria-label="Close panel" onclick={onclose}>
      <Icon name="x" size={16} />
    </button>
  </div>

  {#if tab === 'contents'}
    <div class="body scroll" bind:this={tocScroller}>
      {#if flat(engine.toc)}
        <TocTree items={engine.toc} current={tocId} onselect={item => item.target && onnavigate(item.target)} />
      {:else}
        <p class="empty muted">
          This book has no table of contents. Use Search, or the bar along the bottom, to move around.
        </p>
      {/if}
    </div>
  {:else if tab === 'notes'}
    <div class="body scroll">
      {#each store.annotations as annotation (annotation.id)}
        <button class="note" onclick={() => onannotation(annotation)}>
          <span class="bar" style:background={HIGHLIGHT_HEX[annotation.color]}></span>
          <span class="note-body">
            {#if annotation.label}<span class="label muted ellipsis">{annotation.label}</span>{/if}
            <span class="text">{annotation.text}</span>
            {#if annotation.note}<span class="comment">{annotation.note}</span>{/if}
            <span class="date muted">{day(annotation.createdAt)}</span>
          </span>
        </button>
      {:else}
        <p class="empty muted">
          No highlights yet. Select some text in the book to highlight it or add a note.
        </p>
      {/each}
    </div>
    {#if store.annotations.length}
      <div class="footer">
        <span class="muted">Export as</span>
        <button class="btn" title="Save highlights, notes and bookmarks as a Markdown file" onclick={() => onexport('markdown')}>
          Markdown
        </button>
        <button class="btn" title="Save highlights, notes and bookmarks as a JSON file" onclick={() => onexport('json')}>
          JSON
        </button>
      </div>
    {/if}
  {:else if tab === 'bookmarks'}
    <div class="body scroll">
      {#each store.bookmarks as bookmark (bookmark.id)}
        <div class="bookmark">
          <button class="bookmark-body" onclick={() => onbookmark(bookmark)}>
            <span class="label ellipsis">{bookmark.label || 'Bookmark'}</span>
            {#if bookmark.excerpt}<span class="text muted">{bookmark.excerpt}</span>{/if}
            <span class="date muted">{Math.round(bookmark.position * 100)}% · {day(bookmark.createdAt)}</span>
          </button>
          <button
            class="icon-btn"
            title="Remove bookmark"
            aria-label="Remove bookmark"
            onclick={() => onremovebookmark(bookmark)}
          >
            <Icon name="trash" size={15} />
          </button>
        </div>
      {:else}
        <p class="empty muted">No bookmarks yet. Press Ctrl+D to bookmark where you are.</p>
      {/each}
    </div>
  {:else}
    <form
      class="search"
      onsubmit={event => {
        event.preventDefault()
        void search()
      }}
    >
      <div class="field">
        <input
          class="input"
          type="text"
          placeholder="Search in book"
          aria-label="Search in book"
          bind:this={input}
          bind:value={searchQuery}
          onkeydown={event => {
            // Enter on a search that has already run walks through its results
            if (event.key !== 'Enter' || searchQuery.trim() !== searched || !total) return
            event.preventDefault()
            step(event.shiftKey ? -1 : 1)
          }}
        />
        {#if searchQuery}
          <button type="button" class="icon-btn clear" aria-label="Clear search" onclick={clearSearch}>
            <Icon name="x" size={14} />
          </button>
        {/if}
      </div>
      <div class="options">
        <label><input type="checkbox" bind:checked={matchCase} onchange={search} /> Match case</label>
        <label><input type="checkbox" bind:checked={wholeWords} onchange={search} /> Whole words</label>
      </div>
    </form>
    {#if progress != null}
      <div class="progress"><div style:width="{progress * 100}%"></div></div>
    {/if}
    {#if searched}
      <div class="stepper">
        <span class="summary muted" role="status">
          {#if total}
            {active >= 0 ? `${active + 1} of ` : ''}{total} result{total === 1 ? '' : 's'}{progress != null ? '…' : ''}
          {:else if progress != null}
            Searching…
          {:else}
            No results
          {/if}
        </span>
        <button class="icon-btn" title="Previous result (Shift+Enter)" aria-label="Previous result" disabled={!total} onclick={() => step(-1)}>
          <Icon name="chevron-up" size={16} />
        </button>
        <button class="icon-btn" title="Next result (Enter)" aria-label="Next result" disabled={!total} onclick={() => step(1)}>
          <Icon name="chevron-down" size={16} />
        </button>
      </div>
    {/if}
    <div class="body scroll" bind:this={results}>
      {#if searched && !total && progress == null}
        <p class="empty muted">
          Nothing in this book matches “{searched}”. Check the spelling{matchCase || wholeWords
            ? ', or turn off Match case and Whole words'
            : ''}.
        </p>
      {/if}
      {#each groups as group, g (g)}
        <div class="group-label ellipsis">{group.label}</div>
        {#each group.hits as hit, i (hitKey(hit, i))}
          <button
            class="hit"
            class:active={offsets[g] + i === active}
            aria-current={offsets[g] + i === active ? 'true' : undefined}
            onclick={() => show(offsets[g] + i)}
          >
            {hit.pre}<mark>{hit.match}</mark>{hit.post}
          </button>
        {/each}
      {/each}
    </div>
  {/if}
</aside>

<style>
  .panel {
    display: flex;
    flex-direction: column;
    min-width: 0;
    height: 100%;
    border-right: 1px solid var(--border);
    background: var(--surface-2);
  }
  .tabs {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 5px 4px 5px 6px;
    border-bottom: 1px solid var(--border);
  }
  .tablist {
    flex: 1;
    min-width: 0;
    display: flex;
    gap: 2px;
  }
  .tabs [role='tab'] {
    position: relative;
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 2px;
    padding: 5px 2px 4px;
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
  }
  .tab-label {
    max-width: 100%;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 11px;
    line-height: 1.2;
  }
  .tabs [role='tab']:hover {
    background: var(--hover);
  }
  .tabs [role='tab'].active {
    background: var(--accent-soft);
    color: var(--accent);
  }
  .count {
    position: absolute;
    top: 2px;
    left: calc(50% + 6px);
    min-width: 15px;
    padding: 0 4px;
    border-radius: 8px;
    font-size: 9.5px;
    font-weight: 600;
    line-height: 15px;
    background: var(--accent-strong);
    /* dark on orange: white does not have the contrast */
    color: #2b1203;
  }
  .close {
    width: 28px;
    height: 28px;
    color: var(--fg-muted);
  }
  .body {
    flex: 1;
    min-height: 0;
    padding: 6px;
  }
  .empty {
    padding: 18px 12px;
    text-align: center;
    line-height: 1.5;
  }
  .note,
  .bookmark {
    display: flex;
    width: 100%;
    gap: 8px;
    padding: 8px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .note:hover,
  .bookmark:hover {
    background: var(--hover);
  }
  .bar {
    flex: none;
    width: 4px;
    border-radius: 2px;
  }
  .note-body,
  .bookmark-body {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    text-align: left;
  }
  .label {
    font-size: 11px;
    font-weight: 600;
  }
  .text {
    display: -webkit-box;
    -webkit-line-clamp: 4;
    line-clamp: 4;
    -webkit-box-orient: vertical;
    overflow: hidden;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .comment {
    padding-left: 8px;
    border-left: 2px solid var(--border);
    font-style: italic;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .date {
    font-size: 11px;
  }
  .footer {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 8px 8px 8px 12px;
    border-top: 1px solid var(--border);
    font-size: 12.5px;
  }
  .footer .btn {
    flex: 1;
    justify-content: center;
  }
  .search {
    padding: 8px 8px 4px;
  }
  .field {
    position: relative;
    display: flex;
  }
  .field input {
    flex: 1;
    padding-right: 30px;
  }
  .clear {
    position: absolute;
    right: 3px;
    top: 3px;
    width: 26px;
    height: 26px;
  }
  .options {
    display: flex;
    gap: 14px;
    margin-top: 6px;
    font-size: 12px;
    color: var(--fg-muted);
  }
  .options label {
    display: flex;
    align-items: center;
    gap: 5px;
  }
  .progress {
    height: 2px;
    background: var(--border);
  }
  .progress div {
    height: 100%;
    background: var(--accent-strong);
    transition: width 0.15s;
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 0 6px 2px 14px;
  }
  .stepper .icon-btn {
    width: 28px;
    height: 28px;
  }
  .summary {
    flex: 1;
    font-size: 12px;
  }
  .group-label {
    padding: 8px 8px 2px;
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .hit {
    display: block;
    width: 100%;
    padding: 6px 8px;
    border-radius: var(--radius-sm);
    text-align: left;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }
  .hit:hover {
    background: var(--hover);
  }
  .hit.active {
    background: var(--accent-soft);
  }
  mark {
    background: var(--hl-yellow);
    color: #1e1b18;
    border-radius: 2px;
  }
</style>
