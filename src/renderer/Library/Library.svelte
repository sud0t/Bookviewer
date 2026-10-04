<script lang="ts">
  import {
    EBOOK_EXTENSIONS,
    type Book,
    type Folder,
    type GrabProgress,
    type OfflineDictionary,
    type Settings,
  } from '@shared/types'
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

  /** A book opened on its own from outside the library sits in the list as a "folder" of one file. */
  const isLooseFile = (folder: Folder): boolean =>
    (folder.path.split('.').pop()?.toLowerCase() ?? '') in EBOOK_EXTENSIONS

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

  /* ---------- adding a book from a web address ---------- */

  let urlOpen = $state(false)
  let urlValue = $state('')
  /** What the reader picked; until they do, it goes by the shape of the address. */
  let urlScopeChoice = $state<'site' | 'page' | null>(null)
  let urlFolder = $state<number | null>(null)
  let grabbing = $state(false)
  let grabError = $state('')
  let grabProgress = $state<GrabProgress | null>(null)

  /** Folders a download can go into (not a book that is in the library on its own). */
  const saveFolders = $derived(app.folders.filter(folder => !folder.missing && !isLooseFile(folder)))
  const urlParsed = $derived.by(() => {
    const text = urlValue.trim()
    if (!text) return null
    try {
      return new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(text) ? text : 'https://' + text)
    } catch {
      return null
    }
  })
  const urlIsFile = $derived(!!urlParsed && /\.(pdf|epub|mobi|azw3?|fb2|fbz|cbz)$/i.test(urlParsed.pathname))
  /** An address that ends in a folder is a book's front page; one that names a page is that page. */
  const urlScope = $derived(
    urlScopeChoice ?? (!urlParsed || /(\/|\/index\.x?html?)$/i.test(urlParsed.pathname) ? 'site' : 'page'),
  )
  // (a block body: what a listener returns is sent back over the bridge, and reactive state cannot be)
  ipc.on('grab:progress', progress => {
    grabProgress = progress
  })

  function openUrlDialog() {
    urlValue = ''
    urlScopeChoice = null
    grabError = ''
    grabProgress = null
    urlFolder =
      saveFolders.find(folder => folder.id === app.settings.downloadFolderId)?.id ?? saveFolders[0]?.id ?? null
    urlOpen = true
  }

  function closeUrlDialog() {
    if (grabbing) void ipc.invoke('web:cancelGrab')
    urlOpen = false
  }

  async function grab() {
    if (!urlParsed || grabbing) return
    grabbing = true
    grabError = ''
    grabProgress = null
    try {
      const saved = await ipc.invoke('web:grab', urlParsed.href, urlFolder, urlScope)
      await refreshLibrary()
      urlOpen = false
      const what = saved.pages > 1 ? ` (${saved.pages} pages)` : ''
      toast(`Added “${saved.title}”${what} to the library`, {
        action: saved.bookId != null ? { label: 'Open', run: () => openBook(saved.bookId!) } : undefined,
      })
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      // (cancelling closes the dialog; there is nobody to tell)
      if (message !== 'Cancelled') grabError = message
    } finally {
      grabbing = false
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
      y: Math.min(box ? box.bottom + 4 : event.clientY, innerHeight - 230),
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

  /** Takes one book out of the list. Its file, and what was noted in it, stay. */
  async function removeBook(book: Book) {
    menu = null
    const { id, title } = book
    await ipc.invoke('books:setHidden', id, true)
    await refreshLibrary()
    toast(`Removed “${title}” from the library. The file is still on disk.`, {
      action: {
        label: 'Undo',
        undo: true,
        run: () => void ipc.invoke('books:setHidden', id, false).then(refreshLibrary),
      },
    })
  }

  async function restoreRemoved() {
    const count = app.hiddenBooks
    settingsOpen = false
    await ipc.invoke('books:restoreHidden')
    await refreshLibrary()
    toast(count === 1 ? 'Put 1 removed book back' : `Put ${count} removed books back`)
  }

  /** Arrow keys move between the books of the grid or list; true when one did. */
  function moveBetweenCards(event: KeyboardEvent): boolean {
    if (event.ctrlKey || event.altKey || event.metaKey || event.shiftKey) return false
    const card = (event.target as HTMLElement | null)?.closest?.('.card')
    const container = card?.parentElement
    if (!card || !container?.matches('.grid, .rows')) return false
    const cards = [...container.querySelectorAll<HTMLElement>(':scope > .card')]
    const at = cards.indexOf(card as HTMLElement)
    const isList = container.matches('.rows')
    const columns = isList ? 1 : cards.filter(c => c.offsetTop === cards[0].offsetTop).length
    const last = cards.length - 1
    let next = at
    if (event.key === 'ArrowRight' && !isList) next = at + 1
    else if (event.key === 'ArrowLeft' && !isList) next = at - 1
    else if (event.key === 'ArrowUp') next = at - columns
    else if (event.key === 'ArrowDown')
      // from the row above a short last row, go to its end rather than nowhere
      next = at + columns > last && Math.floor(at / columns) < Math.floor(last / columns) ? last : at + columns
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else return false
    if (next === at || next < 0 || next > last) return false
    event.preventDefault()
    const target = cards[next].querySelector<HTMLElement>('.open')
    target?.focus({ preventScroll: true })
    cards[next].scrollIntoView({ block: 'nearest' })
    return true
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
    if (moveBetweenCards(event)) return
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

  /** The offline dictionaries in use (read whenever the settings are opened). */
  let dictionaries = $state<OfflineDictionary[]>([])
  $effect(() => {
    if (settingsOpen) void ipc.invoke('dictionaries:list').then(found => (dictionaries = found.dictionaries))
  })

  async function chooseDictionaries() {
    const found = await ipc.invoke('dictionaries:choose')
    if (!found) return
    dictionaries = found.dictionaries
    // (the setting was stored by the main process; keep our copy in step)
    app.settings = await ipc.invoke('settings:get')
    toast(
      found.dictionaries.length
        ? `Using ${found.dictionaries.length} offline ${found.dictionaries.length === 1 ? 'dictionary' : 'dictionaries'}`
        : 'No StarDict dictionaries (.ifo, .idx and .dict files) were found in that folder',
    )
  }

  /** Languages offered for looking words up and translating (the services' own codes). */
  const LANGUAGES: [string, string][] = [
    ['ar', 'Arabic'], ['zh', 'Chinese'], ['cs', 'Czech'], ['da', 'Danish'], ['nl', 'Dutch'],
    ['en', 'English'], ['fi', 'Finnish'], ['fr', 'French'], ['de', 'German'], ['el', 'Greek'],
    ['he', 'Hebrew'], ['hi', 'Hindi'], ['hu', 'Hungarian'], ['id', 'Indonesian'], ['it', 'Italian'],
    ['ja', 'Japanese'], ['ko', 'Korean'], ['no', 'Norwegian'], ['pl', 'Polish'], ['pt', 'Portuguese'],
    ['ro', 'Romanian'], ['ru', 'Russian'], ['es', 'Spanish'], ['sv', 'Swedish'], ['tr', 'Turkish'],
    ['uk', 'Ukrainian'], ['vi', 'Vietnamese'],
  ]

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
            <Icon name={isLooseFile(folder) ? 'file' : 'folder'} size={16} />
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
      <button
        class="item add"
        title="Save a book or page from a web address, or download a PDF or e-book from one"
        onclick={openUrlDialog}
      >
        <Icon name="download" size={16} />
        <span>Add from web address…</span>
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
    <button role="menuitem" onclick={() => removeBook(book)}>
      <Icon name="x" size={15} /> Remove from library
    </button>
  </div>
{/if}

{#if settingsOpen}
  <div class="settings" role="dialog" aria-label="Settings" use:popoverFocus>
    <div class="label">Theme</div>
    <ThemePicker />
    <hr />
    <div class="label">Looking up words</div>
    <label class="lang" title="Used for the dictionary and Wikipedia when a book does not say what language it is in">
      <span>Books are in</span>
      <select
        class="input"
        value={app.settings.lookupLanguage}
        onchange={event => updateSettings({ lookupLanguage: event.currentTarget.value })}
      >
        {#each LANGUAGES as [code, name] (code)}<option value={code}>{name}</option>{/each}
      </select>
    </label>
    <label class="lang" title="The language “Translate” turns a selection into">
      <span>Translate into</span>
      <select
        class="input"
        value={app.settings.translateTarget}
        onchange={event => updateSettings({ translateTarget: event.currentTarget.value })}
      >
        {#each LANGUAGES as [code, name] (code)}<option value={code}>{name}</option>{/each}
      </select>
    </label>
    <p class="muted hint">A book that states its own language is looked up in that one.</p>
    <div class="lang offline" title="StarDict dictionaries (.ifo, .idx and .dict files). Words found in them are not looked up online.">
      <span>
        Offline dictionaries
        <small class="muted ellipsis">
          {dictionaries.length ? dictionaries.map(d => d.name).join(', ') : 'None found'}
        </small>
      </span>
      <button class="btn" onclick={chooseDictionaries}>Choose folder…</button>
    </div>
    <hr />
    <label class="check" title="Sends the title and author of a book without a cover to openlibrary.org">
      <input
        type="checkbox"
        checked={app.settings.onlineCovers}
        onchange={event => updateSettings({ onlineCovers: event.currentTarget.checked })}
      />
      <span>Find missing covers online (Open Library)</span>
    </label>
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
    {#if app.hiddenBooks}
      <button class="row" onclick={restoreRemoved}>
        <Icon name="undo" size={15} />
        <span>Put back removed {app.hiddenBooks === 1 ? 'book' : `books (${app.hiddenBooks})`}</span>
      </button>
    {/if}
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

{#if urlOpen}
  <Dialog title="Add from a web address" width={540} onclose={closeUrlDialog}>
    <form
      id="grab-form"
      class="grab"
      onsubmit={event => {
        event.preventDefault()
        void grab()
      }}
    >
      <label class="grab-field">
        <span>Address of the book, page, PDF or e-book</span>
        <input
          class="input"
          type="text"
          inputmode="url"
          placeholder="https://automatetheboringstuff.com/"
          autocomplete="off"
          spellcheck="false"
          data-autofocus
          disabled={grabbing}
          bind:value={urlValue}
        />
      </label>
      {#if !urlIsFile}
        <fieldset class="grab-scope" disabled={grabbing}>
          <legend>What to save</legend>
          <label>
            <input type="radio" name="grab-scope" checked={urlScope === 'site'} onchange={() => (urlScopeChoice = 'site')} />
            <span>
              <strong>The whole book</strong>
              <small class="muted">This page and the pages it links to on the same site, as chapters</small>
            </span>
          </label>
          <label>
            <input type="radio" name="grab-scope" checked={urlScope === 'page'} onchange={() => (urlScopeChoice = 'page')} />
            <span>
              <strong>Just this page</strong>
              <small class="muted">One article or chapter</small>
            </span>
          </label>
        </fieldset>
      {/if}
      {#if saveFolders.length > 1}
        <label class="grab-field">
          <span>Save in</span>
          <select class="input" disabled={grabbing} bind:value={urlFolder}>
            {#each saveFolders as folder (folder.id)}
              <option value={folder.id}>{tidyPath(folder.path)}</option>
            {/each}
          </select>
        </label>
      {:else}
        <p class="muted grab-where">
          It is saved in {saveFolders[0] ? tidyPath(saveFolders[0].path) : '~/Books (which becomes a library folder)'}, to read offline.
        </p>
      {/if}
      {#if grabbing}
        <div class="grab-progress" role="status">
          <progress
            max={grabProgress?.total || 1}
            value={grabProgress && grabProgress.total > 1 ? grabProgress.done : undefined}
          ></progress>
          <span class="muted ellipsis">
            {grabProgress && grabProgress.total > 1
              ? `Saving ${Math.min(grabProgress.done, grabProgress.total)} of ${grabProgress.total}: ${grabProgress.label}`
              : 'Connecting…'}
          </span>
        </div>
      {/if}
      {#if grabError}<p class="warn" role="alert">{grabError}</p>{/if}
    </form>
    {#snippet footer()}
      <button class="btn" type="button" onclick={closeUrlDialog}>Cancel</button>
      <button class="btn primary" type="submit" form="grab-form" disabled={!urlParsed || grabbing}>
        {grabbing ? 'Saving…' : urlIsFile ? 'Download' : 'Add to library'}
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
  .grab {
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  .grab-field {
    display: flex;
    flex-direction: column;
    gap: 6px;
    font-weight: 600;
  }
  .grab-field .input {
    width: 100%;
    font-weight: 400;
  }
  .grab-scope {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    border: 0;
  }
  .grab-scope legend {
    padding: 0;
    margin-bottom: 6px;
    font-weight: 600;
  }
  .grab-scope label {
    display: flex;
    align-items: flex-start;
    gap: 10px;
  }
  .grab-scope input {
    margin-top: 4px;
    accent-color: var(--accent);
  }
  .grab-scope span {
    display: flex;
    flex-direction: column;
  }
  .grab-scope strong {
    font-weight: 500;
  }
  .grab-where {
    margin: 0;
  }
  .grab-progress {
    display: flex;
    flex-direction: column;
    gap: 6px;
  }
  .grab-progress progress {
    width: 100%;
    height: 6px;
    accent-color: var(--accent);
  }
  .grab .warn {
    margin: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 8px;
    margin-top: 6px;
  }
  .lang {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    margin-top: 6px;
  }
  .offline span {
    display: flex;
    flex-direction: column;
    min-width: 0;
  }
  .offline .btn {
    flex: none;
  }
  .lang select {
    width: 150px;
  }
  .hint {
    margin: 8px 0 0;
    font-size: 12px;
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
