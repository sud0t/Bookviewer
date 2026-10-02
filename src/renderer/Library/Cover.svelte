<script lang="ts">
  import { coverUrl, type Book } from '@shared/types'

  let {
    book,
    /** Small covers (lists) show the colour alone; the title would not fit. */
    bare = false,
  }: {
    book: Book
    bare?: boolean
  } = $props()

  const cover = $derived(coverUrl(book))
  // A stable colour per title for books that have no cover image.
  const hue = $derived(
    [...book.title].reduce((hash, char) => (hash * 31 + char.charCodeAt(0)) % 360, 7),
  )
</script>

{#if cover}
  <img src={cover} alt="" loading="lazy" draggable="false" />
{:else}
  <div class="placeholder" style:--hue={hue}>
    {#if !bare}
      <span class="placeholder-title">{book.title}</span>
      {#if book.author}<span class="placeholder-author">{book.author}</span>{/if}
    {/if}
  </div>
{/if}

<style>
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
    font-family: 'Literata Variable', 'Literata', Georgia, 'Times New Roman', serif;
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
</style>
