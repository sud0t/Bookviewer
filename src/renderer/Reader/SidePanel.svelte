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
  <div class="tabs" role="tablist">
    {#each TABS as item (item.id)}
      <button
        role="tab"
        aria-selected={tab === item.id}
        class:active={tab === item.id}
        title={item.label}
        onclick={() => (item.id === 'search' ? focusSearch() : (tab = item.id))}
      >
        <Icon name={item.icon} size={16} />
        {#if item.id === 'notes' && store.annotations.length}
          <span class="count">{store.annotations.length}</span>
        {/if}
      </button>
    {/each}
    <span class="spacer"></span>
    <button class="icon-btn" title="Close panel" aria-label="Close panel" onclick={onclose}>
      <Icon name="x" size={16} />
    </button>
  </div>

  {#if tab === 'contents'}
    <div class="body scroll" bind:this={tocScroller}>
      {#if flat(engine.toc)}
        <TocTree items={engine.toc} current={tocId} onselect={item => item.target && onnavigate(item.target)} />
      {:else}
        <p class="empty muted">This book has no table of contents.</p>
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
        <button class="btn" onclick={() => onexport('markdown')}>
          <Icon name="export" size={15} /> Markdown
        </button>
        <button class="btn" onclick={() => onexport('json')}>
          <Icon name="export" size={15} /> JSON
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
            onclick={() => store.removeBookmark(bookmark.id)}
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
          bind:this={input}
          bind:value={searchQuery}
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
    <div class="body scroll">
      {#if searched}
        <p class="summary muted">
          {total} result{total === 1 ? '' : 's'} for “{searched}”{progress != null ? '…' : ''}
        </p>
      {/if}
      {#each groups as group, g (g)}
        <div class="group-label ellipsis">{group.label}</div>
        {#each group.hits as hit, i (hitKey(hit, i))}
          <button class="hit" onclick={() => onnavigate(hit.target)}>
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
    padding: 6px;
    border-bottom: 1px solid var(--border);
  }
  .tabs [role='tab'] {
    position: relative;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 38px;
    height: 32px;
    border-radius: var(--radius-sm);
    color: var(--fg-muted);
  }
  .tabs [role='tab']:hover {
    background: var(--hover);
  }
  .tabs [role='tab'].active {
    background: var(--active);
    color: var(--accent);
  }
  .count {
    position: absolute;
    top: 1px;
    right: 1px;
    min-width: 14px;
    padding: 0 3px;
    border-radius: 7px;
    font-size: 9px;
    line-height: 14px;
    background: var(--accent);
    color: var(--accent-fg);
  }
  .spacer {
    flex: 1;
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
    gap: 6px;
    padding: 8px;
    border-top: 1px solid var(--border);
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
  .options input {
    accent-color: var(--accent);
  }
  .progress {
    height: 2px;
    background: var(--border);
  }
  .progress div {
    height: 100%;
    background: var(--accent);
    transition: width 0.15s;
  }
  .summary {
    padding: 4px 8px 6px;
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
  mark {
    background: color-mix(in srgb, var(--hl-yellow) 60%, transparent);
    color: inherit;
    border-radius: 2px;
  }
</style>
