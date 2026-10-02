<script module lang="ts">
  /*
   * Where the reader is in the catalogs lives here, outside the component:
   * the library takes this screen down whenever the books are shown, and
   * coming back should carry on from the same page, not start over.
   */
  import type { Book, OpdsCatalog } from '@shared/types'
  import { app, openBook, refreshLibrary, toast, updateSettings } from '../lib/app.svelte'
  import { ipc } from '../lib/ipc'
  import {
    folderLabel,
    friendlyError,
    homeOf,
    hostOf,
    parseFeed,
    sameTitle,
    searchUrl,
    type OpdsAcquisition,
    type OpdsFeed,
    type OpdsPublication,
  } from './opds'

  interface Suggestion extends OpdsCatalog {
    about: string
  }

  const SUGGESTED: Suggestion[] = [
    {
      title: 'Project Gutenberg',
      url: 'https://m.gutenberg.org/ebooks.opds/',
      about: 'Free e-books, mostly older works that are in the public domain',
    },
  ]

  /** A catalog page the reader came through, or the one on screen (the last). */
  interface Page {
    id: number
    url: string
    /** What was clicked to get here: catalogs tend to give every page the same title. */
    title: string
    feed: OpdsFeed
    /** The search that produced this page, if one did. */
    terms: string
    /** How far down it was scrolled, to come back to the same spot. */
    scroll: number
  }

  /** What is being fetched right now. */
  interface Pending {
    kind: 'open' | 'search' | 'more' | 'add'
    /** The address asked for, which is how the clicked row knows it is the one. */
    href: string
    title: string
    host: string
    /** It has taken long enough to say so and offer a way out. */
    slow: boolean
  }

  const SLOW_AFTER_MS = 8000

  let catalogs = $state<OpdsCatalog[]>([])
  let trail = $state.raw<Page[]>([])
  let pending = $state<Pending | null>(null)
  let problem = $state<{ message: string; retry: () => void } | null>(null)
  let terms = $state('')
  let newUrl = $state('')
  /** What each download is doing, by its address. */
  const downloading = $state<Record<string, 'fetching' | 'adding'>>({})
  /** Where each finished download was saved, by its address. */
  const saved = $state<Record<string, string>>({})
  const covers = $state<Record<string, string>>({})
  let listScroll = 0
  let lastPage = 0
  let request = 0
  let slowTimer: ReturnType<typeof setTimeout> | undefined

  const available = $derived(app.folders.filter(folder => !folder.missing))
  /**
   * Where downloads are saved: the folder chosen last time. Until one has been
   * chosen it is the folder holding the most books (the oldest of equals),
   * which is more likely the main library than whichever sorts first.
   */
  const destination = $derived(
    available.find(folder => folder.id === app.settings.downloadFolderId) ??
      available.toSorted((a, b) => b.bookCount - a.bookCount || a.addedAt - b.addedAt)[0] ??
      null,
  )
  const homeDir = $derived(homeOf(app.folders.map(folder => folder.path)))

  /** Marks a request as started. Its answer counts only while the returned number is still `request`. */
  function begin(what: Omit<Pending, 'slow'>): number {
    const id = ++request
    clearTimeout(slowTimer)
    pending = { ...what, slow: false }
    problem = null
    slowTimer = setTimeout(() => {
      if (id === request && pending) pending.slow = true
    }, SLOW_AFTER_MS)
    return id
  }

  function settle(): void {
    clearTimeout(slowTimer)
    pending = null
  }

  /** Stops waiting for whatever is being fetched; its answer is ignored if it still comes. */
  function cancel(): void {
    request++
    settle()
  }

  function fail(what: string, cause: unknown, host: string, retry: () => void): void {
    console.warn(what, cause)
    problem = { message: `${what} ${friendlyError(cause, host)}`, retry }
  }

  /** After moving to another page: the search box and any error belong to the page left behind. */
  function landed(): void {
    problem = null
    terms = trail.at(-1)?.terms ?? ''
  }

  function show(page: Omit<Page, 'id' | 'scroll'>, how: 'first' | 'after' | 'instead'): void {
    const next = { ...page, id: ++lastPage, scroll: 0 }
    if (how === 'first') forgetCovers()
    trail = how === 'first' ? [next] : how === 'instead' ? [...trail.slice(0, -1), next] : [...trail, next]
    landed()
  }

  function forgetCovers(): void {
    for (const [key, url] of Object.entries(covers)) {
      URL.revokeObjectURL(url)
      delete covers[key]
    }
  }

  /**
   * Returns to the list of saved catalogs, from wherever the reader is.
   * The library calls this when "Catalogs" is chosen while already open.
   */
  export function home(): void {
    cancel()
    trail = []
    listScroll = 0
    landed()
  }

  /** Goes back to a page the reader came through. */
  function jump(index: number): void {
    cancel()
    trail = trail.slice(0, index + 1)
    landed()
  }

  /** Fetches a page and shows it, as a catalog's first page or after the one on screen. */
  async function visit(target: { url: string; title: string }, how: 'first' | 'after'): Promise<void> {
    const host = hostOf(target.url)
    const id = begin({ kind: 'open', href: target.url, title: target.title, host })
    try {
      const feed = parseFeed(await ipc.invoke('opds:fetch', target.url))
      if (id !== request) return
      show({ url: feed.url, title: target.title || feed.title, feed, terms: '' }, how)
    } catch (cause) {
      if (id !== request) return
      fail(`Couldn't open “${target.title}”.`, cause, host, () => void visit(target, how))
    } finally {
      if (id === request) settle()
    }
  }

  /** The nearest page that offers a search, so that searching works from anywhere in a catalog. */
  const searchable = $derived(trail.findLast(page => page.feed.search) ?? null)

  async function search(wanted = terms.trim()): Promise<void> {
    const source = searchable
    if (!source || !wanted) return
    const host = hostOf(source.url)
    const id = begin({ kind: 'search', href: '', title: `“${wanted}”`, host })
    try {
      const url = await searchUrl(source.feed, wanted, target => ipc.invoke('opds:fetch', target))
      if (id !== request) return
      if (!url) {
        problem = { message: "This catalog's search can't be used from BookViewer.", retry: () => void search(wanted) }
        return
      }
      const feed = parseFeed(await ipc.invoke('opds:fetch', url))
      if (id !== request) return
      // A new search from a page of results takes its place rather than piling up.
      const page = { url: feed.url, title: `Results for “${wanted}”`, feed, terms: wanted }
      show(page, trail.at(-1)?.terms ? 'instead' : 'after')
    } catch (cause) {
      if (id !== request) return
      fail(`Couldn't search for “${wanted}”.`, cause, host, () => void search(wanted))
    } finally {
      if (id === request) settle()
    }
  }

  /** Appends the next part of a long page. Resolves to whether anything was added. */
  async function more(): Promise<boolean> {
    const page = trail.at(-1)
    const next = page?.feed.next
    if (!page || !next) return false
    const host = hostOf(next)
    const id = begin({ kind: 'more', href: next, title: page.title, host })
    try {
      const added = parseFeed(await ipc.invoke('opds:fetch', next))
      if (id !== request) return false
      const groups = page.feed.groups.map(group => ({
        ...group,
        navigation: [...group.navigation],
        publications: [...group.publications],
      }))
      for (const group of added.groups) {
        const same = groups.find(g => g.title === group.title)
        if (same) {
          same.navigation.push(...group.navigation)
          same.publications.push(...group.publications)
        } else groups.push(group)
      }
      const merged = { ...page, feed: { ...page.feed, groups, next: added.next } }
      trail = [...trail.slice(0, -1), merged]
      return true
    } catch (cause) {
      if (id !== request) return false
      fail("Couldn't load more of this page.", cause, host, () => void more())
      return false
    } finally {
      if (id === request) settle()
    }
  }

  async function saveCatalogs(next: OpdsCatalog[]): Promise<void> {
    catalogs = next
    await ipc.invoke('opds:setCatalogs', next)
  }

  /** Adds the catalog at an address typed by the reader, and opens it. */
  async function addFromUrl(typed = newUrl.trim()): Promise<void> {
    if (!typed) return
    const url = /^https?:\/\//i.test(typed) ? typed : 'https://' + typed
    const known = catalogs.find(catalog => catalog.url === url)
    if (known) {
      newUrl = ''
      return visit(known, 'first')
    }
    const host = hostOf(url)
    const id = begin({ kind: 'add', href: url, title: host || url, host })
    try {
      const feed = parseFeed(await ipc.invoke('opds:fetch', url))
      if (id !== request) return
      // a catalog that does not name itself goes by its address
      const title = feed.title === 'Catalog' && host ? host : feed.title
      if (!catalogs.some(catalog => catalog.url === feed.url))
        await saveCatalogs([...catalogs, { title, url: feed.url }])
      newUrl = ''
      show({ url: feed.url, title, feed, terms: '' }, 'first')
    } catch (cause) {
      if (id !== request) return
      fail("Couldn't add that catalog.", cause, host, () => void addFromUrl(typed))
    } finally {
      if (id === request) settle()
    }
  }

  /** Adds a suggested catalog to the saved ones and goes straight into it. */
  async function addSuggested({ title, url }: Suggestion): Promise<void> {
    if (!catalogs.some(catalog => catalog.url === url)) await saveCatalogs([...catalogs, { title, url }])
    await visit({ title, url }, 'first')
  }

  function removeCatalog(catalog: OpdsCatalog): void {
    const at = catalogs.findIndex(c => c.url === catalog.url)
    if (at < 0) return
    const removed = { title: catalog.title, url: catalog.url }
    void saveCatalogs(catalogs.filter(c => c.url !== removed.url))
    toast(`Removed “${removed.title}”`, {
      action: {
        label: 'Undo',
        run: () => {
          if (catalogs.some(c => c.url === removed.url)) return
          void saveCatalogs([...catalogs.slice(0, at), removed, ...catalogs.slice(at)])
        },
      },
    })
  }

  const bookAt = (path: string | undefined): Book | undefined =>
    path ? app.books.find(book => book.path === path && !book.missing) : undefined

  /** Waits for a downloaded file to turn up as a book; its folder is rescanned after a download. */
  async function inLibrary(path: string): Promise<Book | undefined> {
    await refreshLibrary()
    for (let waited = 0; waited < 15_000 && !bookAt(path); waited += 200)
      await new Promise(resolve => setTimeout(resolve, 200))
    return bookAt(path)
  }

  async function download(publication: OpdsPublication, { href }: OpdsAcquisition): Promise<void> {
    const folder = destination
    if (!folder || downloading[href]) return
    downloading[href] = 'fetching'
    // from now on this is the folder, even if another one later holds more books
    if (app.settings.downloadFolderId !== folder.id) updateSettings({ downloadFolderId: folder.id })
    try {
      const name = publication.author ? `${publication.title} - ${publication.author}` : publication.title
      const path = await ipc.invoke('opds:download', href, folder.id, name)
      downloading[href] = 'adding'
      saved[href] = path
      const book = await inLibrary(path)
      toast(
        `Downloaded “${publication.title}”`,
        book ? { action: { label: 'Open', run: () => openBook(book.id) } } : 'info',
      )
    } catch (cause) {
      console.warn('download failed', cause)
      toast(`Couldn't download “${publication.title}”. ${friendlyError(cause, hostOf(href))}`, 'error')
    } finally {
      delete downloading[href]
    }
  }

  /** Opens a book downloaded earlier, if the library still has it. */
  async function openSaved(publication: OpdsPublication, { href }: OpdsAcquisition): Promise<void> {
    let book = bookAt(saved[href])
    if (!book) {
      await refreshLibrary()
      book = bookAt(saved[href])
    }
    if (book) openBook(book.id)
    else {
      delete saved[href]
      toast(`“${publication.title}” is no longer in your library. Download it again to read it.`, 'error')
    }
  }

  async function addFolder(): Promise<void> {
    const added = await ipc.invoke('folders:add')
    if (added.length) await refreshLibrary()
  }
