<script lang="ts">
  import type { OpdsCatalog } from '@shared/types'
  import Icon from '../lib/Icon.svelte'
  import { app, refreshLibrary, toast } from '../lib/app.svelte'
  import { ipc } from '../lib/ipc'
  import { parseFeed, searchUrl, type OpdsFeed, type OpdsPublication } from './opds'

  let { onclose }: { onclose: () => void } = $props()

  const SUGGESTED: OpdsCatalog[] = [
    { title: 'Project Gutenberg', url: 'https://m.gutenberg.org/ebooks.opds/' },
  ]

  let catalogs = $state<OpdsCatalog[]>([])
  let feed = $state<OpdsFeed | null>(null)
  let history = $state<string[]>([])
  let loading = $state(false)
  let error = $state('')
  let newUrl = $state('')
  let terms = $state('')
  let folderId = $state<number | null>(null)
  let downloading = $state<Record<string, boolean>>({})
  let covers = $state<Record<string, string>>({})
  let request = 0

  const destination = $derived(folderId ?? app.folders[0]?.id ?? null)

  void ipc.invoke('opds:catalogs').then(saved => (catalogs = saved))

  $effect(() => () => {
    for (const url of Object.values(covers)) URL.revokeObjectURL(url)
  })

  async function load(url: string, remember = true) {
    const current = ++request
    loading = true
    error = ''
    try {
      const parsed = parseFeed(await ipc.invoke('opds:fetch', url))
      if (current !== request) return
      if (remember && feed) history.push(feed.url)
      feed = parsed
      terms = ''
    } catch (cause) {
      if (current !== request) return
      error = cause instanceof Error ? cause.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(cause)
    } finally {
      if (current === request) loading = false
    }
  }

  function back() {
    const previous = history.pop()
    if (previous) void load(previous, false)
    else {
      request++
      feed = null
      error = ''
      loading = false
    }
  }

  async function more() {
    if (!feed?.next) return
    const current = feed
    loading = true
    try {
      const next = parseFeed(await ipc.invoke('opds:fetch', current.next!))
      if (feed !== current) return
      // Append the next page to the list being shown.
      const merged = [...current.groups]
      for (const group of next.groups) {
        const same = merged.find(g => g.title === group.title)
        if (same) {
          same.navigation.push(...group.navigation)
          same.publications.push(...group.publications)
        } else merged.push(group)
      }
      feed = { ...current, groups: merged, next: next.next }
    } catch (cause) {
      toast(cause instanceof Error ? cause.message : String(cause), 'error')
    } finally {
      loading = false
    }
  }

  async function search() {
    if (!feed?.search || !terms.trim()) return
    try {
      const url = await searchUrl(feed, terms.trim(), target => ipc.invoke('opds:fetch', target))
      if (url) await load(url)
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause)
    }
  }

  async function addCatalog(catalog: OpdsCatalog) {
    if (!catalogs.some(c => c.url === catalog.url)) {
      catalogs.push(catalog)
      await ipc.invoke('opds:setCatalogs', catalogs)
    }
  }

  async function addFromUrl() {
    let url = newUrl.trim()
    if (!url) return
    if (!/^https?:\/\//i.test(url)) url = 'https://' + url
    loading = true
    error = ''
    try {
      const parsed = parseFeed(await ipc.invoke('opds:fetch', url))
      await addCatalog({ title: parsed.title, url: parsed.url })
      newUrl = ''
      feed = parsed
    } catch (cause) {
      error = `That address did not return an OPDS catalog (${cause instanceof Error ? cause.message : cause})`
    } finally {
      loading = false
    }
  }

  async function removeCatalog(catalog: OpdsCatalog) {
    catalogs = catalogs.filter(c => c.url !== catalog.url)
    await ipc.invoke('opds:setCatalogs', catalogs)
  }

  async function download(publication: OpdsPublication, href: string) {
    if (destination == null) {
      toast('Add a library folder first: downloads are saved there', 'error')
      return
    }
    downloading[href] = true
    try {
      const name = publication.author ? `${publication.title} - ${publication.author}` : publication.title
      const path = await ipc.invoke('opds:download', href, destination, name)
      toast(`Saved to ${path}`)
      await refreshLibrary()
    } catch (cause) {
      toast(`Download failed: ${cause instanceof Error ? cause.message : cause}`, 'error')
    } finally {
      downloading[href] = false
    }
  }

  /** Loads a cover the first time its card scrolls into view. */
  function lazyCover(node: HTMLElement, url: string | null) {
    if (!url) return
    const observer = new IntersectionObserver(entries => {
      if (!entries.some(entry => entry.isIntersecting)) return
      observer.disconnect()
      if (covers[url]) return
      void ipc.invoke('opds:image', url).then(image => {
        if (image) covers[url] = URL.createObjectURL(new Blob([image.bytes as BlobPart], { type: image.type }))
      })
    })
    observer.observe(node)
    return { destroy: () => observer.disconnect() }
  }

  const folderName = (path: string) => path.split('/').filter(Boolean).pop() ?? path
</script>

<div class="catalogs">
  <header>
    <button class="icon-btn" title="Back" aria-label="Back" onclick={() => (feed || error ? back() : onclose())}>
      <Icon name="arrow-left" />
    </button>
    <h1 class="ellipsis">{feed?.title ?? 'OPDS catalogs'}</h1>
    {#if feed?.search}
      <form
        class="search"
        onsubmit={event => {
          event.preventDefault()
          void search()
        }}
      >
        <input class="input" type="search" placeholder="Search this catalog" bind:value={terms} />
      </form>
    {/if}
    {#if feed && app.folders.length > 1}
      <select
        class="input"
        aria-label="Download to"
        title="Folder to download into"
        value={String(destination)}
        onchange={event => (folderId = Number(event.currentTarget.value))}
      >
        {#each app.folders as folder (folder.id)}
          <option value={String(folder.id)}>Save to {folderName(folder.path)}</option>
        {/each}
      </select>
    {/if}
  </header>

  <div class="content scroll">
    {#if error}
      <p class="error">{error}</p>
    {/if}

    {#if !feed}
      <section class="list">
        {#each catalogs as catalog (catalog.url)}
          <div class="row">
            <button class="row-main" onclick={() => load(catalog.url, false)}>
              <Icon name="rss" size={16} />
              <span class="row-text">
                <strong>{catalog.title}</strong>
                <span class="muted ellipsis">{catalog.url}</span>
              </span>
            </button>
            <button class="icon-btn" title="Remove catalog" aria-label="Remove catalog" onclick={() => removeCatalog(catalog)}>
              <Icon name="trash" size={15} />
            </button>
          </div>
        {/each}

        <form
          class="add"
          onsubmit={event => {
            event.preventDefault()
            void addFromUrl()
          }}
        >
          <input class="input" type="text" placeholder="Catalog address (https://…)" bind:value={newUrl} />
          <button class="btn primary" disabled={!newUrl.trim() || loading}>Add catalog</button>
        </form>

        {#if SUGGESTED.some(s => !catalogs.some(c => c.url === s.url))}
          <p class="muted hint">Suggestions:</p>
          {#each SUGGESTED.filter(s => !catalogs.some(c => c.url === s.url)) as suggestion (suggestion.url)}
            <button class="btn" onclick={() => addCatalog(suggestion)}>
              <Icon name="plus" size={15} /> {suggestion.title}
            </button>
          {/each}
        {/if}
        <p class="muted hint">
          OPDS is the catalog format used by online libraries and by servers such as Calibre,
          Kavita and Komga. Books you download are saved into a library folder.
        </p>
      </section>
    {:else}
      {#key feed.url}
      {#each feed.groups as group, g (g)}
        {#if group.title}
          <h2>
            {group.title}
            {#if group.href}
              <button class="more" onclick={() => load(group.href!)}>See all</button>
            {/if}
          </h2>
        {/if}
        {#if group.navigation.length}
          <section class="list">
            {#each group.navigation as item, i (i)}
              <div class="row">
                <button class="row-main" onclick={() => load(item.href)}>
                  <Icon name="chevron-right" size={16} />
                  <span class="row-text">
                    <strong>{item.title}</strong>
                    {#if item.summary}<span class="muted">{item.summary}</span>{/if}
                  </span>
                </button>
              </div>
            {/each}
          </section>
        {/if}
        {#if group.publications.length}
          <section class="publications">
            {#each group.publications as publication, i (i)}
              <article use:lazyCover={publication.cover}>
                <div class="cover">
                  {#if publication.cover && covers[publication.cover]}
                    <img src={covers[publication.cover]} alt="" />
                  {:else}
                    <Icon name="book" size={28} />
                  {/if}
                </div>
                <div class="info">
                  <strong>{publication.title}</strong>
                  {#if publication.author}<span class="muted">{publication.author}</span>{/if}
                  {#if publication.summary}<p class="summary muted">{publication.summary}</p>{/if}
                  <div class="actions">
                    {#each publication.acquisitions as acquisition (acquisition.href)}
                      <button
                        class="btn"
                        disabled={downloading[acquisition.href]}
                        onclick={() => download(publication, acquisition.href)}
                      >
                        <Icon name="download" size={14} />
                        {downloading[acquisition.href] ? 'Downloading…' : acquisition.label}
                      </button>
                    {:else}
                      {#if publication.details}
                        <button class="btn" onclick={() => ipc.invoke('shell:openExternal', publication.details!)}>
                          <Icon name="external" size={14} /> Open in browser
                        </button>
                      {:else}
                        <span class="muted">No supported download</span>
                      {/if}
                    {/each}
                  </div>
                </div>
              </article>
            {/each}
          </section>
        {/if}
      {:else}
        {#if !loading}<p class="muted empty">This catalog page is empty.</p>{/if}
      {/each}
      {/key}
      {#if feed.next}
        <button class="btn load-more" disabled={loading} onclick={more}>
          {loading ? 'Loading…' : 'Load more'}
        </button>
      {/if}
    {/if}

    {#if loading && !feed}
      <p class="muted empty">Loading…</p>
    {/if}
  </div>
</div>

<style>
  .catalogs {
    display: flex;
    flex-direction: column;
    height: 100%;
    min-width: 0;
  }
  header {
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 12px 20px 12px 12px;
    border-bottom: 1px solid var(--border);
  }
  h1 {
    flex: 1;
    font-size: 18px;
    font-weight: 700;
  }
  .search input {
    width: 240px;
  }
  .content {
    flex: 1;
    padding: 16px 20px 32px;
  }
  .error {
    margin-bottom: 12px;
    padding: 10px 12px;
    border-radius: var(--radius-sm);
    background: color-mix(in srgb, var(--danger) 14%, transparent);
    color: var(--danger);
    user-select: text;
  }
  h2 {
    display: flex;
    align-items: baseline;
    gap: 12px;
    margin: 18px 0 8px;
    font-size: 15px;
  }
  .more {
    font-size: 12px;
    font-weight: 400;
    color: var(--accent);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 2px;
    max-width: 760px;
  }
  .row {
    display: flex;
    align-items: center;
    border-radius: var(--radius-sm);
  }
  .row:hover {
    background: var(--hover);
  }
  .row-main {
    flex: 1;
    min-width: 0;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: 8px 10px;
    text-align: left;
  }
  .row-text {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
  }
  .add {
    display: flex;
    gap: 8px;
    margin: 14px 0 6px;
  }
  .add input {
    flex: 1;
  }
  .hint {
    margin: 12px 0 6px;
    line-height: 1.5;
  }
  .publications {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(340px, 1fr));
    gap: 10px;
  }
  article {
    display: flex;
    gap: 12px;
    padding: 10px;
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
    border-radius: 3px;
    overflow: hidden;
    background: var(--surface-2);
    color: var(--fg-muted);
  }
  .cover img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .info {
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 3px;
    user-select: text;
  }
  .summary {
    font-size: 12px;
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
    gap: 6px;
    margin-top: auto;
    padding-top: 6px;
  }
  .actions .btn {
    height: 26px;
    padding: 0 9px;
    font-size: 12px;
  }
  .load-more {
    margin: 16px auto 0;
    display: flex;
  }
  .empty {
    padding: 30px;
    text-align: center;
  }
</style>
