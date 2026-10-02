<script lang="ts">
  import type { Book, Folder, Settings } from '@shared/types'
  import appIcon from '../../../build/icon.svg'
  import Dialog from '../lib/Dialog.svelte'
  import Icon from '../lib/Icon.svelte'
  import Shortcuts from '../lib/Shortcuts.svelte'
  import ThemePicker from '../lib/ThemePicker.svelte'
  import { app, openBook, refreshBook, refreshLibrary, toast, updateSettings } from '../lib/app.svelte'
  import { ipc } from '../lib/ipc'
  import BookCard from './BookCard.svelte'
  import Catalogs from './Catalogs.svelte'
  import Cover from './Cover.svelte'
  import { FORMAT_GROUPS, FORMAT_LABELS, matchesFilter, sortBooks, type LibraryFilter } from './formats'
  import { processPending } from './meta'
  import { version } from '../../../package.json'

  let catalogsOpen = $state(false)

  let filter = $state<LibraryFilter>({ kind: 'all' })
  let query = $state('')
  let menu = $state<{ book: Book; x: number; y: number } | null>(null)
  let searchInput = $state<HTMLInputElement>()
  let catalogs = $state<Catalogs>()
  let details = $state<Book | null>(null)
  let removing = $state<Folder | null>(null)
  let settingsOpen = $state(false)
  let shortcutsOpen = $state(false)

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
  const inView = $derived(app.books.filter(book => matchesFilter(book, filter)).length)
  const countText = $derived(
    query.trim() ? `${visible.length} of ${inView}` : `${inView} ${inView === 1 ? 'book' : 'books'}`,
  )
  /** Folder names as shown: two folders with the same name also say where they are. */
  const folderLabels = $derived.by(() => {
    const names = app.folders.map(folder => folderName(folder))
    return new Map(
      app.folders.map((folder, i) => {
        const twin = names.indexOf(names[i]) !== names.lastIndexOf(names[i])
        const parent = folder.path.split('/').filter(Boolean).at(-2)
        return [folder.id, twin && parent ? `${names[i]} (${parent})` : names[i]]
      }),
    )
  })
  /** Books in progress, most recently opened first: the quickest way back in. */
  const resume = $derived(
    filter.kind === 'all' && !query.trim()
      ? sortBooks(
          app.books.filter(book => !book.missing && matchesFilter(book, { kind: 'reading' })),
          'recent',
        ).slice(0, 3)
      : [],
  )
  const heading = $derived.by(() => {
    switch (filter.kind) {
      case 'all':
        return 'Library'
      case 'reading':
        return 'Continue reading'
      case 'format': {
        const { group } = filter
        return FORMAT_GROUPS.find(g => g.id === group)?.label ?? ''
      }
      case 'folder': {
        const { id } = filter
        return folderLabels.get(id) ?? ''
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

  function showCatalogs() {
    // already there: the sidebar item leads back to the list of catalogs
    if (catalogsOpen) catalogs?.home()
    catalogsOpen = true
  }

  async function addFolder() {
    const added = await ipc.invoke('folders:add')
    if (added.length) {
      await refreshLibrary()
      filter = { kind: 'all' }
    }
  }

  async function removeFolder(folder: Folder) {
    removing = null
    await ipc.invoke('folders:remove', folder.id)
    await refreshLibrary()
    toast(`Removed “${folderName(folder)}” from the library`)
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
    // opened from the keyboard or the card's button: hang it off that element
    const from = event.clientX || event.clientY ? null : (event.currentTarget as HTMLElement | null)
    const box = from?.getBoundingClientRect()
    menu = {
      book,
      x: Math.min(box ? box.left : event.clientX, innerWidth - 230),
      y: Math.min(box ? box.bottom + 4 : event.clientY, innerHeight - 190),
    }
    event.stopPropagation()
  }

  /** Arrow keys inside an open menu; focus starts on its first item. */
  function menuKeys(node: HTMLElement) {
    const items = () => [...node.querySelectorAll<HTMLElement>('button:not(:disabled)')]
    const previous = document.activeElement as HTMLElement | null
    items()[0]?.focus()
    const onkey = (event: KeyboardEvent) => {
      const all = items()
      const at = all.indexOf(document.activeElement as HTMLElement)
      let next = -1
      if (event.key === 'ArrowDown') next = (at + 1) % all.length
      else if (event.key === 'ArrowUp') next = (at - 1 + all.length) % all.length
      else if (event.key === 'Home') next = 0
      else if (event.key === 'End') next = all.length - 1
      else if (event.key === 'Tab') menu = null
      if (next < 0) return
      event.preventDefault()
      all[next]?.focus()
    }
    node.addEventListener('keydown', onkey)
    return {
      destroy() {
        node.removeEventListener('keydown', onkey)
        // (focus falls to the body when the item that had it is removed)
        const active = document.activeElement
        if (!active || active === document.body || node.contains(active)) previous?.focus?.()
      },
    }
  }

  /** The settings popover takes the keyboard while it is open and gives it back after. */
  function popoverFocus(node: HTMLElement) {
    const previous = document.activeElement as HTMLElement | null
    node.querySelector<HTMLElement>('button')?.focus()
    return {
      destroy() {
        const active = document.activeElement
        if (!active || active === document.body || node.contains(active)) previous?.focus?.()
      },
    }
  }

  async function setRead(book: Book, finished: boolean) {
    menu = null
    const { id, title, progress, location } = $state.snapshot(book) as Book
    // "unread" also forgets the place, so the book opens at its start again
    await ipc.invoke('books:setProgress', id, finished ? 1 : 0, finished ? (location ?? '') : '')
    await refreshBook(id)
    toast(`Marked “${title}” as ${finished ? 'finished' : 'unread'}`, {
      action: {
        label: 'Undo',
        undo: true,
        run: () => void ipc.invoke('books:setProgress', id, progress, location ?? '').then(() => refreshBook(id)),
      },
    })
  }

  function size(bytes: number): string {
    if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
    return `${(bytes / 1024 / 1024).toFixed(1)} MB`
  }
  const day = (time: number) => new Date(time).toLocaleDateString(undefined, { dateStyle: 'medium' })
  /** Descriptions come from the book's metadata and may carry markup. */
  const plain = (html: string) => new DOMParser().parseFromString(html, 'text/html').body.textContent?.trim() ?? ''
  const tidyPath = (path: string) => path.replace(/^\/home\/[^/]+/, '~')

  // Back from a book: put the keyboard where the reader left off.
  $effect(() => {
    if (app.view !== 'library' || app.lastBookId == null) return
    const id = app.lastBookId
    app.lastBookId = null
    requestAnimationFrame(() => {
      const card = document.querySelector<HTMLElement>(`.card[data-id="${id}"] .open`)
      card?.focus({ preventScroll: true })
      card?.scrollIntoView({ block: 'nearest' })
    })
  })

  const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto' })
  /** "today", "yesterday", "3 days ago", "2 months ago". */
  function lastOpened(time: number | null): string {
    if (!time) return ''
    // calendar days, so that last night is "yesterday" and this morning "today"
    const midnight = (at: number) => new Date(at).setHours(0, 0, 0, 0)
    const days = Math.round((midnight(time) - midnight(Date.now())) / 86_400_000)
    if (days > -1) return relative.format(0, 'day')
    if (days > -45) return relative.format(days, 'day')
    if (days > -540) return relative.format(Math.round(days / 30), 'month')
    return relative.format(Math.round(days / 365), 'year')
  }

  function onKeydown(event: KeyboardEvent) {
    if (event.key === 'Escape') {
      menu = null
      settingsOpen = false
      if (document.activeElement === searchInput && query) query = ''
      return
    }
    // only when the library is what is on screen
    if (app.view !== 'library') return
    if (event.key === 'F11') {
      event.preventDefault()
      void ipc.invoke('window:setFullscreen', !app.fullscreen)
      return
    }
    if (catalogsOpen) return
    const typing = (event.target as HTMLElement | null)?.closest?.('input, textarea, select')
    const find = (event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'f'
    if (find || (event.key === '/' && !typing)) {
      event.preventDefault()
      searchInput?.focus()
      searchInput?.select()
    } else if (event.key === '?' && !typing) {
      shortcutsOpen = true
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
  onclick={event => {
    menu = null
    if (settingsOpen && !(event.target as Element).closest('.settings, .settings-toggle')) settingsOpen = false
  }}
  onkeydown={onKeydown}
/>

<div class="library">
  <aside class="scroll">
    <div class="brand">
      <img src={appIcon} width="30" height="30" alt="" />
      <span>BookViewer</span>
    </div>

    <nav aria-label="Library">
      <button
        class="item"
        class:active={isActive({ kind: 'all' })}
        aria-current={isActive({ kind: 'all' }) ? 'page' : undefined}
        title="All books"
        onclick={() => show({ kind: 'all' })}
      >
        <Icon name="library" size={16} />
        <span class="ellipsis">All books</span>
        <span class="count">{app.books.length}</span>
      </button>
      <button
        class="item"
        class:active={isActive({ kind: 'reading' })}
        aria-current={isActive({ kind: 'reading' }) ? 'page' : undefined}
        title="Continue reading"
        onclick={() => show({ kind: 'reading' })}
      >
        <Icon name="clock" size={16} />
        <span class="ellipsis">Continue reading</span>
        <span class="count">{readingCount || ''}</span>
      </button>

      {#if groups.length > 1}
        <h3>Formats</h3>
        {#each groups as group (group.id)}
          <button
            class="item"
            class:active={isActive({ kind: 'format', group: group.id })}
            aria-current={isActive({ kind: 'format', group: group.id }) ? 'page' : undefined}
            title={group.label}
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
            aria-current={isActive({ kind: 'folder', id: folder.id }) ? 'page' : undefined}
            title={folder.missing ? `${folder.path} (not found)` : folder.path}
            onclick={() => show({ kind: 'folder', id: folder.id })}
          >
            <Icon name="folder" size={16} />
            <span class="ellipsis" class:missing={folder.missing}>{folderLabels.get(folder.id)}</span>
            <span class="count" class:warn={folder.missing}>
              {folder.missing ? 'not found' : app.scanning[folder.id] ? '…' : folder.bookCount}
            </span>
          </button>
          <button
            class="icon-btn remove"
            title="Remove this folder from the library…"
            aria-label="Remove {folderLabels.get(folder.id)} from the library"
            onclick={() => (removing = folder)}
          >
            <Icon name="x" size={14} />
          </button>
        </div>
      {/each}
      <button class="item add" title="Add folder…" onclick={addFolder}>
        <Icon name="folder-plus" size={16} />
        <span>Add folder…</span>
      </button>

      <h3>Online</h3>
      <button
        class="item"
        class:active={catalogsOpen}
        aria-current={catalogsOpen ? 'page' : undefined}
        title="Browse and download from online libraries (OPDS catalogs)"
        onclick={showCatalogs}
      >
        <Icon name="rss" size={16} />
        <span>Catalogs</span>
      </button>
    </nav>

    <div class="aside-foot">
      <button
        class="item settings-toggle"
        class:active={settingsOpen}
        title="Theme, keyboard shortcuts"
        aria-haspopup="dialog"
        aria-expanded={settingsOpen}
        onclick={() => (settingsOpen = !settingsOpen)}
      >
        <Icon name="sliders" size={16} />
        <span>Settings</span>
      </button>
    </div>
  </aside>

  {#if catalogsOpen}
    <Catalogs bind:this={catalogs} onclose={() => (catalogsOpen = false)} />
  {:else}
  <main>
    <header>
      <h1 class="ellipsis">
        {heading}
        {#if app.folders.length}<span class="total muted">{countText}</span>{/if}
      </h1>
      {#if app.folders.length}
      <div class="search">
        <Icon name="search" size={15} />
        <input
          class="input"
          type="search"
          placeholder="Search title or author"
          aria-label="Search title or author"
          bind:this={searchInput}
          bind:value={query}
        />
        {#if !query}<kbd title="Press / to search">/</kbd>{/if}
      </div>
      <label class="sort">
        <span class="muted">Sort</span>
        <select
          class="input"
          value={app.settings.librarySort}
          onchange={event => updateSettings({ librarySort: event.currentTarget.value as Settings['librarySort'] })}
        >
          {#each SORTS as sort (sort.value)}
            <option value={sort.value}>{sort.label}</option>
          {/each}
        </select>
      </label>
      <div class="views" role="group" aria-label="View">
        <button
          class:selected={app.settings.libraryView === 'grid'}
          title="Grid of covers"
          aria-label="Grid view"
          aria-pressed={app.settings.libraryView === 'grid'}
          onclick={() => updateSettings({ libraryView: 'grid' })}
        >
          <Icon name="grid" size={16} />
        </button>
        <button
          class:selected={app.settings.libraryView === 'list'}
          title="List"
          aria-label="List view"
          aria-pressed={app.settings.libraryView === 'list'}
          onclick={() => updateSettings({ libraryView: 'list' })}
        >
          <Icon name="list" size={16} />
        </button>
      </div>
      <button
        class="icon-btn"
        class:spinning={scanning}
        title={scanning ? 'Looking for new books…' : 'Look for new books in your folders'}
        aria-label="Rescan folders"
        disabled={scanning || !app.folders.length}
        onclick={rescan}
      >
        <Icon name="refresh" />
      </button>
      {/if}
    </header>

    <div class="content scroll">
      {#if !app.folders.length}
        <div class="empty">
          <img src={appIcon} width="84" height="84" alt="" />
          <h2>Add a folder to start your library</h2>
          <p class="muted">
            BookViewer reads the EPUB, PDF, MOBI, FB2 and CBZ files in it, and any books saved
            from the web (mdBook, Sphinx, Jupyter Book and the like). Your files stay where they are.
          </p>
          <button class="btn primary" onclick={addFolder}>
            <Icon name="folder-plus" size={16} /> Add folder…
          </button>
        </div>
      {:else if !visible.length}
        <div class="empty">
          {#if scanning}
            <h2>Looking for books…</h2>
          {:else if query}
            <h2>Nothing in {filter.kind === 'all' ? 'your library' : `“${heading}”`} matches “{query}”</h2>
            <p class="muted">Search looks at titles and authors. Check the spelling or try fewer words.</p>
            <div class="empty-actions">
              {#if filter.kind !== 'all'}
                <button class="btn" onclick={() => show({ kind: 'all' })}>Search all books</button>
              {/if}
              <button class="btn" onclick={() => (query = '')}>Clear search</button>
            </div>
          {:else if filter.kind === 'reading'}
            <h2>Nothing in progress</h2>
            <p class="muted">Books you have started, and not finished, are listed here.</p>
            <button class="btn" onclick={() => show({ kind: 'all' })}>Show all books</button>
          {:else}
            <h2>No books here yet</h2>
            <p class="muted">No EPUB, PDF, MOBI, FB2, CBZ or saved web books were found here.</p>
          {/if}
        </div>
      {:else}
        {#if resume.length}
          <section class="resume" aria-labelledby="resume-heading">
            <h2 id="resume-heading">Continue reading</h2>
            <div class="shelf">
              {#each resume as book (book.id)}
                <button class="resume-card" title="Continue “{book.title}”" onclick={() => open(book)}>
                  <span class="resume-cover"><Cover {book} bare /></span>
                  <span class="resume-text">
                    <strong>{book.title}</strong>
                    {#if book.author}<span class="muted ellipsis">{book.author}</span>{/if}
                    <span class="resume-progress" aria-hidden="true">
                      <span style:width="{Math.round(book.progress * 100)}%"></span>
                    </span>
                    <span class="muted resume-meta">
                      {FORMAT_LABELS[book.format]}, {Math.round(book.progress * 100)}% read{book.lastOpenedAt ? `, opened ${lastOpened(book.lastOpenedAt)}` : ''}
                    </span>
                  </span>
                </button>
              {/each}
            </div>
          </section>
          <h2 class="section-heading">All books</h2>
        {/if}
        {#if app.settings.libraryView === 'list'}
          <div class="rows">
            <div class="rows-head muted" aria-hidden="true">
              <span></span><span>Title</span><span>Author</span><span>Format</span><span>Progress</span>
            </div>
            {#each visible as book (book.id)}
              <BookCard {book} list onopen={open} onmenu={showMenu} />
            {/each}
          </div>
        {:else}
          <div class="grid">
            {#each visible as book (book.id)}
              <BookCard {book} onopen={open} onmenu={showMenu} />
            {/each}
          </div>
        {/if}
      {/if}
    </div>
  </main>
  {/if}
</div>

{#if menu}
  {@const book = menu.book}
  <div class="menu" style:left="{menu.x}px" style:top="{menu.y}px" role="menu" use:menuKeys>
    <button role="menuitem" onclick={() => open(book)}>
      <Icon name="book" size={15} /> {book.progress > 0 && book.progress < 0.99 ? 'Continue reading' : 'Open'}
    </button>
    <button
      role="menuitem"
      onclick={() => {
        details = book
        menu = null
      }}
    >
      <Icon name="info" size={15} /> Book details
    </button>
    <hr />
    {#if book.progress < 0.99}
      <button role="menuitem" onclick={() => setRead(book, true)}>
        <Icon name="check" size={15} /> Mark as finished
      </button>
    {/if}
    {#if book.progress > 0}
      <button role="menuitem" onclick={() => setRead(book, false)}>
        <Icon name="undo" size={15} /> Mark as unread
      </button>
    {/if}
    <hr />
    <button role="menuitem" onclick={() => ipc.invoke('books:showInFolder', book.id)}>
      <Icon name="folder" size={15} /> Show in file manager
    </button>
  </div>
{/if}

{#if settingsOpen}
  <div class="settings" role="dialog" aria-label="Settings" use:popoverFocus>
    <div class="label">Theme</div>
    <ThemePicker />
    <hr />
    <button
      class="row"
      onclick={() => {
        settingsOpen = false
        shortcutsOpen = true
      }}
    >
      <Icon name="keyboard" size={15} /> <span>Keyboard shortcuts</span> <kbd>?</kbd>
    </button>
    <p class="muted about">BookViewer {version}</p>
  </div>
{/if}

{#if shortcutsOpen}
  <Shortcuts onclose={() => (shortcutsOpen = false)} />
{/if}

{#if details}
  {@const book = details}
  {@const folder = app.folders.find(f => f.id === book.folderId)}
  <Dialog title="Book details" width={620} onclose={() => (details = null)}>
    <div class="details">
      <div class="details-cover"><Cover {book} /></div>
      <div class="details-text">
        <h3>{book.title}</h3>
        {#if book.author}<p class="muted">{book.author}</p>{/if}
        <dl>
          <div><dt>Progress</dt><dd>{book.progress >= 0.99 ? 'Finished' : book.progress > 0 ? `${Math.max(1, Math.round(book.progress * 100))}% read` : 'Not started'}{book.lastOpenedAt ? `, opened ${lastOpened(book.lastOpenedAt)}` : ''}</dd></div>
          <div><dt>Format</dt><dd>{FORMAT_LABELS[book.format]}, {size(book.size)}</dd></div>
          {#if book.publisher}<div><dt>Publisher</dt><dd>{book.publisher}</dd></div>{/if}
          {#if book.published}<div><dt>Published</dt><dd>{book.published}</dd></div>{/if}
          {#if book.language}<div><dt>Language</dt><dd>{book.language}</dd></div>{/if}
          <div><dt>Added</dt><dd>{day(book.addedAt)}</dd></div>
          <div><dt>File</dt><dd class="path">{tidyPath(book.path)}</dd></div>
          {#if folder?.missing || book.missing}
            <div><dt></dt><dd class="warn">This file can’t be found right now.</dd></div>
          {/if}
        </dl>
        {#if book.description}<p class="description">{plain(book.description)}</p>{/if}
      </div>
    </div>
    {#snippet footer()}
      <button class="btn" onclick={() => ipc.invoke('books:showInFolder', book.id)}>
        <Icon name="folder" size={15} /> Show in file manager
      </button>
      <button
        class="btn primary"
        data-autofocus
        onclick={() => {
          // (`book` is read from `details`: keep hold of it before clearing that)
          const target = book
          details = null
          open(target)
        }}
      >
        {book.progress > 0 && book.progress < 0.99 ? 'Continue reading' : 'Open'}
      </button>
    {/snippet}
  </Dialog>
{/if}

{#if removing}
  {@const folder = removing}
  <Dialog title="Remove this folder from the library?" width={460} onclose={() => (removing = null)}>
    <p>
      <strong>{folderLabels.get(folder.id)}</strong>
      <span class="muted path">{tidyPath(folder.path)}</span>
    </p>
    <p>
      The files stay where they are. Reading progress, bookmarks and highlights for
      {folder.bookCount === 1 ? 'its book' : `its ${folder.bookCount} books`} will be deleted.
    </p>
    {#snippet footer()}
      <button class="btn" data-autofocus onclick={() => (removing = null)}>Cancel</button>
      <button class="btn danger primary" onclick={() => removeFolder(folder)}>Remove folder</button>
    {/snippet}
  </Dialog>
{/if}

<style>
  .library {
    display: grid;
    grid-template-columns: 240px minmax(0, 1fr);
    /* one row exactly as tall as the window: the book list scrolls, not the page */
    grid-template-rows: minmax(0, 1fr);
    height: 100%;
  }
  aside {
    display: flex;
    flex-direction: column;
    border-right: 1px solid var(--border);
    background: var(--surface-2);
    padding: 14px 10px 10px;
  }
  .aside-foot {
    margin-top: auto;
    padding-top: 14px;
  }
  .settings {
    position: fixed;
    left: 10px;
    bottom: 52px;
    z-index: 100;
    width: 300px;
    padding: 14px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }
  .settings .label {
    margin: 0 0 8px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .settings hr {
    border: 0;
    border-top: 1px solid var(--border);
    margin: 12px 0 6px;
  }
  .settings .row {
    display: flex;
    align-items: center;
    gap: 8px;
    width: 100%;
    padding: 6px 8px;
    margin: 0 -8px;
    box-sizing: content-box;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .settings .row:hover {
    background: var(--hover);
  }
  .settings .row span {
    flex: 1;
  }
  .about {
    margin-top: 8px;
    font-size: 12px;
  }
  .warn {
    color: var(--danger);
  }
  .path {
    overflow-wrap: anywhere;
  }
  .details {
    display: flex;
    gap: 20px;
  }
  .details-cover {
    flex: none;
    width: 150px;
    aspect-ratio: 2 / 3;
    border-radius: 5px;
    overflow: hidden;
    box-shadow: var(--shadow);
  }
  .details-text {
    flex: 1;
    min-width: 0;
  }
  .details h3 {
    margin: 0 0 2px;
    font-size: 17px;
    font-weight: 600;
    color: var(--fg);
  }
  .details dl {
    margin: 12px 0 0;
    font-size: 13px;
  }
  .details dl div {
    display: grid;
    grid-template-columns: 84px minmax(0, 1fr);
    gap: 12px;
    padding: 3px 0;
  }
  .details dt {
    color: var(--fg-muted);
  }
  .details dd {
    margin: 0;
  }
  .description {
    margin-top: 12px;
    font-size: 13px;
    line-height: 1.5;
    max-height: 9em;
    overflow: auto;
  }
  p + p {
    margin-top: 10px;
  }
  p .path {
    display: block;
    font-size: 12.5px;
  }
  .empty-actions {
    display: flex;
    gap: 8px;
  }
  .total {
    margin-left: 8px;
    font-size: 13px;
    font-weight: 400;
    letter-spacing: 0;
  }
  .brand {
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 2px 8px 16px;
    font-weight: 700;
    font-size: 16px;
    letter-spacing: -0.01em;
  }
  .brand img {
    display: block;
    /* the icon has its own transparent margin */
    margin: -2px;
  }
  nav {
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  h3 {
    margin: 18px 8px 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 9px;
    width: 100%;
    min-width: 0;
    height: 32px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    text-align: left;
  }
  .item:hover {
    background: var(--hover);
  }
  .item.active {
    background: var(--accent-soft);
    color: var(--accent);
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
    font-variant-numeric: tabular-nums;
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
    right: 3px;
    top: 4px;
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
    min-height: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 10px;
    height: 56px;
    padding: 0 20px 0 24px;
    flex: none;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    flex: 1;
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
    color: var(--fg-muted);
  }
  .search :global(svg) {
    position: absolute;
    left: 10px;
    pointer-events: none;
  }
  .search input {
    width: 250px;
    padding-left: 32px;
    color: var(--fg);
  }
  .search kbd {
    position: absolute;
    right: 7px;
    pointer-events: none;
  }
  .sort {
    display: flex;
    align-items: center;
    gap: 6px;
    font-size: 13px;
  }
  .views {
    display: flex;
    padding: 2px;
    border-radius: 8px;
    background: var(--surface-2);
  }
  .views button {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 30px;
    height: 28px;
    border-radius: 6px;
    color: var(--fg-muted);
  }
  .views button.selected {
    background: var(--surface);
    color: var(--fg);
    box-shadow: 0 1px 2px rgb(0 0 0 / 0.14);
  }
  .content {
    flex: 1;
    padding: 18px 16px 24px;
  }
  h2 {
    font-size: 14px;
    font-weight: 600;
  }
  .resume {
    padding: 0 8px 22px;
  }
  .resume h2,
  .section-heading {
    margin: 0 0 10px;
  }
  .section-heading {
    padding: 0 8px;
  }
  .shelf {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(260px, 1fr));
    gap: 12px;
  }
  /* one book in progress should not stretch across the window */
  .shelf:has(> :only-child) {
    grid-template-columns: minmax(260px, 420px);
  }
  .resume-card {
    display: flex;
    align-items: center;
    gap: 14px;
    min-width: 0;
    padding: 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    text-align: left;
  }
  .resume-card:hover {
    border-color: color-mix(in srgb, var(--accent-strong) 55%, var(--border));
    box-shadow: var(--shadow);
  }
  .resume-cover {
    flex: none;
    width: 56px;
    aspect-ratio: 2 / 3;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
    box-shadow: var(--shadow);
  }
  .resume-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
  }
  .resume-text strong {
    font-weight: 600;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .resume-text .ellipsis {
    font-size: 12.5px;
  }
  .resume-progress {
    height: 4px;
    margin-top: 6px;
    border-radius: 2px;
    background: color-mix(in srgb, var(--fg-muted) 22%, transparent);
    overflow: hidden;
  }
  .resume-progress span {
    display: block;
    height: 100%;
    border-radius: 2px;
    background: var(--accent-strong);
  }
  .resume-meta {
    font-size: 12px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
    gap: 6px 4px;
    align-items: start;
  }
  .rows {
    display: flex;
    flex-direction: column;
    max-width: 1100px;
    margin: 0 auto;
  }
  .rows-head {
    display: grid;
    grid-template-columns: 44px minmax(0, 3fr) minmax(0, 2fr) 56px 130px;
    gap: 16px;
    padding: 0 44px 6px 10px;
    font-size: 12px;
    border-bottom: 1px solid var(--border);
    margin-bottom: 4px;
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
    max-width: 440px;
    line-height: 1.5;
  }
  .spinning :global(svg) {
    animation: spin 1s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (max-width: 900px) {
    .search input {
      width: 170px;
    }
    .sort span,
    .search kbd {
      display: none;
    }
  }
  /* A narrow window keeps the sidebar as a strip of icons (their names are tooltips). */
  @media (max-width: 720px) {
    .library {
      grid-template-columns: 52px minmax(0, 1fr);
    }
    aside {
      padding-inline: 6px;
      overflow-x: hidden;
    }
    .brand {
      padding-inline: 5px;
    }
    .brand span,
    h3,
    .remove {
      display: none;
    }
    /* still there for screen readers and as the button's name; just not drawn */
    .item span {
      position: absolute;
      width: 1px;
      height: 1px;
      overflow: hidden;
      clip-path: inset(50%);
    }
    .item {
      justify-content: center;
      padding: 0;
    }
    header {
      padding-inline: 12px;
    }
    .total {
      display: none;
    }
    .search {
      flex: 1;
    }
    .search input {
      width: 100%;
    }
  }
</style>