</script>

<script lang="ts">
  import { tick } from 'svelte'
  import Icon from '../lib/Icon.svelte'

  let { onclose }: { onclose: () => void } = $props()

  let viewport = $state<HTMLElement>()
  let heading = $state<HTMLElement>()

  const current = $derived(trail.at(-1) ?? null)
  /** Another page is on its way: what is on screen is about to be replaced. */
  const leaving = $derived(!!pending && pending.kind !== 'more')
  const suggestions = $derived(SUGGESTED.filter(s => !catalogs.some(c => c.url === s.url)))
  const backLabel = $derived(
    trail.length > 1
      ? `Back to ${trail[trail.length - 2].title}`
      : trail.length === 1
        ? 'Back to your catalogs'
        : 'Back to your library',
  )

  void ipc.invoke('opds:catalogs').then(list => (catalogs = list))

  /** One level up, always: the page before, then the catalog list, then the library. */
  function back() {
    if (trail.length > 1) jump(trail.length - 2)
    else if (trail.length === 1) home()
    else {
      cancel()
      problem = null
      onclose()
    }
  }

  // Also available as a method of the component, for a parent that holds it with bind:this.
  const showList = () => home()
  export { showList as home }

  function onScroll() {
    // hidden behind an open book, the list reports 0; that is not where the reader was
    if (!viewport?.clientHeight || app.view !== 'library') return
    if (current) current.scroll = viewport.scrollTop
    else listScroll = viewport.scrollTop
  }

  // Each page comes up where it was left (new ones at the top). The link that
  // was clicked is gone by then, so keyboard focus moves to the page's title.
  let shown: number | undefined
  $effect(() => {
    const id = current?.id ?? 0
    if (!viewport || app.view !== 'library') shown = undefined
    else if (id !== shown) {
      shown = id
      viewport.scrollTop = current ? current.scroll : listScroll
      if (!document.activeElement || document.activeElement === document.body)
        heading?.focus({ preventScroll: true })
    }
  })

  async function loadMore(event: MouseEvent) {
    const button = event.currentTarget
    const links = () => [...(viewport?.querySelectorAll<HTMLElement>('.row-main, article .btn') ?? [])]
    const before = new Set(links())
    if (!(await more())) return
    await tick()
    // Keyboard focus carries on from the first new entry, not from a button
    // below them all (or from nowhere, once there is nothing more to load).
    const active = document.activeElement
    if (active === button || !active || active === document.body)
      links().find(link => !before.has(link) && !link.matches(':disabled'))?.focus({ preventScroll: true })
  }

  function onKeydown(event: KeyboardEvent) {
    if (app.view !== 'library') return
    if (event.key === 'Escape' && pending) cancel()
    else if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault()
      back()
    }
  }

  /** Loads a cover the first time its card scrolls into view. */
  function lazyCover(node: HTMLElement, url: string | null) {
    if (!url || covers[url]) return
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      if (covers[url]) return
      void ipc.invoke('opds:image', url).then(image => {
        if (image && !covers[url])
          covers[url] = URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.type }))
      })
    })
    observer.observe(node)
    return { destroy: () => observer.disconnect() }
  }

  /** "m.gutenberg.org/ebooks.opds/": an address without the parts nobody reads. */
  const shortUrl = (url: string) => url.replace(/^https?:\/\//i, '')
</script>

<svelte:window onkeydown={onKeydown} />

<div class="catalogs">
  <header>
    <button class="icon-btn" title={backLabel} aria-label={backLabel} onclick={back}>
      <Icon name="arrow-left" />
    </button>
    <h1 class="ellipsis" tabindex="-1" bind:this={heading}>{current?.title ?? 'Catalogs'}</h1>
    {#if searchable}
      <form
        class="search"
        role="search"
        onsubmit={event => {
          event.preventDefault()
          void search()
        }}
      >
        {#if pending?.kind === 'search'}
          <span class="spinner" aria-hidden="true"></span>
        {:else}
          <Icon name="search" size={15} />
        {/if}
        <input
          class="input"
          type="search"
          placeholder="Search this catalog"
          aria-label="Search this catalog"
          bind:value={terms}
        />
      </form>
    {/if}
    {#if pending}<div class="progress" aria-hidden="true"></div>{/if}
  </header>

  {#if current}
    <div class="place">
      <nav aria-label="Where you are">
        <ol>
          <li><button class="crumb" onclick={home}>Catalogs</button></li>
          {#each trail as page, i (page.id)}
            <li>
              <span class="sep" aria-hidden="true">›</span>
              {#if i < trail.length - 1}
                <button class="crumb ellipsis" onclick={() => jump(i)}>{page.title}</button>
              {:else}
                <span class="crumb here ellipsis" aria-current="page">{page.title}</span>
              {/if}
            </li>
          {/each}
        </ol>
      </nav>
      {#if destination && available.length > 1}
        <label class="save-to">
          <span class="muted">Save to:</span>
          <select
            class="input"
            title={destination.path}
            value={String(destination.id)}
            onchange={event => updateSettings({ downloadFolderId: Number(event.currentTarget.value) })}
          >
            {#each available as folder (folder.id)}
              <option value={String(folder.id)}>{folderLabel(folder.path, homeDir)}</option>
            {/each}
          </select>
        </label>
      {:else if destination}
        <p class="save-to" title={destination.path}>
          <span class="muted">Save to:</span>
          {folderLabel(destination.path, homeDir)}
        </p>
      {/if}
    </div>
  {/if}

  {#if pending?.slow}
    <div class="notice" role="status">
      <span class="spinner" aria-hidden="true"></span>
      <p>Still waiting for {pending.host || 'the catalog'}…</p>
      <button class="btn" onclick={cancel}>Cancel</button>
    </div>
  {/if}
  {#if problem}
    {@const retry = problem.retry}
    <div class="notice error" role="alert">
      <Icon name="info" size={17} />
      <p>{problem.message}</p>
      <button class="btn" onclick={retry}>Retry</button>
      <button class="btn quiet" onclick={() => (problem = null)}>Dismiss</button>
    </div>
  {/if}
  {#if !destination}
    <div class="notice">
      <Icon name="folder" size={17} />
      <p>
        {#if app.folders.length}
          None of your library folders can be found right now, so there is nowhere to save
          downloads. Reconnect the drive they are on, or add another folder.
        {:else}
          To download books, add a library folder first. Books you download are saved there.
        {/if}
      </p>
      <button class="btn" onclick={addFolder}>
        <Icon name="folder-plus" size={15} /> Add folder…
      </button>
    </div>
  {/if}

  <div
    class="content scroll"
    class:leaving
    aria-busy={pending ? 'true' : undefined}
    bind:this={viewport}
    onscroll={onScroll}
  >
    {#if !current}
      <div class="column">
        {#if catalogs.length}
          <h2>Your catalogs</h2>
          <section class="list">
            {#each catalogs as catalog (catalog.url)}
              {@const opening = pending?.href === catalog.url}
              <div class="row" class:pending={opening}>
                <button class="row-main" title={catalog.url} onclick={() => visit(catalog, 'first')}>
                  <Icon name="rss" size={16} />
                  <span class="row-text">
                    <strong class="ellipsis">{catalog.title}</strong>
                    <span class="muted ellipsis">{shortUrl(catalog.url)}</span>
                  </span>
                  {#if opening}
                    <span class="spinner" aria-hidden="true"></span>
                  {:else}
                    <span class="chevron"><Icon name="chevron-right" size={16} /></span>
                  {/if}
                </button>
                <button
                  class="icon-btn remove"
                  title="Remove this catalog"
                  aria-label="Remove {catalog.title}"
                  onclick={() => removeCatalog(catalog)}
                >
                  <Icon name="trash" size={15} />
                </button>
              </div>
            {/each}
          </section>
        {:else}
          <h2>No catalogs yet</h2>
          <p class="muted">
            A catalog lets you browse an online library and download its books straight into yours.
            Add one by its address{suggestions.length ? ', or start with the suggestion below' : ''}.
          </p>
        {/if}

        <h2 id="add-catalog">Add a catalog</h2>
        <form
          class="add"
          onsubmit={event => {
            event.preventDefault()
            void addFromUrl()
          }}
        >
          <input
            class="input"
            type="text"
            spellcheck="false"
            placeholder="Catalog address (https://…)"
            aria-labelledby="add-catalog"
            bind:value={newUrl}
          />
          <button class="btn primary" disabled={!newUrl.trim() || pending?.kind === 'add'}>
            {#if pending?.kind === 'add'}
              <span class="spinner" aria-hidden="true"></span> Adding…
            {:else}
              Add catalog
            {/if}
          </button>
        </form>

        {#if suggestions.length}
          <h2>Suggested</h2>
          <section class="list">
            {#each suggestions as suggestion (suggestion.url)}
              {@const opening = pending?.href === suggestion.url}
              <div class="row" class:pending={opening}>
                <button class="row-main" title={suggestion.url} onclick={() => addSuggested(suggestion)}>
                  <Icon name="rss" size={16} />
                  <span class="row-text">
                    <strong class="ellipsis">{suggestion.title}</strong>
                    <span class="muted">{suggestion.about}</span>
                  </span>
                  {#if opening}
                    <span class="spinner" aria-hidden="true"></span>
                  {:else}
                    <span class="add-chip"><Icon name="plus" size={14} /> Add</span>
                  {/if}
                </button>
              </div>
            {/each}
          </section>
        {/if}

        <p class="muted hint">
          Online libraries, and servers such as Calibre, Kavita and Komga, publish their books as a
          catalog that reading apps can browse (the format is called OPDS). Books you download are
          saved into a library folder.
        </p>
      </div>
    {:else}
      {#key current.id}
        {#each current.feed.groups as group, g (g)}
          {#if group.title && !sameTitle(group.title, current.title) && !sameTitle(group.title, current.feed.title)}
            <h2>
              {group.title}
              {#if group.href}
                <button class="see-all" onclick={() => visit({ url: group.href!, title: group.title }, 'after')}>
                  See all
                </button>
              {/if}
            </h2>
          {/if}
          {#if group.navigation.length}
            <section class="list column">
              {#each group.navigation as item, i (i)}
                {@const opening = pending?.href === item.href}
                <div class="row" class:pending={opening}>
                  <button
                    class="row-main"
                    onclick={() => visit({ url: item.href, title: item.title }, 'after')}
                  >
                    <span class="row-text">
                      <strong>{item.title}</strong>
                      {#if item.summary}<span class="muted">{item.summary}</span>{/if}
                    </span>
                    {#if opening}
                      <span class="spinner" aria-hidden="true"></span>
                    {:else}
                      <span class="chevron"><Icon name="chevron-right" size={16} /></span>
                    {/if}
                  </button>
                </div>
              {/each}
            </section>
          {/if}
          {#if group.publications.length}
            <section class="publications">
              {#each group.publications as publication, i (i)}
                {@const busy = publication.acquisitions.some(a => downloading[a.href])}
                <article use:lazyCover={publication.cover}>
                  <div class="cover">
                    {#if publication.cover && covers[publication.cover]}
                      <img src={covers[publication.cover]} alt="" />
                    {:else}
                      <Icon name="book" size={26} />
                    {/if}
                  </div>
                  <div class="info">
                    <strong class="title">{publication.title}</strong>
                    {#if publication.author}<span class="muted author">{publication.author}</span>{/if}
                    {#if publication.summary}<p class="summary muted">{publication.summary}</p>{/if}
                    <div class="actions">
                      {#each publication.acquisitions as acquisition, a (acquisition.href)}
                        {@const state = downloading[acquisition.href]}
                        {#if state}
                          <button class="btn working" class:main={a === 0} class:other={a > 0} disabled>
                            <span class="spinner" aria-hidden="true"></span>
                            {state === 'adding' ? 'Adding to your library…' : 'Downloading…'}
                          </button>
                        {:else if saved[acquisition.href]}
                          <button
                            class="btn done"
                            class:main={a === 0}
                            class:other={a > 0}
                            title="Open “{publication.title}”"
                            onclick={() => openSaved(publication, acquisition)}
                          >
                            <Icon name="check" size={14} />
                            Open{a > 0 ? ` ${acquisition.label}` : ''}
                          </button>
                        {:else if a === 0}
                          <button
                            class="btn main"
                            disabled={busy || !destination}
                            title={destination
                              ? `Save “${publication.title}” to ${folderLabel(destination.path, homeDir)}`
                              : 'Add a library folder first'}
                            onclick={() => download(publication, acquisition)}
                          >
                            <Icon name="download" size={14} />
                            Download
                            <span class="format">{acquisition.label}</span>
                          </button>
                        {:else}
                          <button
                            class="btn other"
                            disabled={busy || !destination}
                            title="Download as {acquisition.label}"
                            aria-label="Download as {acquisition.label}"
                            onclick={() => download(publication, acquisition)}
                          >
                            {acquisition.label}
                          </button>
                        {/if}
                      {:else}
                        {#if publication.details}
                          <button class="btn main" onclick={() => ipc.invoke('shell:openExternal', publication.details!)}>
                            <Icon name="external" size={14} /> Open in browser
                          </button>
                        {:else}
                          <span class="muted none">No download available</span>
                        {/if}
                      {/each}
                    </div>
                  </div>
                </article>
              {/each}
            </section>
          {/if}
        {:else}
          <div class="empty">
            {#if current.terms}
              <h2>Nothing matches “{current.terms}”</h2>
              <p class="muted">Check the spelling or try fewer words.</p>
            {:else}
              <h2>Nothing is listed here</h2>
              <p class="muted">This part of the catalog is empty.</p>
            {/if}
          </div>
        {/each}
      {/key}
      {#if current.feed.next}
        <button class="btn load-more" disabled={pending?.kind === 'more'} onclick={loadMore}>
          {#if pending?.kind === 'more'}
            <span class="spinner" aria-hidden="true"></span> Loading more…
          {:else}
            Load more
          {/if}
        </button>
      {/if}
    {/if}
  </div>

  <p class="announce" role="status">
    {pending ? (pending.kind === 'search' ? `Searching for ${pending.title}…` : `Loading ${pending.title}…`) : ''}
  </p>
</div>

<style>
  .catalogs {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
    /* without this the library's grid makes the screen as tall as its content, and nothing scrolls */
    min-height: 0;
  }
  /* the same bar as the library's, with the way back where its title starts */
  header {
    position: relative;
    display: flex;
    align-items: center;
    gap: 10px;
    height: 56px;
    padding: 0 20px 0 14px;
    flex: none;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    flex: 1;
    font-size: 19px;
    font-weight: 700;
    letter-spacing: -0.01em;
  }
  h1:focus {
    outline: none;
  }
  .search {
    position: relative;
    display: flex;
    align-items: center;
    color: var(--fg-muted);
  }
  .search :global(svg),
  .search .spinner {
    position: absolute;
    left: 10px;
    pointer-events: none;
  }
  .search input {
    width: 250px;
    padding-left: 32px;
    color: var(--fg);
  }

  /* Something is on its way: a bar that keeps moving along the header's lower edge. */
  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: -1px;
    height: 2px;
    overflow: hidden;
    background: color-mix(in srgb, var(--accent-strong) 25%, var(--border));
  }
  .progress::after {
    content: '';
    position: absolute;
    inset: 0;
    width: 35%;
    background: var(--accent-strong);
    animation: slide 1.1s ease-in-out infinite;
  }
  @keyframes slide {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(290%);
    }
  }
  .spinner {
    flex: none;
    width: 14px;
    height: 14px;
    border-radius: 50%;
    border: 2px solid color-mix(in srgb, currentColor 25%, transparent);
    border-top-color: currentColor;
    animation: spin 0.7s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .progress::after {
      width: 100%;
      animation: pulse 1.6s ease-in-out infinite alternate;
    }
    .spinner {
      animation-duration: 2.4s;
    }
  }
  @keyframes pulse {
    from {
      opacity: 0.35;
    }
  }

  .place {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 6px 20px;
    min-height: 32px;
    padding: 10px 20px 0 24px;
    font-size: 13px;
  }
  .place nav {
    min-width: 0;
  }
  ol {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 2px 0;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    align-items: center;
    min-width: 0;
  }
  .sep {
    padding: 0 7px;
    color: var(--fg-muted);
  }
  .crumb {
    max-width: 260px;
    border-radius: 4px;
  }
  button.crumb {
    color: var(--accent);
  }
  button.crumb:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .crumb.here {
    font-weight: 600;
  }
  .save-to {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }
  .save-to select {
    height: 28px;
    max-width: 280px;
    font-size: 13px;
  }

  .notice {
    display: flex;
    align-items: center;
    gap: 10px;
    margin: 12px 20px 0 24px;
    padding: 8px 8px 8px 12px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
  }
  .notice p {
    flex: 1;
    min-width: 0;
    line-height: 1.45;
    user-select: text;
  }
  .notice > :global(svg) {
    color: var(--fg-muted);
  }
  .notice.error {
    border-color: color-mix(in srgb, var(--danger) 50%, var(--border));
    background: color-mix(in srgb, var(--danger) 9%, var(--surface));
  }
  .notice.error > :global(svg) {
    color: var(--danger);
  }
  .notice .btn {
    flex: none;
    height: 28px;
    padding: 0 10px;
    font-size: 13px;
  }
  .btn.quiet {
    border-color: transparent;
    background: none;
    color: var(--fg-muted);
  }
  .btn.quiet:hover {
    background: var(--hover);
    color: var(--fg);
  }

  .content {
    flex: 1;
    padding: 16px 20px 32px 24px;
  }
  /* What is on screen is about to be replaced: step it back, apart from the row being opened. */
  .content.leaving {
    pointer-events: none;
  }
  .content.leaving :is(.row:not(.pending), article, h2, .add, .hint, .load-more, .empty) {
    opacity: 0.5;
  }
  .row,
  article,
  h2 {
    transition: opacity 0.15s;
  }
  .column {
    max-width: 760px;
  }
  h2 {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin: 22px 0 8px;
    font-size: 14px;
    font-weight: 600;
  }
  h2:first-child,
  .empty h2 {
    margin-top: 0;
  }
  .see-all {
    font-size: 12.5px;
    font-weight: 400;
    color: var(--accent);
  }
  .see-all:hover {
    text-decoration: underline;
    text-underline-offset: 3px;
  }

  /* Rows read like the library's list: no boxes, the whole line lights up. */
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    margin: 0 -10px;
  }
  .list.column {
    max-width: 780px;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: var(--radius);
  }
  .row:hover,
  .row.pending {
    background: var(--hover);
  }
  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 8px 10px;
    border-radius: var(--radius);
    text-align: left;
  }
  .row-main > :global(svg) {
    color: var(--fg-muted);
  }
  .row-text {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 1px;
  }
  .row-text strong {
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .row-text .muted {
    font-size: 12.5px;
    line-height: 1.4;
  }
  .chevron {
    color: var(--fg-muted);
    opacity: 0.6;
  }
  .row:hover .chevron {
    opacity: 1;
  }
  .row .spinner {
    margin-right: 1px;
    color: var(--accent);
  }
  .remove {
    margin-right: 4px;
    color: var(--fg-muted);
  }
  .remove:hover {
    color: var(--danger);
  }
  .add-chip {
    flex: none;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    height: 26px;
    padding: 0 10px 0 8px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    background: var(--surface);
    font-size: 12.5px;
    font-weight: 600;
    color: var(--accent);
  }
  .add {
    display: flex;
    gap: 8px;
  }
  .add input {
    flex: 1;
  }
  .add .spinner {
    width: 12px;
    height: 12px;
  }
  .hint {
    margin-top: 26px;
    font-size: 13px;
    line-height: 1.5;
  }

  .publications {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 12px;
  }
  /* a book's own page: one card with room for its description */
  .publications:has(> :only-child) {
    grid-template-columns: minmax(0, 640px);
  }
  .publications:has(> :only-child) .summary {
    -webkit-line-clamp: 12;
    line-clamp: 12;
  }
  .publications + h2,
  .list + h2 {
    margin-top: 26px;
  }
  article {
    display: flex;
    gap: 14px;
    min-width: 0;
    padding: 12px;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: var(--surface);
  }
  .cover {
    flex: none;
    width: 72px;
    height: 108px;
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
    color: var(--fg-muted);
    box-shadow: var(--shadow);
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .info {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    user-select: text;
  }
  .title {
    font-weight: 600;
    line-height: 1.3;
    overflow-wrap: anywhere;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .author {
    font-size: 12.5px;
  }
  .summary {
    margin-top: 2px;
    font-size: 12.5px;
    line-height: 1.4;
    display: -webkit-box;
    -webkit-line-clamp: 3;
    line-clamp: 3;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
    margin-top: auto;
    padding-top: 8px;
    user-select: none;
  }
  /* One way to get the book stands out; the other formats stay small beside it. */
  .actions .btn.main {
    height: 28px;
    padding: 0 10px;
    font-size: 13px;
    font-weight: 600;
    color: var(--accent);
  }
  .actions .btn.other {
    height: 24px;
    padding: 0 8px;
    gap: 4px;
    font-size: 11.5px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .actions .btn.done {
    border-color: transparent;
    background: var(--accent-soft);
    color: var(--accent);
  }
  .actions .btn.done:hover {
    background: color-mix(in srgb, var(--accent-strong) 22%, transparent);
  }
  .actions .btn:disabled {
    color: var(--fg-muted);
  }
  /* busy, not unavailable: keep it at full strength */
  .actions .btn.working {
    opacity: 1;
  }
  .actions .working .spinner {
    color: var(--accent);
  }
  .actions .spinner {
    width: 12px;
    height: 12px;
  }
  .format {
    font-size: 11px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  .none {
    font-size: 12.5px;
  }
  .load-more {
    margin: 18px auto 0;
    display: flex;
  }
  .empty {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    padding: 64px 20px;
    text-align: center;
  }
  .empty h2 {
    font-size: 16px;
  }
  /* read out by screen readers; sighted readers have the bar and the spinner */
  .announce {
    position: absolute;
    width: 1px;
    height: 1px;
    overflow: hidden;
    clip-path: inset(50%);
    white-space: nowrap;
  }
  @media (max-width: 860px) {
    .search input {
      width: 170px;
    }
    .publications {
      grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    }
  }
</style>
