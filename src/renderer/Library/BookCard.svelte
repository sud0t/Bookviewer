<script lang="ts">
  import { coverUrl, type Book } from '@shared/types'
  import { FORMAT_LABELS } from './formats'

  let {
    book,
    list = false,
    onopen,
    onmenu,
  }: {
    book: Book
    list?: boolean
    onopen: (book: Book) => void
    onmenu: (book: Book, event: MouseEvent) => void
  } = $props()

  const cover = $derived(coverUrl(book))
  // A stable colour per title for books that have no cover image.
  const hue = $derived(
    [...book.title].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 7),
  )
  const percent = $derived(Math.round(book.progress * 100))
</script>

<button
  class="card"
  class:list
  title={book.title}
  onclick={() => onopen(book)}
  oncontextmenu={event => {
    event.preventDefault()
    onmenu(book, event)
  }}
>
  <div class="cover">
    {#if cover}
      <img src={cover} alt="" loading="lazy" draggable="false" />
    {:else}
      <div class="placeholder" style:--hue={hue}>
        <span class="placeholder-title">{book.title}</span>
        {#if book.author}<span class="placeholder-author">{book.author}</span>{/if}
      </div>
    {/if}
    <span class="badge">{FORMAT_LABELS[book.format]}</span>
    {#if book.progress > 0}
      <div class="progress" aria-hidden="true"><div style:width="{percent}%"></div></div>
    {/if}
  </div>
  <div class="text">
    <div class="title">{book.title}</div>
    <div class="author muted">{book.author || ' '}</div>
    {#if list}
      <div class="meta muted">
        {FORMAT_LABELS[book.format]}{book.progress > 0 ? ` · ${percent}% read` : ''}
      </div>
    {/if}
  </div>
</button>

<style>
  .card {
    display: flex;
    flex-direction: column;
    gap: 8px;
    text-align: left;
    border-radius: var(--radius);
    padding: 8px;
    min-width: 0;
  }
  .card:hover {
    background: var(--hover);
  }
  .cover {
    position: relative;
    aspect-ratio: 2 / 3;
    border-radius: 4px;
    overflow: hidden;
    background: var(--surface-2);
    box-shadow: var(--shadow);
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    display: block;
  }
  .placeholder {
    height: 100%;
    display: flex;
    flex-direction: column;
    justify-content: space-between;
    gap: 8px;
    padding: 14% 10% 12%;
    color: #fff;
    background: linear-gradient(
      160deg,
      hsl(var(--hue) 38% 42%),
      hsl(calc(var(--hue) + 30) 42% 26%)
    );
  }
  .placeholder-title {
    font-family: Georgia, 'Times New Roman', serif;
    font-size: 15px;
    line-height: 1.25;
    font-weight: 600;
    display: -webkit-box;
    -webkit-line-clamp: 6;
    line-clamp: 6;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .placeholder-author {
    font-size: 11px;
    opacity: 0.85;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
  }
  .badge {
    position: absolute;
    top: 6px;
    right: 6px;
    padding: 1px 6px;
    border-radius: 3px;
    font-size: 10px;
    font-weight: 600;
    letter-spacing: 0.04em;
    color: #fff;
    background: rgb(0 0 0 / 0.55);
    backdrop-filter: blur(4px);
  }
  .progress {
    position: absolute;
    left: 0;
    right: 0;
    bottom: 0;
    height: 4px;
    background: rgb(0 0 0 / 0.35);
  }
  .progress div {
    height: 100%;
    background: var(--accent);
  }
  .text {
    min-width: 0;
  }
  .title {
    font-weight: 600;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
    overflow: hidden;
    overflow-wrap: anywhere;
  }
  .author {
    font-size: 12px;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .card.list {
    flex-direction: row;
    align-items: center;
    gap: 14px;
    padding: 6px 10px;
  }
  .card.list .cover {
    width: 44px;
    flex: none;
  }
  .card.list .badge,
  .card.list .placeholder span {
    display: none;
  }
  .card.list .text {
    flex: 1;
    display: grid;
    grid-template-columns: minmax(0, 3fr) minmax(0, 2fr) 140px;
    gap: 16px;
    align-items: center;
  }
  .card.list .title {
    -webkit-line-clamp: 1;
    line-clamp: 1;
  }
  .card.list .author {
    font-size: 13px;
  }
  .meta {
    font-size: 12px;
    text-align: right;
  }
</style>
