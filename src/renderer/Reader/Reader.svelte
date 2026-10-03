<script lang="ts">
  import { onDestroy, onMount, tick, untrack } from 'svelte'
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
  import Shortcuts from '../lib/Shortcuts.svelte'
  import { app, closeBook, dismissToast, runToastAction, theme, toast, updateSettings } from '../lib/app.svelte'
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
  let forwardStack = $state<string[]>([])
  let sliderValue = $state<number | null>(null)
  let noteDraft = $state('')
  let menuOpen = $state(false)
  let shortcutsOpen = $state(false)
  let gotoOpen = $state(false)
  let gotoValue = $state<number | null>(null)
  let noteInput = $state<HTMLTextAreaElement>()
  /** Where the pointer is along the progress bar (0..1), while it is over it. */
  let hoverAt = $state<number | null>(null)

  const appearance = $derived({ settings: $state.snapshot(app.settings), theme: theme() })
  const percent = $derived(Math.round((sliderValue ?? relocation?.fraction ?? 0) * 100))
  const paginated = $derived(app.settings.flow === 'paginated' && book?.format !== 'pdf')
  const editing = $derived(popover?.kind === 'annotation' ? store.get(popover.id) : undefined)
  /** Chapter starts to mark on the progress bar; left out when too many to tell apart. */
  const chapterMarks = $derived.by(() => {
    void relocation // a PDF's outline arrives after the book has opened
    const starts = engine?.chapterStarts ?? []
    return starts.length <= 60 ? starts : []
  })
  const unit = $derived(relocation?.page?.unit === 'page' ? 'page' : 'location')
  /** What the previous/next buttons move by: a page only where pages are turned. */
  const stepName = $derived(paginated ? 'page' : 'screen')
  /** What a jump along the progress bar would land on, shown while aiming. */
  const preview = $derived.by(() => {
    const at = sliderValue ?? hoverAt
    if (at == null || !engine) return null
    const { label, page } = engine.describe(at)
    const where = page ? `${page.unit === 'page' ? 'Page' : 'Location'} ${page.current}` : `${Math.round(at * 100)}%`
    return { at, text: label ? `${where} · ${label}` : where }
  })
  const timeLeft = $derived(
    relocation?.minutesLeft ? `${duration(relocation.minutesLeft.chapter)} left in chapter` : '',
  )
  /** The bookmarks that are on the page (or screen) being shown. */
  const marked = $derived.by(() => {
    // every move through the book is a reason to look again
    void relocation
    const current = engine
    return current ? store.bookmarks.filter(bookmark => current.isInView(bookmark.location)) : []
  })

  /* ---------- lifecycle ---------- */

  let saveTimer: ReturnType<typeof setTimeout> | undefined
  let noteTimer: ReturnType<typeof setTimeout> | undefined
  /** The annotation `noteDraft` belongs to. */
  let noteFor: number | null = null
  let unsaved: Relocation | null = null
  /** Whether the reader has moved from where the book opened. */
  let moved = false
  let destroyed = false

  function saveProgress() {
    // (first, so that a last bit of scrolling is not left out)
    engine?.flush()
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
      await store.load()
      const created = await createEngine(loaded, {
        relocate(next) {
          if (destroyed) return
          relocation = next
          // Opening a book is not reading it: what it reports while it opens,
          // and being put back where it was, leaves the saved place (and a
          // "finished" mark) alone until the reader actually moves.
          if (!moved && (status !== 'ready' || next.location === loaded.location)) return
          moved = true
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
          menuOpen = false
          gotoOpen = false
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
      // (only now: a book that fails to open should not jump to "recently read")
      void ipc.invoke('books:opened', bookId)
      // pick up settings changed in the meantime
      created.setAppearance(untrack(() => appearance))
      created.focus()
    } catch (error) {
      if (destroyed) return
      // Whatever a book reported before failing to open is not where the
      // reader was: the place saved earlier stays.
      clearTimeout(saveTimer)
      unsaved = null
      console.error(error)
      errorMessage = error instanceof Error ? error.message : String(error)
      status = 'error'
    }
  })

  // Toasts sit above the bottom bar, and above the read-aloud bar when it is up.
  $effect(() => {
    const raised = speaker.active || speaker.error ? '104px' : '56px'
    document.documentElement.style.setProperty('--toast-bottom', raised)
    return () => document.documentElement.style.removeProperty('--toast-bottom')
  })

  onDestroy(() => {
    // an Undo offered here works on this reader's copy of the book's marks
    if (app.toast?.action?.undo) dismissToast()
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
    // a new jump starts a new branch
    forwardStack = []
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
    const here = relocation?.location
    if (here) forwardStack = [...forwardStack, here]
    void engine?.goTo(target)
  }

  function goForward() {
    const target = forwardStack.at(-1)
    if (!target) return
    forwardStack = forwardStack.slice(0, -1)
    const here = relocation?.location
    if (here) backStack = [...backStack, here]
    void engine?.goTo(target)
  }

  function seek(fraction: number) {
    remember()
    void engine?.goToFraction(fraction)
  }

  async function leave() {
    // A jump or page turn still under way gets where it is going first:
    // that, not where it started from, is the place the reader left at.
    await engine?.settled()
    saveProgress()
    closeBook()
  }

  function duration(minutes: number): string {
    if (minutes < 1) return 'Under a minute'
    if (minutes < 60) return `${Math.round(minutes)} min`
    const hours = Math.floor(minutes / 60)
    const rest = Math.round(minutes % 60)
    return rest ? `${hours} h ${rest} min` : `${hours} h`
  }

  function openGoTo() {
    if (!relocation?.page) return
    menuOpen = false
    gotoValue = relocation.page.current
    gotoOpen = true
  }

  function submitGoTo() {
    const page = relocation?.page
    const wanted = Math.round(Number(gotoValue))
    gotoOpen = false
    if (page && wanted >= 1) {
      const at = fractionOfPage(Math.min(wanted, page.total), page.total)
      // A location is a stretch of text, not a line: aim a little way into
      // it, or the pixel the scroll rounds down to belongs to the one before.
      seek(Math.min(1, page.unit === 'loc' ? at + 0.25 / page.total : at))
    }
    engine?.focus()
  }

  /** Where in the book (0..1) a page or location number starts. */
  function fractionOfPage(wanted: number, total: number): number {
    const current = (at: number) => engine?.describe(at).page?.current
    // (a hair past the boundary, so that rounding cannot land on the page before)
    if (current(0) == null) return (wanted - 1) / total + 1e-7
    // The engine knows how it counts; close in on the first spot it calls `wanted`.
    let low = 0
    let high = 1
    for (let i = 0; i < 32; i++) {
      const middle = (low + high) / 2
      if ((current(middle) ?? 0) < wanted) low = middle
      else high = middle
    }
    return Math.min(1, high + 1e-7)
  }

  const selectAll = (node: HTMLInputElement) => node.select()
  const focusNow = (node: HTMLElement) => node.focus()

  function toggleFullscreen() {
    menuOpen = false
    void ipc.invoke('window:setFullscreen', !app.fullscreen)
  }

  // The bars hide in full screen; say how to get out before they are gone.
  let wasFullscreen = untrack(() => app.fullscreen)
  $effect(() => {
    const on = app.fullscreen
    if (on && !wasFullscreen) toast('Move the pointer to the top edge for the toolbar. Esc leaves full screen.')
    wasFullscreen = on
  })

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
    // (a PDF selection over a page break is kept as one highlight per page)
    const [first, ...rest] = info.parts ?? [info]
    const mark = ({ selector, text, label, position }: typeof first) =>
      store.add({ selector, text, note: '', color, style: 'highlight', label, position })
    const saved = await mark(first)
    for (const part of rest) await mark(part)
    engine?.clearSelection()
    if (withNote) {
      openAnnotation(saved.id, info.rect)
      // the reader asked to write: put the caret in the note
      await tick()
      noteInput?.focus()
    } else popover = null
  }

  function setStyle(patch: { color?: HighlightColor; style?: HighlightStyle }) {
    if (editing) void store.update(editing.id, patch)
  }

  async function removeAnnotation() {
    if (!editing) return
    const { id, selector, text, color, style, label, position, createdAt } = $state.snapshot(editing) as Annotation
    const note = noteFor === id ? noteDraft : editing.note
    clearTimeout(noteTimer)
    noteFor = null
    popover = null
    await store.remove(id)
    toast(note ? 'Highlight and note deleted' : 'Highlight deleted', {
      action: {
        label: 'Undo',
        undo: true,
        run: () => void store.add({ selector, text, note, color, style, label, position, createdAt }),
      },
    })
  }

  function showAnnotation(annotation: Annotation) {
    remember()
    void engine?.showAnnotation($state.snapshot(annotation) as Annotation)
  }

  /** "page 42", "location 310" - how the status bar counts, in a sentence. */
  function placeName({ page, fraction }: Relocation): string {
    if (!page) return `${Math.round(fraction * 100)}%`
    return `${page.unit === 'page' ? 'page' : 'location'} ${page.current}`
  }

  let bookmarking = false

  /** Bookmarks the page being read, or takes its bookmark away again. */
  async function toggleBookmark() {
    // (one at a time: a second press before the first is stored would double it)
    if (!relocation || bookmarking) return
    bookmarking = true
    try {
      if (marked.length) {
        await removeBookmarks(
          $state.snapshot(marked) as Bookmark[],
          `Removed the bookmark from ${placeName(relocation)}`,
        )
        return
      }
      const { location, label, excerpt, fraction } = relocation
      const saved = await store.addBookmark({ location, label, excerpt, position: fraction })
      toast(`Bookmarked ${placeName(relocation)}${label ? ` in “${label}”` : ''}`, {
        action: { label: 'Undo', undo: true, run: () => void store.removeBookmark(saved.id) },
      })
    } finally {
      bookmarking = false
    }
  }

  async function removeBookmarks(bookmarks: Bookmark[], message = 'Bookmark removed') {
    for (const bookmark of bookmarks) await store.removeBookmark(bookmark.id)
    toast(message, {
      action: {
        label: 'Undo',
        undo: true,
        run: () => {
          for (const { location, label, excerpt, position, createdAt } of bookmarks)
            void store.addBookmark({ location, label, excerpt, position, createdAt })
        },
      },
    })
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
    if (panelOpen && tab === next) closePanel()
    else {
      panelOpen = true
      tab = next
    }
  }

  function closePanel() {
    panelOpen = false
    // search marks belong to the search panel; the query stays for next time
    engine?.clearSearch()
    engine?.focus()
  }

  /** Ctrl +/-: text size, or zoom where pages have a fixed size. */
  function resize(direction: 1 | -1) {
    if (engine?.zoom) engine.zoom(direction)
    else updateSettings({ fontSize: Math.min(40, Math.max(10, app.settings.fontSize + direction)) })
  }

  let sliderByPointer = false

  /* ---------- read aloud ---------- */

  function toggleSpeech() {
    if (speaker.active) speaker.stop()
    else if (engine) {
      popover = null
      void speaker.start(engine)
    }
  }

  /** "Listen" on a selection always (re)starts from there. */
  function speakFromSelection() {
    if (!engine) return
    speaker.stop()
    popover = null
    void speaker.start(engine)
  }

  /* ---------- keyboard ---------- */

  function onKeydown(event: KeyboardEvent) {
    if (event.defaultPrevented) return
    const target = event.target as HTMLElement | null
    const typing =
      !!target?.closest?.(
        'textarea, select, [contenteditable="true"], input:not([type="range"], [type="checkbox"])',
      ) && target.ownerDocument === document
    const mod = event.ctrlKey || event.metaKey

    // a dialog is up: nothing behind it reacts
    if (shortcutsOpen) return
    if (event.key === 'Escape') {
      if (menuOpen) menuOpen = false
      else if (gotoOpen) gotoOpen = false
      else if (popover) popover = null
      else if (appearanceOpen) appearanceOpen = false
      else if (typing) (target as HTMLElement).blur()
      else if (panelOpen) closePanel()
      else if (app.fullscreen) void ipc.invoke('window:setFullscreen', false)
      else return
      event.preventDefault()
      return
    }
    if (!engine) {
      // Still opening, or it could not be opened: only the ways out work.
      if (event.altKey && event.key === 'ArrowLeft') {
        event.preventDefault()
        leave()
      }
      return
    }
    // F6 goes between the book's text (where Tab walks its links) and the toolbar.
    if (event.key === 'F6') {
      event.preventDefault()
      const inBars = !!document.activeElement?.closest('.toolbar')
      if (inBars) engine.focus()
      else document.querySelector<HTMLElement>('.reader .toolbar button:not(:disabled)')?.focus()
      return
    }
    if (mod && event.key.toLowerCase() === 'f') {
      event.preventDefault()
      openSearch()
      return
    }
    if (mod && event.key.toLowerCase() === 'g') {
      event.preventDefault()
      openGoTo()
      return
    }
    if (mod && event.key.toLowerCase() === 'd') {
      event.preventDefault()
      // (a held key would flip it on and off)
      if (!event.repeat) void toggleBookmark()
      return
    }
    // Ctrl+Z takes back what the toast on screen offers to undo.
    if (mod && event.key.toLowerCase() === 'z' && !typing && app.toast?.action?.undo) {
      event.preventDefault()
      runToastAction()
      return
    }
    if (mod && (event.key === '=' || event.key === '+')) {
      event.preventDefault()
      resize(1)
      return
    }
    if (mod && event.key === '-') {
      event.preventDefault()
      resize(-1)
      return
    }
    if (mod && event.key === '0' && engine.zoom) {
      event.preventDefault()
      engine.zoom(0)
      return
    }
    if (event.key === 'F11') {
      event.preventDefault()
      void ipc.invoke('window:setFullscreen', !app.fullscreen)
      return
    }
    if (event.altKey && event.key === 'ArrowLeft') {
      event.preventDefault()
      // with nowhere to go back to in the book, "back" is the library
      if (backStack.length) goBack()
      else leave()
      return
    }
    if (event.altKey && event.key === 'ArrowRight') {
      event.preventDefault()
      goForward()
      return
    }
    // A control that has the keyboard keeps its own keys: arrows move a
    // slider, Space presses a button, and an open menu is not paged past.
    const here = target?.ownerDocument === document ? target : null
    const inControl = !!here?.closest('.appearance, .goto, .menu, input[type="range"], select')
    const onButton = !!here?.closest('button')
    // While a highlight's editor is open the keyboard is for its note, not the book.
    if (typing || mod || event.altKey || popover?.kind === 'annotation' || inControl || menuOpen) return
    if (onButton && (event.key === ' ' || event.key === 'Enter')) return

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
      case '?':
        menuOpen = false
        shortcutsOpen = true
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
    if (menuOpen && !target.closest('.more-menu, .more-toggle')) menuOpen = false
    if (gotoOpen && !target.closest('.goto, .position')) gotoOpen = false
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
  <header class="toolbar" class:pinned={menuOpen || appearanceOpen}>
    <div class="group">
      <button class="lib-btn" title="Back to library (Alt+←)" aria-label="Back to library" onclick={leave}>
        <Icon name="arrow-left" size={16} />
        <span>Library</span>
      </button>
      <button
        class="icon-btn"
        class:on={panelOpen}
        title="Contents, highlights and bookmarks (T)"
        aria-label="Toggle side panel"
        aria-pressed={panelOpen}
        disabled={!engine}
        onclick={() => (panelOpen ? closePanel() : (panelOpen = true))}
      >
        <Icon name="sidebar" />
      </button>
    </div>

    <div class="title">
      <h1 class="ellipsis">{book?.title ?? ''}</h1>
      {#if relocation?.label && relocation.label !== book?.title}
        <span class="chapter muted ellipsis">{relocation.label}</span>
      {/if}
    </div>

    <div class="group end">
      {#if engine?.zoom}
        <button class="icon-btn" title="Zoom out (Ctrl+−)" aria-label="Zoom out" onclick={() => engine?.zoom?.(-1)}>
          <Icon name="zoom-out" />
        </button>
        <button class="icon-btn" title="Zoom in (Ctrl++). Ctrl+0 fits the width." aria-label="Zoom in" onclick={() => engine?.zoom?.(1)}>
          <Icon name="zoom-in" />
        </button>
        <span class="sep"></span>
      {/if}
      <button class="icon-btn" title="Search in book (Ctrl+F)" aria-label="Search in book" disabled={!engine} onclick={openSearch}>
        <Icon name="search" />
      </button>
      <button
        class="icon-btn"
        class:bookmarked={marked.length > 0}
        title={marked.length ? 'Remove bookmark (Ctrl+D)' : 'Bookmark this page (Ctrl+D)'}
        aria-label="Bookmark this page"
        aria-pressed={marked.length > 0}
        disabled={!engine}
        onclick={toggleBookmark}
      >
        <Icon name="bookmark" />
      </button>
      <button
        class="icon-btn"
        class:on={speaker.active}
        title={speaker.active ? 'Stop reading aloud' : 'Read aloud'}
        aria-label="Read aloud"
        aria-pressed={speaker.active}
        disabled={!engine}
        onclick={toggleSpeech}
      >
        <Icon name="volume" />
      </button>
      <button
        class="icon-btn appearance-toggle"
        class:on={appearanceOpen}
        title="Text and theme"
        aria-label="Text and theme"
        aria-expanded={appearanceOpen}
        onclick={() => (appearanceOpen = !appearanceOpen)}
      >
        <Icon name="text-size" />
      </button>
      <button
        class="icon-btn more-toggle"
        class:on={menuOpen}
        title="More"
        aria-label="More"
        aria-haspopup="menu"
        aria-expanded={menuOpen}
        onclick={() => (menuOpen = !menuOpen)}
      >
        <Icon name="more" />
      </button>
    </div>
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
          onremovebookmark={bookmark => removeBookmarks([$state.snapshot(bookmark) as Bookmark])}
          onexport={exportAnnotations}
          onclose={closePanel}
        />
        <!-- svelte-ignore a11y_no_static_element_interactions -->
        <div class="resizer" onpointerdown={startResize}></div>
      </div>
    {/if}

    <main class="stage">
      <div class="content" bind:this={container}></div>

      {#if status === 'loading'}
        <div class="overlay muted">
          <span class="spinner" aria-hidden="true"></span>
          Opening{book ? ` “${book.title}”` : ''}…
        </div>
      {:else if status === 'error'}
        <div class="overlay">
          <h2>This book could not be opened</h2>
          <p class="muted">{errorMessage}</p>
          <div class="overlay-actions">
            <button class="btn" onclick={() => ipc.invoke('books:showInFolder', bookId)}>
              <Icon name="folder" size={15} /> Show in file manager
            </button>
            <button class="btn primary" use:focusNow onclick={leave}>Back to library</button>
          </div>
        </div>
      {/if}

      {#if marked.length}
        <button
          class="ribbon"
          title="This page is bookmarked. Click to remove the bookmark."
          aria-label="Remove bookmark from this page"
          onclick={toggleBookmark}
        >
          <svg viewBox="0 0 24 38" width="24" height="38" aria-hidden="true">
            <path d="M0 0h24v38l-12-9-12 9z" />
          </svg>
        </button>
      {/if}

      {#if paginated && engine}
        <!-- pointer shortcuts; the buttons in the bottom bar are the real controls -->
        <button class="edge left" tabindex="-1" aria-hidden="true" onclick={() => engine?.prev()}>
          <Icon name="chevron-left" size={22} />
        </button>
        <button class="edge right" tabindex="-1" aria-hidden="true" onclick={() => engine?.next()}>
          <Icon name="chevron-right" size={22} />
        </button>
      {/if}

    </main>
  </div>

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
        <button class="btn stop" onclick={() => speaker.stop()}>
          <Icon name="stop" size={14} /> Stop
        </button>
      {/if}
    </div>
  {/if}

  {#if status !== 'error'}
  <footer class="status">
    <button class="icon-btn" title="Previous {stepName} (←)" aria-label="Previous {stepName}" disabled={!engine} onclick={() => engine?.prev()}>
      <Icon name="chevron-left" />
    </button>
    <span class="history">
      <button
        class="icon-btn"
        title="Go back to where you were before the last jump (Alt+←)"
        aria-label="Go back"
        disabled={!backStack.length}
        onclick={goBack}
      >
        <Icon name="undo" size={16} />
      </button>
      <button
        class="icon-btn"
        title="Go forward again (Alt+→)"
        aria-label="Go forward"
        disabled={!forwardStack.length}
        onclick={goForward}
      >
        <Icon name="redo" size={16} />
      </button>
    </span>
    {#if timeLeft}
      <span
        class="where ellipsis muted"
        title="About {duration(relocation?.minutesLeft?.book ?? 0)} left in the book"
      >
        {timeLeft}
      </span>
    {/if}
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div
      class="track"
      onpointermove={event => {
        const box = event.currentTarget.getBoundingClientRect()
        hoverAt = Math.min(1, Math.max(0, (event.clientX - box.left - 8) / (box.width - 16)))
      }}
      onpointerleave={() => (hoverAt = null)}
      onpointerdown={() => (sliderByPointer = true)}
    >
      {#if preview}
        <span class="preview" style:--at={preview.at}>{preview.text}</span>
      {/if}
      <input
        class="slider"
        type="range"
        min="0"
        max="1"
        step="0.001"
        aria-label="Position in book"
        disabled={!engine}
        style:--fill="{(sliderValue ?? relocation?.fraction ?? 0) * 100}%"
        value={sliderValue ?? relocation?.fraction ?? 0}
        oninput={event => (sliderValue = Number(event.currentTarget.value))}
        onchange={event => {
          seek(Number(event.currentTarget.value))
          sliderValue = null
          // after a drag, hand the keyboard back to the book; when the arrow
          // keys are moving the slider, focus has to stay on it
          if (sliderByPointer) {
            event.currentTarget.blur()
            engine?.focus()
          }
          sliderByPointer = false
        }}
      />
      {#each chapterMarks as at (at)}
        <span class="mark" style:--at={at}></span>
      {/each}
      {#each store.bookmarks as bookmark (bookmark.id)}
        <button
          class="mark bookmark"
          style:--at={bookmark.position}
          title="Bookmark{bookmark.label ? ` in “${bookmark.label}”` : ''} ({Math.round(bookmark.position * 100)}%)"
          aria-label="Go to bookmark at {Math.round(bookmark.position * 100)}%"
          onclick={() => showBookmark(bookmark)}
        ></button>
      {/each}
    </div>
    <div class="position-wrap">
      <button
        class="position"
        title={relocation?.page ? `Go to a ${unit} (Ctrl+G)` : undefined}
        aria-haspopup="dialog"
        aria-expanded={gotoOpen}
        disabled={!relocation?.page}
        onclick={() => (gotoOpen ? (gotoOpen = false) : openGoTo())}
      >
        {#if relocation?.page}
          <span>{unit === 'page' ? 'Page' : 'Location'} {relocation.page.current} of {relocation.page.total}</span>
        {/if}
        <span class="percent">{percent}%</span>
      </button>
      {#if gotoOpen && relocation?.page}
        <form
          class="goto"
          onsubmit={event => {
            event.preventDefault()
            submitGoTo()
          }}
        >
          <label for="goto-input">Go to {unit}</label>
          <input
            id="goto-input"
            class="input"
            type="number"
            min="1"
            max={relocation.page.total}
            bind:value={gotoValue}
            use:selectAll
          />
          <span class="muted">of {relocation.page.total}</span>
          <button class="btn primary" type="submit">Go</button>
        </form>
      {/if}
    </div>
    <button class="icon-btn" title="Next {stepName} (→)" aria-label="Next {stepName}" disabled={!engine} onclick={() => engine?.next()}>
      <Icon name="chevron-right" />
    </button>
  </footer>
  {/if}
</div>

{#if menuOpen}
  <div class="menu more-menu" role="menu">
    <button role="menuitem" disabled={!relocation?.page} onclick={openGoTo}>
      <Icon name="hash" size={15} /> <span>Go to {unit}…</span> <kbd>Ctrl+G</kbd>
    </button>
    <button role="menuitem" onclick={toggleFullscreen}>
      <Icon name={app.fullscreen ? 'minimize' : 'maximize'} size={15} />
      <span>{app.fullscreen ? 'Leave full screen' : 'Full screen'}</span> <kbd>F11</kbd>
    </button>
    <hr />
    <button
      role="menuitem"
      onclick={() => {
        menuOpen = false
        shortcutsOpen = true
      }}
    >
      <Icon name="keyboard" size={15} /> <span>Keyboard shortcuts</span> <kbd>?</kbd>
    </button>
  </div>
{/if}

{#if appearanceOpen}
  <div class="appearance" role="dialog" aria-label="Text and theme">
    <AppearancePanel reflowable={engine?.reflowable ?? true} pdf={book?.format === 'pdf'} />
  </div>
{/if}

{#if shortcutsOpen}
  <Shortcuts onclose={() => (shortcutsOpen = false)} />
{/if}

{#if popover?.kind === 'selection'}
  {@const info = popover.info}
  <Popover rect={info.rect}>
    <div class="selection-menu">
      <div class="mark-row">
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
        <button class="note-btn" title="Highlight and write a note" onclick={() => highlight('yellow', true)}>
          <Icon name="pencil" size={15} /> Add note
        </button>
      </div>
      <div class="actions">
        <button class="action" title="Copy the selected text" onclick={() => copy(info.text)}>
          <Icon name="copy" size={16} /> <span>Copy</span>
        </button>
        <button class="action" title="Look up in the dictionary" onclick={() => lookup('dictionary')}>
          <Icon name="dictionary" size={16} /> <span>Define</span>
        </button>
        <button class="action" title="Look up on Wikipedia" onclick={() => lookup('wikipedia')}>
          <Icon name="globe" size={16} /> <span>Wikipedia</span>
        </button>
        <button class="action" title="Translate in the browser" onclick={() => translate(info.text)}>
          <Icon name="translate" size={16} /> <span>Translate</span>
        </button>
        <button class="action" title="Find this text in the book" onclick={() => searchFor(info.text)}>
          <Icon name="search" size={16} /> <span>Find</span>
        </button>
        <button class="action" title="Read aloud from here" onclick={speakFromSelection}>
          <Icon name="volume" size={16} /> <span>Listen</span>
        </button>
      </div>
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
              aria-pressed={editing.color === color}
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
          <button
            class:selected={editing.style === item.style}
            aria-pressed={editing.style === item.style}
            onclick={() => setStyle({ style: item.style })}
          >
            {item.label}
          </button>
        {/each}
      </div>
      <textarea
        class="input"
        rows="3"
        placeholder="Add a note…"
        aria-label="Note"
        bind:this={noteInput}
        bind:value={noteDraft}
        onblur={flushNote}
        oninput={() => {
          clearTimeout(noteTimer)
          noteTimer = setTimeout(flushNote, 600)
        }}
      ></textarea>
      <p class="saved muted">Notes save as you type. Esc closes.</p>
    </div>
  </Popover>
{:else if popover?.kind === 'lookup'}
  <Popover rect={popover.rect}>
    <LookupView query={popover.query} language={popover.language} bind:mode={popover.mode} />
  </Popover>
{/if}

<style>
  .reader {
    position: relative;
    display: flex;
    flex-direction: column;
    height: 100%;
    background: var(--page-bg);
  }
  .toolbar {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, auto) minmax(0, 1fr);
    align-items: center;
    gap: 12px;
    height: 48px;
    padding: 0 8px;
    flex: none;
    border-bottom: 1px solid var(--border);
    background: var(--surface);
  }
  .group {
    display: flex;
    align-items: center;
    gap: 2px;
  }
  .group.end {
    justify-content: flex-end;
  }
  .lib-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 32px;
    padding: 0 10px 0 8px;
    border-radius: var(--radius-sm);
    font-weight: 500;
    flex: none;
  }
  .lib-btn:hover {
    background: var(--hover);
  }
  .title {
    display: flex;
    flex-direction: column;
    align-items: center;
    min-width: 0;
    line-height: 1.25;
    text-align: center;
  }
  .title h1 {
    max-width: 100%;
    font-size: inherit;
    font-weight: 600;
  }
  .chapter {
    max-width: 100%;
    font-size: 12px;
  }
  .body {
    flex: 1;
    min-height: 0;
    display: flex;
  }
  .side {
    position: relative;
    flex: none;
    min-width: 240px;
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
    background: color-mix(in srgb, var(--accent-strong) 45%, transparent);
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
    gap: 12px;
    text-align: center;
    padding: 24px;
    background: var(--page-bg);
  }
  .overlay h2 {
    font-size: 17px;
  }
  .overlay p {
    max-width: 520px;
    line-height: 1.5;
    user-select: text;
  }
  .overlay-actions {
    display: flex;
    gap: 8px;
    margin-top: 4px;
  }
  .spinner {
    width: 22px;
    height: 22px;
    border-radius: 50%;
    border: 2px solid var(--border);
    border-top-color: var(--accent-strong);
    animation: spin 0.8s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  .icon-btn.bookmarked {
    color: var(--bookmark);
  }
  .icon-btn.bookmarked :global(svg) {
    fill: currentColor;
  }
  .ribbon {
    position: absolute;
    top: 0;
    right: 14px;
    z-index: 4;
    color: var(--bookmark);
    filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.28));
    transform-origin: top;
    animation: ribbon-in 0.22s cubic-bezier(0.2, 0.9, 0.3, 1.2);
  }
  .ribbon svg {
    display: block;
    fill: currentColor;
  }
  .ribbon:hover {
    filter: drop-shadow(0 2px 3px rgb(0 0 0 / 0.28)) brightness(1.12);
  }
  @keyframes ribbon-in {
    from {
      transform: scaleY(0.2);
      opacity: 0;
    }
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
    opacity: 0.3;
    transition: opacity 0.15s;
  }
  .edge:hover {
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
    gap: 8px;
    height: 44px;
    padding: 0 8px;
    flex: none;
    border-top: 1px solid var(--border);
    background: var(--surface);
    font-size: 12.5px;
  }
  .history {
    display: flex;
    flex: none;
  }
  .sep {
    width: 1px;
    height: 18px;
    margin: 0 6px;
    background: var(--border);
  }
  .where {
    flex: 0 1 auto;
    min-width: 0;
    padding: 0 6px 0 4px;
  }
  .preview {
    position: absolute;
    /* follows the pointer, but stays within the bar */
    left: clamp(150px, calc(8px + (100% - 16px) * var(--at)), calc(100% - 150px));
    bottom: calc(100% + 6px);
    transform: translateX(-50%);
    z-index: 40;
    max-width: 300px;
    padding: 4px 9px;
    border-radius: var(--radius-sm);
    background: var(--fg);
    color: var(--bg);
    font-size: 12px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    pointer-events: none;
  }
  .track {
    position: relative;
    flex: 1;
    min-width: 90px;
    height: 28px;
    display: flex;
    align-items: center;
  }
  .slider {
    width: 100%;
    margin: 0;
  }
  /* Marks sit where the middle of the 16px thumb would be at that value. */
  .mark {
    position: absolute;
    left: calc(8px + (100% - 16px) * var(--at));
    top: 50%;
    width: 1px;
    height: 8px;
    margin: -4px 0 0 -0.5px;
    background: var(--fg-muted);
    opacity: 0.4;
    pointer-events: none;
  }
  .mark.bookmark {
    top: 0;
    width: 8px;
    height: 11px;
    margin: 0 0 0 -4px;
    background: var(--bookmark);
    opacity: 1;
    pointer-events: auto;
    clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 70%, 0 100%);
  }
  .mark.bookmark:hover {
    filter: brightness(1.2);
  }
  .position-wrap {
    position: relative;
    flex: none;
  }
  .position {
    display: flex;
    align-items: center;
    gap: 8px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    white-space: nowrap;
    font-variant-numeric: tabular-nums;
  }
  .position:hover:not(:disabled) {
    background: var(--hover);
  }
  .position:disabled {
    opacity: 1;
  }
  .percent {
    color: var(--fg-muted);
  }
  .goto {
    position: absolute;
    right: 0;
    bottom: calc(100% + 10px);
    z-index: 40;
    display: flex;
    align-items: center;
    gap: 8px;
    padding: 10px 12px;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
    font-size: 13px;
    white-space: nowrap;
  }
  .goto label {
    font-weight: 600;
  }
  .goto input {
    width: 84px;
  }

  /* In full screen the bars slide away and come back under the pointer. */
  .reader.fullscreen .toolbar,
  .reader.fullscreen .status {
    position: absolute;
    left: 0;
    right: 0;
    z-index: 30;
    opacity: 0;
    transition:
      opacity 0.15s,
      transform 0.15s;
  }
  .reader.fullscreen .toolbar {
    top: 0;
    transform: translateY(calc(-100% + 12px));
  }
  .reader.fullscreen .status {
    bottom: 0;
    transform: translateY(calc(100% - 12px));
  }
  .reader.fullscreen .toolbar:is(:hover, :focus-within, .pinned),
  .reader.fullscreen .status:is(:hover, :focus-within) {
    opacity: 1;
    transform: none;
  }

  .more-menu {
    top: 50px;
    right: 8px;
    min-width: 230px;
  }
  .more-menu span {
    flex: 1;
  }
  .appearance {
    position: fixed;
    top: 52px;
    right: 8px;
    z-index: 50;
    border-radius: var(--radius);
    border: 1px solid var(--border);
    background: var(--surface);
    box-shadow: var(--shadow-lg);
  }


  /* Docked above the bottom bar, so it never covers the sentence being read. */
  .speech {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 4px;
    flex: none;
    padding: 5px 10px;
    border-top: 1px solid var(--border);
    background: var(--surface);
  }
  .stop {
    height: 28px;
    margin-left: 6px;
    padding: 0 10px;
    font-size: 12.5px;
  }
  .saved {
    margin-top: -2px;
    font-size: 11.5px;
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
    flex-direction: column;
    padding: 6px;
    gap: 4px;
  }
  .mark-row {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    padding: 2px 2px 6px 4px;
    border-bottom: 1px solid var(--border);
  }
  .note-btn {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    height: 28px;
    padding: 0 8px;
    border-radius: var(--radius-sm);
    font-size: 12.5px;
  }
  .note-btn:hover {
    background: var(--hover);
  }
  .actions {
    display: flex;
  }
  .action {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 3px;
    min-width: 58px;
    padding: 6px 4px 5px;
    border-radius: var(--radius-sm);
    font-size: 11px;
    color: var(--fg);
  }
  .action:hover {
    background: var(--hover);
  }
  .colors {
    display: flex;
    align-items: center;
    gap: 7px;
  }
  .dot {
    width: 22px;
    height: 22px;
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
    height: 28px;
    font-size: 12px;
  }
  .styles button + button {
    border-left: 1px solid var(--border);
  }
  .styles button.selected {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  textarea {
    width: 100%;
  }

  @media (max-width: 760px) {
    .lib-btn span,
    .where,
    .history {
      display: none;
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .ribbon,
    .spinner {
      animation: none;
    }
    .reader.fullscreen .toolbar,
    .reader.fullscreen .status {
      transition: none;
    }
  }
</style>
