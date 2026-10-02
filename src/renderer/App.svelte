<script lang="ts">
  import Library from './Library/Library.svelte'
  import Reader from './Reader/Reader.svelte'
  import { app, initApp, theme } from './lib/app.svelte'

  $effect(() => {
    document.documentElement.dataset.theme = theme()
  })

  void initApp()
</script>

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
  <div class="toast" class:error={app.toast.kind === 'error'} role="status">{app.toast.message}</div>
{/if}

<style>
  .view {
    height: 100%;
  }
  .view[hidden] {
    display: none;
  }
  .toast {
    position: fixed;
    left: 50%;
    bottom: 28px;
    transform: translateX(-50%);
    z-index: 200;
    max-width: min(560px, 90vw);
    padding: 9px 16px;
    border-radius: var(--radius);
    background: var(--fg);
    color: var(--bg);
    box-shadow: var(--shadow-lg);
  }
  .toast.error {
    background: var(--danger);
    color: #fff;
  }
</style>
