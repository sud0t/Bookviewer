<script lang="ts">
  import type { DictionaryEntry, WikipediaSummary } from '@shared/types'
  import Icon from '../lib/Icon.svelte'
  import { ipc } from '../lib/ipc'

  let {
    query,
    language,
    mode = $bindable(),
  }: {
    query: string
    language: string
    mode: 'dictionary' | 'wikipedia'
  } = $props()

  type Result =
    | { state: 'loading' }
    | { state: 'empty' }
    | { state: 'dictionary'; entries: DictionaryEntry[] }
    | { state: 'wikipedia'; summary: WikipediaSummary }

  let result = $state<Result>({ state: 'loading' })

  $effect(() => {
    const current = { query, language, mode }
    let stale = false
    result = { state: 'loading' }
    const request =
      current.mode === 'dictionary'
        ? ipc
            .invoke('lookup:dictionary', current.query, current.language)
            .then((entries): Result => (entries.length ? { state: 'dictionary', entries } : { state: 'empty' }))
        : ipc
            .invoke('lookup:wikipedia', current.query, current.language)
            .then((summary): Result => (summary ? { state: 'wikipedia', summary } : { state: 'empty' }))
    request
      .catch((): Result => ({ state: 'empty' }))
      .then(value => {
        if (!stale) result = value
      })
    return () => {
      stale = true
    }
  })
</script>

<div class="lookup">
  <div class="tabs" role="tablist">
    <button role="tab" aria-selected={mode === 'dictionary'} class:active={mode === 'dictionary'} onclick={() => (mode = 'dictionary')}>
      <Icon name="dictionary" size={14} /> Dictionary
    </button>
    <button role="tab" aria-selected={mode === 'wikipedia'} class:active={mode === 'wikipedia'} onclick={() => (mode = 'wikipedia')}>
      <Icon name="globe" size={14} /> Wikipedia
    </button>
  </div>

  <div class="body scroll">
    {#if result.state === 'loading'}
      <p class="muted">Looking up “{query}”…</p>
    {:else if result.state === 'empty'}
      <p class="muted">
        Nothing found for “{query}”{mode === 'dictionary' ? ' in the dictionary' : ' on Wikipedia'}.
      </p>
    {:else if result.state === 'dictionary'}
      {#each result.entries as entry, i (i)}
        <h3>
          {entry.word}
          {#if entry.phonetic}<span class="phonetic muted">{entry.phonetic}</span>{/if}
        </h3>
        {#if entry.text}<p class="article">{entry.text}</p>{/if}
        {#each entry.meanings as meaning, j (j)}
          {#if meaning.partOfSpeech}<div class="pos">{meaning.partOfSpeech}</div>{/if}
          <ol>
            {#each meaning.definitions as definition, k (k)}
              <li>
                {definition.definition}
                {#if definition.example}<div class="example muted">“{definition.example}”</div>{/if}
              </li>
            {/each}
          </ol>
        {/each}
      {/each}
      <div class="source muted">Source: {[...new Set(result.entries.map(entry => entry.source))].join(', ')}</div>
    {:else}
      {@const summary = result.summary}
      <div class="wiki">
        {#if summary.thumbnail}
          <img src={summary.thumbnail} alt="" />
        {/if}
        <h3>{summary.title}</h3>
        {#if summary.description}<div class="pos">{summary.description}</div>{/if}
        <p>{summary.extract}</p>
      </div>
      <button class="link" onclick={() => ipc.invoke('shell:openExternal', summary.url)}>
        Read on Wikipedia <Icon name="external" size={13} />
      </button>
    {/if}
  </div>
</div>

<style>
  .lookup {
    width: 400px;
    max-width: 100%;
    user-select: text;
  }
  .tabs {
    display: flex;
    gap: 2px;
    padding: 6px 6px 0;
    border-bottom: 1px solid var(--border);
  }
  .tabs button {
    display: flex;
    align-items: center;
    gap: 6px;
    padding: 6px 10px;
    border-radius: var(--radius-sm) var(--radius-sm) 0 0;
    color: var(--fg-muted);
    border-bottom: 2px solid transparent;
  }
  .tabs button.active {
    color: var(--fg);
    border-bottom-color: var(--accent);
    font-weight: 600;
  }
  .body {
    max-height: 320px;
    padding: 12px 14px;
    line-height: 1.5;
  }
  h3 {
    font-size: 16px;
    margin-bottom: 2px;
  }
  .phonetic {
    font-weight: 400;
    font-size: 13px;
    margin-left: 6px;
  }
  .pos {
    font-style: italic;
    color: var(--fg-muted);
    margin: 6px 0 2px;
  }
  ol {
    margin: 0 0 8px;
    padding-left: 20px;
  }
  li {
    margin-bottom: 4px;
  }
  .article {
    margin: 4px 0 10px;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .example {
    font-size: 13px;
  }
  .source {
    font-size: 11px;
    margin-top: 8px;
  }
  .wiki img {
    float: right;
    max-width: 110px;
    max-height: 130px;
    margin: 0 0 8px 12px;
    border-radius: 4px;
  }
  .wiki p {
    margin-top: 6px;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 5px;
    margin-top: 10px;
    color: var(--accent);
    clear: both;
  }
  .link:hover {
    text-decoration: underline;
  }
</style>
