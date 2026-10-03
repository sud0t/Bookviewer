<script lang="ts">
  import Library from './Library/Library.svelte'
  import Reader from './Reader/Reader.svelte'
  import Icon from './lib/Icon.svelte'
  import { app, dismissToast, initApp, openBook, refreshLibrary, runToastAction, theme, toast } from './lib/app.svelte'
  import { ipc } from './lib/ipc'

  $effect(() => {
    document.documentElement.dataset.theme = theme()
  })

  void initApp()

  // A folder (or a book file) dragged in from the file manager.
  let dropping = $state(false)
  let dropTimer: ReturnType<typeof setTimeout> | undefined
  const carriesFiles = (event: DragEvent) => !!event.dataTransfer?.types.includes('Files')

  function onDragover(event: DragEvent) {
    if (!carriesFiles(event)) return
    event.preventDefault()
    event.dataTransfer!.dropEffect = 'copy'
    dropping = true
    // (dragover repeats while the pointer is over the window; when it stops, it has left)
    clearTimeout(dropTimer)
    dropTimer = setTimeout(() => (dropping = false), 200)
  }

  async function onDrop(event: DragEvent) {
    if (!carriesFiles(event)) return
    event.preventDefault()
    dropping = false
    const paths = [...(event.dataTransfer?.files ?? [])].map(file => ipc.pathForFile(file)).filter(Boolean)
    if (!paths.length) return
    const before = app.folders.length
    try {
      const book = await ipc.invoke('library:openPaths', paths)
      await refreshLibrary()
      if (book != null) openBook(book)
      else if (app.folders.length > before) toast('Added to the library')
      else toast('Nothing new to add: that is already in the library, or not a book BookViewer reads')
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error')
    }
  }
</script>

<svelte:window ondragover={onDragover} ondrop={onDrop} />

{#if dropping}
  <div class="drop" aria-hidden="true">
    <div><Icon name="folder-plus" size={28} /> Drop a folder or a book to add it to the library</div>
  </div>
{/if}

{#if app.ready}
  <!-- The library stays mounted behind the reader so it keeps its scroll position. -->
  <div class="view" hidden={app.view !== 'library'}>
    <Library />
  </div>
  {#if app.view === 'reader' && app.bookId != null}
    {#key app.bookId}
      <div class="view">
        <Reader bookId={app.bookId} />
      </div>
    {/key}
  {/if}
{/if}

{#if app.toast}
  <div class="toast" class:error={app.toast.kind === 'error'} role="status">
    <span class="toast-message">{app.toast.message}</span>
    {#if app.toast.action}
      <button class="toast-action" onclick={runToastAction}>{app.toast.action.label}</button>
    {/if}
    <button class="toast-close" aria-label="Dismiss" onclick={dismissToast}>
      <Icon name="x" size={14} />
    </button>
  </div>
{/if}

<style>
  .view {
    height: 100%;
  }
  .view[hidden] {
    display: none;
  }
  .drop {
    position: fixed;
    inset: 8px;
    z-index: 300;
    display: grid;
    place-items: center;
    pointer-events: none;
    border: 2px dashed var(--accent);
    border-radius: var(--radius);
    background: color-mix(in srgb, var(--bg) 82%, transparent);
  }
  .drop div {
    display: flex;
    align-items: center;
    gap: 12px;
    font-size: 17px;
    font-weight: 600;
  }
  .toast {
    position: fixed;
    left: 50%;
    /* the reader raises this above its bottom bar (and its read-aloud bar) */
    bottom: var(--toast-bottom, 28px);
    transform: translateX(-50%);
    z-index: 200;
    display: flex;
    align-items: center;
    gap: 12px;
    max-width: min(560px, 90vw);
    padding: 8px 8px 8px 16px;
    user-select: text;
    border-radius: var(--radius);
    background: var(--fg);
    color: var(--bg);
    box-shadow: var(--shadow-lg);
    animation: toast-in 0.16s ease-out;
  }
  @keyframes toast-in {
    from {
      opacity: 0;
      transform: translate(-50%, 6px);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .toast {
      animation: none;
    }
  }
  .toast-message {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .toast-close {
    flex: none;
    display: flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
    border-radius: var(--radius-sm);
    color: inherit;
    opacity: 0.7;
  }
  .toast-close:hover {
    opacity: 1;
    background: color-mix(in srgb, currentColor 16%, transparent);
  }
  .toast-action {
    flex: none;
    padding: 4px 10px;
    border-radius: var(--radius-sm);
    font-weight: 600;
    color: inherit;
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .toast-action:hover {
    background: color-mix(in srgb, currentColor 16%, transparent);
  }
  .toast.error {
    background: #a8291f;
    color: #fff;
  }
</style>
