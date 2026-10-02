<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import {
    HIGHLIGHT_COLORS,
    type Annotation,
    type Book,
    type Bookmark,
    type ExportFormat,
    type HighlightColor,
    type HighlightStyle,
  } from '@shared/types'
  import { toJSON, toMarkdown } from '../annotations/export'
  import { AnnotationStore } from '../annotations/store.svelte'
  import { createEngine } from '../engines'
  import {
    HIGHLIGHT_HEX,
    type Engine,
    type Relocation,
    type SelectionInfo,
    type ViewportRect,
  } from '../engines/types'
  import Icon from '../lib/Icon.svelte'
  import { app, closeBook, theme, toast, updateSettings } from '../lib/app.svelte'
  import { ipc } from '../lib/ipc'
  import AppearancePanel from './AppearancePanel.svelte'
  import LookupView from './LookupView.svelte'
  import Popover from './Popover.svelte'
  import SidePanel, { type PanelTab } from './SidePanel.svelte'
  import { Speaker } from './tts.svelte'

  let { bookId: currentBookId }: { bookId: number } = $props()
  // This component lives for exactly one book (see the {#key} in App); pin
  // the id so that nothing still pending after we close can act on another.
  // svelte-ignore state_referenced_locally
  const bookId = currentBookId

  type PopoverState =
    | { kind: 'selection'; info: SelectionInfo }
    | { kind: 'annotation'; id: number; rect: ViewportRect }
    | { kind: 'lookup'; query: string; language: string; rect: ViewportRect; mode: 'dictionary' | 'wikipedia' }

  const store = new AnnotationStore(bookId)
  const speaker = new Speaker(() => app.settings)

  let book = $state<Book | null>(null)
  let engine = $state.raw<Engine | null>(null)
  let container = $state<HTMLElement>()
  let panel = $state<SidePanel>()
  let status = $state<'loading' | 'ready' | 'error'>('loading')
  let errorMessage = $state('')
  let relocation = $state<Relocation | null>(null)
  let panelOpen = $state(false)
  let tab = $state<PanelTab>('contents')
  let searchQuery = $state('')
  let popover = $state<PopoverState | null>(null)
  let appearanceOpen = $state(false)
  let backStack = $state<string[]>([])
  let sliderValue = $state<number | null>(null)
  let noteDraft = $state('')

  const appearance = $derived({ settings: $state.snapshot(app.settings), theme: theme() })
  const percent = $derived(Math.round((sliderValue ?? relocation?.fraction ?? 0) * 100))
  const paginated = $derived(app.settings.flow === 'paginated' && book?.format !== 'pdf')
  const editing = $derived(popover?.kind === 'annotation' ? store.get(popover.id) : undefined)

  /* ---------- lifecycle ---------- */

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let noteTimer: ReturnType<typeof setTimeout> | undefined
  /** The annotation `noteDraft` belongs to. */
  let noteFor: number | null = null
  let unsaved: Relocation | null = null
  let destroyed = false

  function saveProgress() {
    clearTimeout(saveTimer)
    flushNote()
    if (!unsaved) return
    void ipc.invoke('books:setProgress', bookId, unsaved.fraction, unsaved.location)
    unsaved = null
  }

  onMount(async () => {
    try {
      const loaded = await ipc.invoke('books:get', bookId)
      if (!loaded) throw new Error('This book is no longer in the library')
      book = loaded
      void ipc.invoke('window:setTitle', `${loaded.title} — BookViewer`)
      void ipc.invoke('books:opened', bookId)
      await store.load()
      const created = await createEngine(loaded, {
        relocate(next) {
          if (destroyed) return
          relocation = next
          unsaved = next
          clearTimeout(saveTimer)
          saveTimer = setTimeout(saveProgress, 800)
        },
        selection(info) {
          if (info) popover = { kind: 'selection', info }
          else if (popover?.kind === 'selection') popover = null
        },
        annotationClick(id, rect) {
          openAnnotation(id, rect)
        },
        keydown: onKeydown,
        click() {
          popover = null
          appearanceOpen = false
        },
        jump: remember,
        settings: updateSettings,
      })
      if (destroyed || !container) {
        created.destroy()
        return
      }
      try {
        await created.open(container, {
          location: loaded.location,
          appearance: untrack(() => appearance),
          annotations: $state.snapshot(store.annotations) as Annotation[],
        })
      } catch (error) {
        created.destroy()
        throw error
      }
      // The reader may have been closed while the book was opening.
      if (destroyed) {
        created.destroy()
        return
      }
      engine = created
      status = 'ready'
      // pick up settings changed in the meantime
      created.setAppearance(untrack(() => appearance))
      created.focus()
    } catch (error) {
      if (destroyed) return
      console.error(error)
      errorMessage = error instanceof Error ? error.message : String(error)
      status = 'error'
    }
  })

  onDestroy(() => {
    saveProgress()
    destroyed = true
    clearTimeout(saveTimer)
    speaker.stop()
    engine?.destroy()
  })

  $effect(() => {
    const next = appearance
    untrack(() => engine)?.setAppearance(next)
  })

  $effect(() => {
    const annotations = $state.snapshot(store.annotations) as Annotation[]
    engine?.setAnnotations(annotations)
  })

  /* ---------- navigation ---------- */

  /** Remembers the current place so that "Back" can return to it. */
  function remember() {
    const location = relocation?.location
    if (location && backStack.at(-1) !== location) backStack = [...backStack.slice(-19), location]
  }

  function navigate(target: string) {
    remember()
    popover = null
    void engine?.goTo(target)
  }

  function goBack() {
    const target = backStack.at(-1)
    if (!target) return
    backStack = backStack.slice(0, -1)
    void engine?.goTo(target)
  }

  function seek(fraction: number) {
    remember()
    void engine?.goToFraction(fraction)
  }

  function leave() {
    saveProgress()
    closeBook()
  }

  /* ---------- annotations ---------- */

  function openAnnotation(id: number, rect: ViewportRect) {
    const annotation = store.get(id)
    if (!annotation) return
    flushNote()
    noteFor = id
    noteDraft = annotation.note
    popover = { kind: 'annotation', id, rect }
  }

  /** Saves what has been typed in the note editor, to the note it was typed for. */
  function flushNote() {
    clearTimeout(noteTimer)
    if (noteFor == null) return
    const annotation = store.get(noteFor)
    if (annotation && annotation.note !== noteDraft) void store.update(noteFor, { note: noteDraft })
  }

  // However the editor gets closed (Escape, a click elsewhere, another
  // popover taking its place), the note in it is kept.
  $effect(() => {
    if (popover?.kind === 'annotation') return
    untrack(flushNote)
    noteFor = null
  })

  async function highlight(color: HighlightColor, withNote = false) {
    if (popover?.kind !== 'selection') return
    const { info } = popover
    const saved = await store.add({
      selector: info.selector,
      text: info.text,
      note: '',
      color,
      style: 'highlight',
      label: info.label,
      position: info.position,
    })
    engine?.clearSelection()
    if (withNote) openAnnotation(saved.id, info.rect)
    else popover = null
  }

  function setStyle(patch: { color?: HighlightColor; style?: HighlightStyle }) {
    if (editing) void store.update(editing.id, patch)
  }

  async function removeAnnotation() {
    if (!editing) return
    const { id } = editing
    clearTimeout(noteTimer)
    noteFor = null
    popover = null
    await store.remove(id)
  }

  function showAnnotation(annotation: Annotation) {
    remember()
    void engine?.showAnnotation($state.snapshot(annotation) as Annotation)
  }

  async function addBookmark() {
    if (!relocation) return
    const { location, label, excerpt, fraction } = relocation
    if (store.bookmarks.some(bookmark => bookmark.location === location)) {
      toast('This place is already bookmarked')
      return
    }
    await store.addBookmark({ location, label, excerpt, position: fraction })
    toast('Bookmark added')
  }

  function showBookmark(bookmark: Bookmark) {
    navigate(bookmark.location)
  }

  async function exportAnnotations(format: ExportFormat) {
    if (!book) return
    const annotations = $state.snapshot(store.annotations) as Annotation[]
    const bookmarks = $state.snapshot(store.bookmarks) as Bookmark[]
    const content =
      format === 'json' ? toJSON(book, annotations, bookmarks) : toMarkdown(book, annotations, bookmarks)
    const path = await ipc.invoke('annotations:export', bookId, format, content)
    if (path) toast(`Exported to ${path}`)
  }

  /* ---------- selection actions ---------- */

  async function copy(text: string) {
    await navigator.clipboard.writeText(text)
    popover = null
    toast('Copied')
  }

  function lookup(mode: 'dictionary' | 'wikipedia') {
    if (popover?.kind !== 'selection') return
    const { info } = popover
    popover = {
      kind: 'lookup',
      mode,
      query: info.text.replace(/\s+/g, ' ').slice(0, 200),
      language: info.language || app.settings.lookupLanguage,
      rect: info.rect,
    }
  }

  function translate(text: string) {
    const target = encodeURIComponent(app.settings.translateTarget || 'en')
    void ipc.invoke(
      'shell:openExternal',
      `https://translate.google.com/?sl=auto&tl=${target}&op=translate&text=${encodeURIComponent(text.slice(0, 4000))}`,
    )
    popover = null
  }

  function searchFor(text: string) {
    popover = null
    searchQuery = text.replace(/\s+/g, ' ').trim().slice(0, 120)
    panelOpen = true
    tab = 'search'
    requestAnimationFrame(() => void panel?.search())
  }

  function openSearch() {
    panelOpen = true
    tab = 'search'
    requestAnimationFrame(() => panel?.focusSearch())
  }

  function togglePanel(next: PanelTab) {
    if (panelOpen && tab === next) panelOpen = false
    else {
      panelOpen = true
      tab = next
    }
  }

  /* ---------- read aloud ---------- */

  function toggleSpeech() {
    if (speaker.active) speaker.stop()
    else if (engine) {
      popover = null
      void speaker.start(engine)
    }
  }

  /* ---------- keyboard ---------- */

  function onKeydown(event: KeyboardEvent) {
    if (!engine || event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    const typing =
      !!target?.closest?.(
        'textarea, select, [contenteditable="true"], input:not([type="range"], [type="checkbox"])',
      ) && target.ownerDocument === document
    const mod = event.ctrlKey || event.metaKey

    if (event.key === 'Escape') {
      if (popover) popover = null
      else if (appearanceOpen) appearanceOpen = false
      else if (app.fullscreen) void ipc.invoke('window:setFullscreen', false)
      else if (typing) (target as HTMLElement).blur()
      else return
      event.preventDefault()
      return
    }
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      openSearch()
      return
    }
    if (mod && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      void addBookmark()
      return
    }
    if (mod && (event.key === '=' || event.key === '+')) {
      event.preventDefault()
      updateSettings({ fontSize: Math.min(40, app.settings.fontSize + 1) })
      return
    }
    if (mod && event.key === '-') {
      event.preventDefault()
      updateSettings({ fontSize: Math.max(10, app.settings.fontSize - 1) })
      return
    }
    if (event.key === 'F11') {
      event.preventDefault()
      void ipc.invoke('window:setFullscreen', !app.fullscreen)
      return
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault()
      goBack()
      return
    }
    if (typing || mod || event.altKey) return

    switch (event.key) {
      case 'ArrowRight':
      case 'PageDown':
        engine.next()
        break
      case 'ArrowLeft':
      case 'PageUp':
        engine.prev()
        break
      case ' ':
        if (event.shiftKey) engine.prev()
        else engine.next()
        break
      case 'ArrowDown':
      case 'j':
        engine.step(1)
        break
      case 'ArrowUp':
      case 'k':
        engine.step(-1)
        break
      case 'Home':
        remember()
        engine.goToEdge('start')
        break
      case 'End':
        remember()
        engine.goToEdge('end')
        break
      case '/':
        openSearch()
        break
      case 't':
        togglePanel('contents')
        break
      default:
        return
    }
    event.preventDefault()
  }

  /* ---------- side panel width ---------- */

  let sideWidth = $state<number | null>(null)

  function startResize(event: PointerEvent) {
    event.preventDefault()
    const handle = event.currentTarget as HTMLElement
    const left = handle.parentElement!.getBoundingClientRect().left
    handle.setPointerCapture(event.pointerId)
    const move = (e: PointerEvent) => {
      sideWidth = Math.round(Math.min(innerWidth * 0.5, Math.max(220, e.clientX - left)))
    }
    const stop = () => {
      handle.removeEventListener('pointermove', move)
      if (sideWidth != null) updateSettings({ sidebarWidth: sideWidth })
      sideWidth = null
    }
    handle.addEventListener('pointermove', move)
    handle.addEventListener('pointerup', stop, { once: true })
    handle.addEventListener('pointercancel', stop, { once: true })
  }

  function onWindowPointerDown(event: PointerEvent) {
    const target = event.target as Element
    if (popover && !target.closest('.popover')) popover = null
    if (appearanceOpen && !target.closest('.appearance, .appearance-toggle')) appearanceOpen = false
  }

  const STYLES: { style: HighlightStyle; label: string }[] = [
    { style: 'highlight', label: 'Highlight' },
    { style: 'underline', label: 'Underline' },
    { style: 'squiggly', label: 'Squiggle' },
    { style: 'strikethrough', label: 'Strike' },
  ]
  const RATES = [0.75, 1, 1.25, 1.5, 1.75, 2]
