<script lang="ts">
  import Icon from '../lib/Icon.svelte'
  import type { TocItem } from '../engines/types'
  import TocTree from './TocTree.svelte'

  let {
    items,
    current,
    depth = 0,
    onselect,
  }: {
    items: TocItem[]
    current: string | null
    depth?: number
    onselect: (item: TocItem) => void
  } = $props()

  let collapsed = $state<Record<string, boolean>>({})

  const contains = (item: TocItem, id: string | null): boolean =>
    id != null && (item.id === id || item.children.some(child => contains(child, id)))

  // Deeper levels start folded, except along the path to where we are.
  const isOpen = (item: TocItem): boolean =>
    collapsed[item.id] != null ? !collapsed[item.id] : depth < 1 || contains(item, current)
</script>

<ul class:root={depth === 0}>
  {#each items as item (item.id)}
    <li>
      <div class="row" class:current={item.id === current} style:padding-left="{depth * 14 + 4}px">
        {#if item.children.length}
          <button
            class="twisty"
            aria-label={isOpen(item) ? 'Collapse' : 'Expand'}
            onclick={() => (collapsed[item.id] = isOpen(item))}
          >
            <Icon name={isOpen(item) ? 'chevron-down' : 'chevron-right'} size={14} />
          </button>
        {:else}
          <span class="twisty"></span>
        {/if}
        <button
          class="label"
          disabled={!item.target && !item.children.length}
          aria-current={item.id === current ? 'location' : undefined}
          onclick={() => (item.target ? onselect(item) : (collapsed[item.id] = isOpen(item)))}
        >
          {item.label}
        </button>
      </div>
      {#if item.children.length && isOpen(item)}
        <TocTree items={item.children} {current} depth={depth + 1} {onselect} />
      {/if}
    </li>
  {/each}
</ul>

<style>
  ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .row {
    display: flex;
    align-items: flex-start;
    border-radius: var(--radius-sm);
  }
  .row:hover {
    background: var(--hover);
  }
  .row.current {
    background: var(--active);
    font-weight: 600;
  }
  .twisty {
    flex: none;
    width: 20px;
    height: 28px;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    color: var(--fg-muted);
  }
  .label {
    flex: 1;
    min-width: 0;
    padding: 5px 6px 5px 2px;
    text-align: left;
    line-height: 1.3;
    overflow-wrap: anywhere;
  }
  .label:disabled {
    opacity: 1;
    color: var(--fg-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.05em;
    text-transform: uppercase;
  }
</style>
