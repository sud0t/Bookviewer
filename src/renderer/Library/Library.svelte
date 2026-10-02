<script lang="ts">
  import type { Book, Folder, Settings } from '@shared/types'
  import Icon from '../lib/Icon.svelte'
  import { app, openBook, refreshLibrary, toast, updateSettings } from '../lib/app.svelte'
  import { ipc } from '../lib/ipc'
  import BookCard from './BookCard.svelte'
  import Catalogs from './Catalogs.svelte'
  import { FORMAT_GROUPS, matchesFilter, sortBooks, type LibraryFilter } from './formats'
  import { processPending } from './meta'

  let catalogsOpen = $state(false)

  let filter = $state<LibraryFilter>({ kind: 'all' })
  let query = $state('')
  let menu = $state<{ book: Book; x: number; y: number } | null>(null)

  const scanning = $derived(Object.values(app.scanning).some(Boolean))
  const visible = $derived.by(() => {
    const needle = query.trim().toLowerCase()
    const books = app.books.filter(
      book =>
        matchesFilter(book, filter) &&
        (!needle ||
          book.title.toLowerCase().includes(needle) ||
          book.author.toLowerCase().includes(needle)),
    )
    return sortBooks(books, app.settings.librarySort)
  })
  const groups = $derived(
    FORMAT_GROUPS.map(group => ({
      ...group,
      count: app.books.filter(book => group.formats.includes(book.format)).length,
    })).filter(group => group.count > 0),
  )
  const readingCount = $derived(app.books.filter(b => matchesFilter(b, { kind: 'reading' })).length)
  const heading = $derived.by(() => {
    switch (filter.kind) {
      case 'all':
        return 'All books'
      case 'reading':
        return 'Continue reading'
      case 'format': {
        const { group } = filter
        return FORMAT_GROUPS.find(g => g.id === group)?.label ?? ''
      }
      case 'folder': {
        const { id } = filter
        return folderName(app.folders.find(f => f.id === id))
      }
    }
  })

  // Whenever the list changes, pick up books that still need metadata.
  $effect(() => {
    if (app.books.some(book => book.metaState === 'pending')) void processPending()
  })

  // A filter on something that no longer exists falls back to everything.
  $effect(() => {
    if (filter.kind === 'folder') {
      const { id } = filter
      if (!app.folders.some(f => f.id === id)) filter = { kind: 'all' }
    }
  })

  function folderName(folder: Folder | undefined): string {
    if (!folder) return ''
    return folder.path.split('/').filter(Boolean).pop() ?? folder.path
  }

  const isActive = (candidate: LibraryFilter): boolean =>
    !catalogsOpen && JSON.stringify(candidate) === JSON.stringify(filter)

  function show(next: LibraryFilter) {
    filter = next
    catalogsOpen = false
  }

  async function addFolder() {
    const added = await ipc.invoke('folders:add')
    if (added.length) {
      await refreshLibrary()
      filter = { kind: 'all' }
    }
  }

  async function removeFolder(folder: Folder) {
    const ok = confirm(
      `Remove “${folderName(folder)}” from the library?\n\n` +
        'The files stay where they are, but reading progress, bookmarks and highlights ' +
        'for its books will be deleted.',
    )
    if (!ok) return
    await ipc.invoke('folders:remove', folder.id)
    await refreshLibrary()
  }

  async function rescan() {
    await ipc.invoke('folders:rescan')
    await refreshLibrary()
    toast('Library rescanned')
  }

  function open(book: Book) {
    menu = null
    openBook(book.id)
  }

  function showMenu(book: Book, event: MouseEvent) {
    menu = {
      book,
      x: Math.min(event.clientX, innerWidth - 200),
      y: Math.min(event.clientY, innerHeight - 110),
    }
  }

  const SORTS: { value: Settings['librarySort']; label: string }[] = [
    { value: 'recent', label: 'Recently read' },
    { value: 'title', label: 'Title' },
    { value: 'author', label: 'Author' },
    { value: 'added', label: 'Date added' },
    { value: 'progress', label: 'Progress' },
  ]