</script>

<svelte:window onkeydown={onKeydown} onpointerdown={onWindowPointerDown} onbeforeunload={saveProgress} />

<div class="reader" class:fullscreen={app.fullscreen}>
  <header class="toolbar">
    <button class="icon-btn" title="Back to library" aria-label="Back to library" onclick={leave}>
      <Icon name="arrow-left" />
    </button>
    <button
      class="icon-btn"
      class:on={panelOpen}
      title="Contents, highlights and search (T)"
      aria-label="Toggle side panel"
      disabled={!engine}
      onclick={() => (panelOpen = !panelOpen)}
    >
      <Icon name="sidebar" />
    </button>
    <div class="title ellipsis">
      <strong>{book?.title ?? ''}</strong>
      {#if relocation?.label}<span class="muted"> — {relocation.label}</span>{/if}
    </div>
    <button class="icon-btn" title="Search in book (Ctrl+F)" aria-label="Search" disabled={!engine} onclick={openSearch}>
      <Icon name="search" />
    </button>
    <button class="icon-btn" title="Add bookmark (Ctrl+D)" aria-label="Add bookmark" disabled={!engine} onclick={addBookmark}>
      <Icon name="bookmark" />
    </button>
    <button
      class="icon-btn"
      class:on={speaker.active}
      title="Read aloud"
      aria-label="Read aloud"
      disabled={!engine}
      onclick={toggleSpeech}
    >
      <Icon name="volume" />
    </button>
    <button
      class="icon-btn appearance-toggle"
      class:on={appearanceOpen}
      title="Appearance"
      aria-label="Appearance"
      onclick={() => (appearanceOpen = !appearanceOpen)}
    >
      <Icon name="type" />
    </button>
    <button
      class="icon-btn"
      title="Full screen (F11)"
      aria-label="Full screen"
      onclick={() => ipc.invoke('window:setFullscreen', !app.fullscreen)}
    >
      <Icon name="maximize" />
    </button>
  </header>

  <div class="body">
    {#if panelOpen && engine}
      <div class="side" style:width="{sideWidth ?? app.settings.sidebarWidth}px">
        <SidePanel
          bind:this={panel}
          bind:tab
          bind:searchQuery
          {engine}
          {store}
          tocId={relocation?.tocId ?? null}
          onnavigate={navigate}
          onannotation={showAnnotation}
          onbookmark={showBookmark}
          onexport={exportAnnotations}
          onclose={() => (panelOpen = false)}
        />
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="resizer" onpointerdown={startResize}></div>
      </div>
    {/if}

    <div class="stage">
      <div class="content" bind:this={container}></div>

      {#if status === 'loading'}
        <div class="overlay muted">Opening…</div>
      {:else if status === 'error'}
        <div class="overlay">
          <h2>This book could not be opened</h2>
          <p class="muted">{errorMessage}</p>
          <button class="btn" onclick={leave}>Back to library</button>
        </div>
      {/if}

      {#if paginated && engine}
        <button class="edge left" aria-label="Previous page" onclick={() => engine?.prev()}>
          <Icon name="chevron-left" size={22} />
        </button>
        <button class="edge right" aria-label="Next page" onclick={() => engine?.next()}>
          <Icon name="chevron-right" size={22} />
        </button>
      {/if}

      {#if speaker.active || speaker.error}
        <div class="speech">
          {#if speaker.error}
            <span class="speech-error">{speaker.error}</span>
            <button class="icon-btn" aria-label="Dismiss" onclick={() => (speaker.error = '')}>
              <Icon name="x" size={16} />
            </button>
          {:else}
            <button class="icon-btn" title="Previous sentence" aria-label="Previous sentence" onclick={() => speaker.skip(-1)}>
              <Icon name="skip-back" size={16} />
            </button>
            <button
              class="icon-btn"
              title={speaker.state === 'playing' ? 'Pause' : 'Play'}
              aria-label={speaker.state === 'playing' ? 'Pause' : 'Play'}
              onclick={() => speaker.toggle()}
            >
              <Icon name={speaker.state === 'playing' || speaker.state === 'loading' ? 'pause' : 'play'} size={16} />
            </button>
            <button class="icon-btn" title="Next sentence" aria-label="Next sentence" onclick={() => speaker.skip(1)}>
              <Icon name="skip-forward" size={16} />
            </button>
            <select
              class="input"
              aria-label="Speed"
              value={String(app.settings.ttsRate)}
              onchange={event => {
                updateSettings({ ttsRate: Number(event.currentTarget.value) })
                speaker.refresh()
              }}
            >
              {#each RATES as rate (rate)}
                <option value={String(rate)}>{rate}×</option>
              {/each}
            </select>
            {#if speaker.voices.length > 1}
              <select
                class="input voice"
                aria-label="Voice"
                value={app.settings.ttsVoice}
                onchange={event => {
                  updateSettings({ ttsVoice: event.currentTarget.value })
                  speaker.refresh()
                }}
              >
                <option value="">Automatic voice</option>
                {#each speaker.voices as voice (voice.id)}
                  <option value={voice.id}>{voice.name} ({voice.language})</option>
                {/each}
              </select>
            {/if}
            <button class="icon-btn" title="Stop" aria-label="Stop reading" onclick={() => speaker.stop()}>
              <Icon name="stop" size={16} />
            </button>
          {/if}
        </div>
      {/if}
    </div>
  </div>

  <footer class="status">
    {#if backStack.length}
      <button class="btn back" title="Go back (Alt+Left)" onclick={goBack}>
        <Icon name="arrow-left" size={14} /> Back
      </button>
    {/if}
    <span class="where ellipsis muted">{relocation?.label ?? ''}</span>
    <input
      class="slider"
      type="range"
      min="0"
      max="1"
      step="0.001"
      aria-label="Position in book"
      disabled={!engine}
      value={sliderValue ?? relocation?.fraction ?? 0}
      oninput={event => (sliderValue = Number(event.currentTarget.value))}
      onchange={event => {
        seek(Number(event.currentTarget.value))
        sliderValue = null
        // hand the keyboard back to the book
        event.currentTarget.blur()
        engine?.focus()
      }}
    />
    <span class="numbers muted">
      {percent}%{#if relocation?.page}
        · {relocation.page.unit === 'page' ? 'Page' : 'Loc'}
        {relocation.page.current} of {relocation.page.total}{/if}
    </span>
  </footer>
</div>

{#if appearanceOpen}
  <div class="appearance">
    <AppearancePanel reflowable={engine?.reflowable ?? true} pdf={book?.format === 'pdf'} />
  </div>
{/if}

{#if popover?.kind === 'selection'}
  {@const info = popover.info}
  <Popover rect={info.rect}>
    <div class="selection-menu">
      <div class="colors">
        {#each HIGHLIGHT_COLORS as color (color)}
          <button
            class="dot"
            style:background={HIGHLIGHT_HEX[color]}
            title="Highlight {color}"
            aria-label="Highlight {color}"
            onclick={() => highlight(color)}
          ></button>
        {/each}
      </div>
      <span class="divider"></span>
      <button class="icon-btn" title="Add a note" aria-label="Add a note" onclick={() => highlight('yellow', true)}>
        <Icon name="pencil" size={16} />
      </button>
      <button class="icon-btn" title="Copy" aria-label="Copy" onclick={() => copy(info.text)}>
        <Icon name="copy" size={16} />
      </button>
      <button class="icon-btn" title="Look up in dictionary" aria-label="Dictionary" onclick={() => lookup('dictionary')}>
        <Icon name="dictionary" size={16} />
      </button>
      <button class="icon-btn" title="Look up on Wikipedia" aria-label="Wikipedia" onclick={() => lookup('wikipedia')}>
        <Icon name="globe" size={16} />
      </button>
      <button class="icon-btn" title="Translate" aria-label="Translate" onclick={() => translate(info.text)}>
        <Icon name="translate" size={16} />
      </button>
      <button class="icon-btn" title="Find in book" aria-label="Find in book" onclick={() => searchFor(info.text)}>
        <Icon name="search" size={16} />
      </button>
      <button class="icon-btn" title="Read aloud from here" aria-label="Read aloud from here" onclick={toggleSpeech}>
        <Icon name="volume" size={16} />
      </button>
    </div>
  </Popover>
{:else if popover?.kind === 'annotation' && editing}
  <Popover rect={popover.rect}>
    <div class="annotation-editor">
      <div class="editor-row">
        <div class="colors">
          {#each HIGHLIGHT_COLORS as color (color)}
            <button
              class="dot"
              class:selected={editing.color === color}
              style:background={HIGHLIGHT_HEX[color]}
              title={color}
              aria-label={color}
              onclick={() => setStyle({ color })}
            ></button>
          {/each}
        </div>
        <span class="spacer"></span>
        <button class="icon-btn" title="Copy text" aria-label="Copy text" onclick={() => copy(editing.text)}>
          <Icon name="copy" size={16} />
        </button>
        <button class="icon-btn danger" title="Delete highlight" aria-label="Delete highlight" onclick={removeAnnotation}>
          <Icon name="trash" size={16} />
        </button>
      </div>
      <div class="styles">
        {#each STYLES as item (item.style)}
          <button class:selected={editing.style === item.style} onclick={() => setStyle({ style: item.style })}>
            {item.label}
          </button>
        {/each}
      </div>
      <textarea
        class="input"
        rows="3"
        placeholder="Add a note…"
        bind:value={noteDraft}
        onblur={flushNote}
        oninput={() => {
          clearTimeout(noteTimer)
          noteTimer = setTimeout(flushNote, 600)
        }}
      ></textarea>
    </div>
  </Popover>
{:else if popover?.kind === 'lookup'}
  <Popover rect={popover.rect}>
    <LookupView query={popover.query} language={popover.language} bind:mode={popover.mode} />
  </Popover>
{/if}

<style>
  .reader {
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--page-bg);
  }
  .toolbar {
    display: flex;
    align-items: center;
    gap: 2px;
    height: 44px;
    padding: 0 8px;
    flex: none;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .title {
    flex: 1;
    padding: 0 10px;
    text-align: center;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .side {
    position: relative;
    flex: none;
    min-width: 220px;
    max-width: 50vw;
  }
  .resizer {
    position: absolute;
    top: 0;
    right: -3px;
    bottom: 0;
    width: 6px;
    cursor: col-resize;
    z-index: 5;
  }
  .resizer:hover {
    background: color-mix(in srgb, var(--accent) 40%, transparent);
  }
  .stage {
    position: relative;
    flex: 1;
    min-width: 0;
  }
  .content {
    position: absolute;
    inset: 0;
    --bv-bg: var(--page-bg);
  }
  .content :global(foliate-paginator),
  .content :global(foliate-fxl) {
    display: block;
    width: 100%;
    height: 100%;
  }
  .content :global(foliate-paginator::part(filter)),
  .content :global(foliate-fxl::part(filter)) {
    filter: var(--bv-filter, none);
    color-scheme: light;
  }
  .overlay {
    position: absolute;
    inset: 0;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 10px;
    text-align: center;
    padding: 24px;
    background: var(--page-bg);
  }
  .overlay h2 {
    font-size: 17px;
  }
  .edge {
    position: absolute;
    top: 0;
    bottom: 0;
    width: 44px;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
    opacity: 0;
    transition: opacity 0.15s;
  }
  .edge:hover,
  .edge:focus-visible {
    opacity: 1;
    background: var(--hover);
  }
  .edge.left {
    left: 0;
  }
  .edge.right {
    right: 0;
  }
  .status {
    display: flex;
    align-items: center;
    gap: 12px;
    height: 34px;
    padding: 0 12px;
    flex: none;
    border-top: 1px solid var(--border);
    background: var(--surface);
    font-size: 12px;
  }
  .back {
    height: 24px;
    padding: 0 8px;
    font-size: 12px;
  }
  .where {
    flex: 0 1 26%;
    min-width: 0;
  }
  .slider {
    flex: 1;
    min-width: 80px;
    accent-color: var(--accent);
  }
  .numbers {
    flex: none;
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .reader.fullscreen .toolbar,
  .reader.fullscreen .status {
    display: none;
  }

  .appearance {
    position: fixed;
    top: 48px;
    right: 8px;
    z-index: 50;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }

  .speech {
    position: absolute;
    left: 50%;
    bottom: 14px;
    transform: translateX(-50%);
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 5px 8px;
    max-width: calc(100% - 24px);
    border-radius: 999px;
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }
  .speech select {
    height: 28px;
  }
  .speech .voice {
    max-width: 190px;
  }
  .speech-error {
    padding: 0 8px;
    color: var(--danger);
  }

  .selection-menu {
    display: flex;
    align-items: center;
    gap: 2px;
    padding: 5px 6px;
  }
  .colors {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 0 4px;
  }
  .dot {
    width: 20px;
    height: 20px;
    border-radius: 50%;
    border: 1px solid rgb(0 0 0 / 0.15);
  }
  .dot:hover {
    transform: scale(1.15);
  }
  .dot.selected {
    outline: 2px solid var(--fg);
    outline-offset: 2px;
  }
  .divider {
    width: 1px;
    height: 20px;
    margin: 0 4px;
    background: var(--border);
  }
  .annotation-editor {
    width: 320px;
    padding: 10px;
    display: flex;
    flex-direction: column;
    gap: 8px;
  }
  .editor-row {
    display: flex;
    align-items: center;
  }
  .spacer {
    flex: 1;
  }
  .danger {
    color: var(--danger);
  }
  .styles {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .styles button {
    flex: 1;
    height: 26px;
    font-size: 12px;
  }
  .styles button + button {
    border-left: 1px solid var(--border);
  }
  .styles button.selected {
    background: var(--active);
    font-weight: 600;
  }
  textarea {
    width: 100%;
  }
</style>
