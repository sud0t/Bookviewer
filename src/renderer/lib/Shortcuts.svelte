<script lang="ts">
  import Dialog from './Dialog.svelte'

  let { onclose }: { onclose: () => void } = $props()

  const GROUPS: { title: string; keys: [string[], string][] }[] = [
    {
      title: 'Moving through a book',
      keys: [
        [['→', 'Space', 'Page Down'], 'Next page'],
        [['←', 'Shift+Space', 'Page Up'], 'Previous page'],
        [['↓', '↑', 'J', 'K'], 'Scroll a little'],
        [['Home', 'End'], 'Start or end of the book'],
        [['Ctrl+G'], 'Go to a page'],
        [['Alt+←', 'Alt+→'], 'Back and forward after a jump; back to the library'],
      ],
    },
    {
      title: 'Finding and keeping your place',
      keys: [
        [['T'], 'Contents, highlights and bookmarks'],
        [['Ctrl+F', '/'], 'Search (in the book, or the library)'],
        [['Enter', 'Shift+Enter'], 'Next or previous search result'],
        [['Ctrl+D'], 'Bookmark this page, or remove its bookmark'],
        [['Ctrl+Z'], 'Undo, while a notice offers it'],
      ],
    },
    {
      title: 'View',
      keys: [
        [['Ctrl++', 'Ctrl+−', 'Ctrl+0'], 'Larger or smaller text; zoom in a PDF'],
        [['F11'], 'Full screen'],
        [['Esc'], 'Close whatever is open'],
        [['?'], 'This list'],
      ],
    },
  ]
</script>

<Dialog title="Keyboard shortcuts" {onclose}>
  {#each GROUPS as group (group.title)}
    <section>
      <h3>{group.title}</h3>
      <dl>
        {#each group.keys as [keys, what] (what)}
          <div>
            <dt>{what}</dt>
            <dd>
              {#each keys as key (key)}<kbd>{key}</kbd>{/each}
            </dd>
          </div>
        {/each}
      </dl>
    </section>
  {/each}
</Dialog>

<style>
  h3 {
    margin: 12px 0 4px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-muted);
  }
  section:first-child h3 {
    margin-top: 0;
  }
  dl {
    margin: 0;
  }
  dl div {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 16px;
    padding: 6px 0;
    border-top: 1px solid var(--border);
  }
  dd {
    margin: 0;
    display: flex;
    gap: 4px;
    flex: none;
  }
</style>