</script>

<svelte:window
  onclick={() => (menu = null)}
  onkeydown={event => {
    if (event.key === 'Escape') menu = null
  }}
/>

<div class="library">
  <aside class="scroll">
    <div class="brand">
      <Icon name="library" size={20} />
      <span>BookViewer</span>
    </div>

    <nav>
      <button class="item" class:active={isActive({ kind: 'all' })} onclick={() => show({ kind: 'all' })}>
        <Icon name="book" size={16} />
        <span class="ellipsis">All books</span>
        <span class="count">{app.books.length}</span>
      </button>
      {#if readingCount}
        <button
          class="item"
          class:active={isActive({ kind: 'reading' })}
          onclick={() => show({ kind: 'reading' })}
        >
          <Icon name="clock" size={16} />
          <span class="ellipsis">Continue reading</span>
          <span class="count">{readingCount}</span>
        </button>
      {/if}

      {#if groups.length > 1}
        <h3>Formats</h3>
        {#each groups as group (group.id)}
          <button
            class="item"
            class:active={isActive({ kind: 'format', group: group.id })}
            onclick={() => show({ kind: 'format', group: group.id })}
          >
            <Icon name={group.id === 'web' ? 'globe' : 'file'} size={16} />
            <span class="ellipsis">{group.label}</span>
            <span class="count">{group.count}</span>
          </button>
        {/each}
      {/if}

      <h3>Folders</h3>
      {#each app.folders as folder (folder.id)}
        <div class="item-row">
          <button
            class="item"
            class:active={isActive({ kind: 'folder', id: folder.id })}
            title={folder.missing ? `${folder.path} (not found)` : folder.path}
            onclick={() => show({ kind: 'folder', id: folder.id })}
          >
            <Icon name="folder" size={16} />
            <span class="ellipsis" class:missing={folder.missing}>{folderName(folder)}</span>
            <span class="count">{app.scanning[folder.id] ? '…' : folder.bookCount}</span>
          </button>
          <button
            class="icon-btn remove"
            title="Remove folder from library"
            aria-label="Remove folder from library"
            onclick={() => removeFolder(folder)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      {/each}
      <button class="item add" onclick={addFolder}>
        <Icon name="folder-plus" size={16} />
        <span>Add folder…</span>
      </button>

      <h3>Online</h3>
      <button class="item" class:active={catalogsOpen} onclick={() => (catalogsOpen = true)}>
        <Icon name="rss" size={16} />
        <span>OPDS catalogs</span>
      </button>
    </nav>
  </aside>

  {#if catalogsOpen}
    <Catalogs onclose={() => (catalogsOpen = false)} />
  {:else}
  <main>
    <header>
      <h1 class="ellipsis">{heading}</h1>
      <div class="search">
        <Icon name="search" size={15} />
        <input
          class="input"
          type="search"
          placeholder="Search title or author"
          bind:value={query}
        />
      </div>
      <select
        class="input"
        aria-label="Sort by"
        value={app.settings.librarySort}
        onchange={event => updateSettings({ librarySort: event.currentTarget.value as Settings['librarySort'] })}
      >
        {#each SORTS as sort (sort.value)}
          <option value={sort.value}>{sort.label}</option>
        {/each}
      </select>
      <button
        class="icon-btn"
        title={app.settings.libraryView === 'grid' ? 'Show as list' : 'Show as grid'}
        aria-label="Toggle grid or list"
        onclick={() =>
          updateSettings({ libraryView: app.settings.libraryView === 'grid' ? 'list' : 'grid' })}
      >
        <Icon name={app.settings.libraryView === 'grid' ? 'rows' : 'grid'} />
      </button>
      <button
        class="icon-btn"
        class:spinning={scanning}
        title="Rescan folders"
        aria-label="Rescan folders"
        disabled={scanning || !app.folders.length}
        onclick={rescan}
      >
        <Icon name="refresh" />
      </button>
    </header>

    <div class="content scroll">
      {#if !app.folders.length}
        <div class="empty">
          <Icon name="library" size={48} />
          <h2>Your library is empty</h2>
          <p class="muted">
            Add a folder and BookViewer will index the EPUB, PDF, MOBI, FB2 and CBZ files in it,
            along with any saved HTML books (mdBook, Sphinx, Jupyter Book and the like).
          </p>
          <button class="btn primary" onclick={addFolder}>
            <Icon name="folder-plus" size={16} /> Add folder…
          </button>
        </div>
      {:else if !visible.length}
        <div class="empty">
          <h2>{scanning ? 'Scanning…' : 'No books here'}</h2>
          {#if !scanning}
            <p class="muted">
              {query ? 'Nothing matches your search.' : 'No supported books were found.'}
            </p>
          {/if}
        </div>
      {:else}
        <div class={app.settings.libraryView === 'grid' ? 'grid' : 'rows'}>
          {#each visible as book (book.id)}
            <BookCard
              {book}
              list={app.settings.libraryView === 'list'}
              onopen={open}
              onmenu={showMenu}
            />
          {/each}
        </div>
      {/if}
    </div>
  </main>
  {/if}
</div>

{#if menu}
  {@const book = menu.book}
  <div class="menu" style:left="{menu.x}px" style:top="{menu.y}px" role="menu">
    <button role="menuitem" onclick={() => open(book)}>
      <Icon name="book" size={15} /> Open
    </button>
    <button role="menuitem" onclick={() => ipc.invoke('books:showInFolder', book.id)}>
      <Icon name="folder" size={15} /> Show in file manager
    </button>
  </div>
{/if}

<style>
  .library {
    display: grid;
    grid-template-columns: 232px minmax(0, 1fr);
    height: 100%;
  }
  aside {
    border-right: 1px solid var(--border);
    background: var(--surface-2);
    padding: 12px 8px;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 4px 8px 14px;
    font-weight: 700;
    font-size: 15px;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  h3 {
    margin: 16px 8px 4px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
    color: var(--fg-muted);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    min-width: 0;
    height: 30px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .item:hover {
    background: var(--hover);
  }
  .item.active {
    background: var(--active);
    font-weight: 600;
  }
  .item .ellipsis {
    flex: 1;
  }
  .item.add {
    color: var(--fg-muted);
  }
  .count {
    font-size: 12px;
    color: var(--fg-muted);
    font-weight: 400;
  }
  .missing {
    text-decoration: line-through;
    opacity: 0.6;
  }
  .item-row {
    position: relative;
    display: flex;
  }
  .remove {
    position: absolute;
    right: 2px;
    top: 3px;
    width: 24px;
    height: 24px;
    opacity: 0;
    background: var(--surface-2);
  }
  .item-row:hover .remove,
  .remove:focus-visible {
    opacity: 1;
  }

  main {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    flex: 1;
    font-size: 18px;
    font-weight: 700;
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
    color: var(--fg-muted);
  }
  .search :global(svg) {
    position: absolute;
    left: 9px;
    pointer-events: none;
  }
  .search input {
    width: 230px;
    padding-left: 30px;
    color: var(--fg);
  }
  .content {
    flex: 1;
    padding: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(158px, 1fr));
    gap: 4px;
    align-items: start;
  }
  .rows {
    display: flex;
    flex-direction: column;
    max-width: 1100px;
    margin: 0 auto;
  }
  .empty {
    height: 100%;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 12px;
    text-align: center;
    color: var(--fg-muted);
  }
  .empty h2 {
    color: var(--fg);
    font-size: 18px;
  }
  .empty p {
    max-width: 420px;
  }
  .spinning :global(svg) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
