<script lang="ts">
  import type { Settings } from '@shared/types'
  import Icon from '../lib/Icon.svelte'
  import ThemePicker from '../lib/ThemePicker.svelte'
  import { app, updateSettings } from '../lib/app.svelte'

  let { reflowable, pdf }: { reflowable: boolean; pdf: boolean } = $props()

  const settings = $derived(app.settings)
  const FONTS = [
    { value: '', label: 'Book’s own' },
    { value: 'serif', label: 'Serif' },
    { value: 'sans-serif', label: 'Sans' },
    { value: 'monospace', label: 'Mono' },
  ]
  const typeface = $derived(settings.publisherStyles ? '' : settings.fontFamily)
  const isPreset = $derived(FONTS.some(font => font.value === typeface))

  // The fonts installed on this computer, for the "other typeface" list.
  let installed = $state<string[]>([])
  const queryFonts = (window as { queryLocalFonts?: () => Promise<{ family: string }[]> }).queryLocalFonts
  if (queryFonts)
    void queryFonts
      .call(window)
      .then(fonts => {
        installed = [...new Set(fonts.map(font => font.family))].sort((a, b) => a.localeCompare(b))
      })
      .catch(() => {})

  function setTypeface(value: string) {
    if (!value) updateSettings({ publisherStyles: true })
    else updateSettings({ publisherStyles: false, fontFamily: value })
  }

  const step = (key: 'fontSize', delta: number, min: number, max: number) =>
    updateSettings({ [key]: Math.min(max, Math.max(min, settings[key] + delta)) })

  const ZOOMS: { value: Settings['pdfZoom']; label: string }[] = [
    { value: 'auto', label: 'Automatic' },
    { value: 'page-width', label: 'Fit width' },
    { value: 'page-fit', label: 'Fit page' },
    { value: 0.75, label: '75%' },
    { value: 1, label: '100%' },
    { value: 1.25, label: '125%' },
    { value: 1.5, label: '150%' },
    { value: 2, label: '200%' },
  ]
</script>

<div class="panel">
  <section>
    <h2>Theme</h2>
    <ThemePicker />
  </section>

  {#if pdf}
    <section>
      <h2>Zoom</h2>
      <select
        class="input"
        value={String(settings.pdfZoom)}
        onchange={event => {
          const raw = event.currentTarget.value
          updateSettings({ pdfZoom: isNaN(Number(raw)) ? (raw as Settings['pdfZoom']) : Number(raw) })
        }}
      >
        {#each ZOOMS as zoom (zoom.value)}
          <option value={String(zoom.value)}>{zoom.label}</option>
        {/each}
        {#if typeof settings.pdfZoom === 'number' && !ZOOMS.some(zoom => zoom.value === settings.pdfZoom)}
          <option value={String(settings.pdfZoom)}>{Math.round(settings.pdfZoom * 100)}%</option>
        {/if}
      </select>
    </section>
    <label class="check">
      <input
        type="checkbox"
        checked={settings.pdfThemed}
        onchange={event => updateSettings({ pdfThemed: event.currentTarget.checked })}
      />
      Recolor pages to match the theme
    </label>
  {:else}
    <section>
      <h2>Layout</h2>
      <div class="segmented">
        <button class:selected={settings.flow === 'scrolled'} onclick={() => updateSettings({ flow: 'scrolled' })}>
          <Icon name="scroll" size={15} /> Scrolled
        </button>
        <button class:selected={settings.flow === 'paginated'} onclick={() => updateSettings({ flow: 'paginated' })}>
          <Icon name="columns" size={15} /> Paginated
        </button>
      </div>
    </section>

    {#if reflowable}
      <section>
        <h2>Typeface</h2>
        <div class="segmented">
          {#each FONTS as font (font.value)}
            <button class:selected={typeface === font.value} onclick={() => setTypeface(font.value)}>
              {font.label}
            </button>
          {/each}
        </div>
      </section>

      {#if installed.length}
        <select
          class="input"
          aria-label="Other typeface"
          value={isPreset ? '' : typeface}
          onchange={event => event.currentTarget.value && setTypeface(event.currentTarget.value)}
        >
          <option value="">Other typeface…</option>
          {#each installed as family (family)}
            <option value={family}>{family}</option>
          {/each}
        </select>
      {/if}

      {#if settings.publisherStyles}
        <p class="hint muted">Fonts, spacing and alignment follow the book’s own design.</p>
      {/if}

      <section class="row">
        <h2>Text size</h2>
        <div class="stepper">
          <button class="icon-btn" aria-label="Smaller text" onclick={() => step('fontSize', -1, 10, 40)}>
            <Icon name="minus" size={15} />
          </button>
          <span>{settings.fontSize}</span>
          <button class="icon-btn" aria-label="Larger text" onclick={() => step('fontSize', 1, 10, 40)}>
            <Icon name="plus" size={15} />
          </button>
        </div>
      </section>

      <section>
        <h2>Line spacing <span class="value">{settings.lineHeight.toFixed(2)}</span></h2>
        <input
          type="range"
          min="1.1"
          max="2.4"
          step="0.05"
          disabled={settings.publisherStyles}
          aria-label="Line spacing"
          style:--fill="{((settings.lineHeight - 1.1) / 1.3) * 100}%"
          value={settings.lineHeight}
          oninput={event => updateSettings({ lineHeight: Number(event.currentTarget.value) })}
        />
      </section>

      <section>
        <h2>Column width <span class="value">{settings.maxWidth}</span></h2>
        <input
          type="range"
          min="420"
          max="1400"
          step="20"
          aria-label="Column width"
          style:--fill="{((settings.maxWidth - 420) / 980) * 100}%"
          value={settings.maxWidth}
          oninput={event => updateSettings({ maxWidth: Number(event.currentTarget.value) })}
        />
      </section>

      <div class="checks">
        <label class="check">
          <input
            type="checkbox"
            disabled={settings.publisherStyles}
            checked={settings.justify}
            onchange={event => updateSettings({ justify: event.currentTarget.checked })}
          />
          Justify
        </label>
        <label class="check">
          <input
            type="checkbox"
            disabled={settings.publisherStyles}
            checked={settings.hyphenate}
            onchange={event => updateSettings({ hyphenate: event.currentTarget.checked })}
          />
          Hyphenate
        </label>
        <label class="check" title="Typeset TeX formulas such as \( x^2 \) that the book left as source">
          <input
            type="checkbox"
            checked={settings.renderMath}
            onchange={event => updateSettings({ renderMath: event.currentTarget.checked })}
          />
          Render math
        </label>
        {#if settings.flow === 'paginated'}
          <label class="check">
            <input
              type="checkbox"
              checked={settings.maxColumns > 1}
              onchange={event => updateSettings({ maxColumns: event.currentTarget.checked ? 2 : 1 })}
            />
            Two pages
          </label>
        {/if}
      </div>
    {/if}
  {/if}
</div>

<style>
  .panel {
    width: 300px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 14px;
  }
  h2 {
    margin: 0 0 6px;
    font-size: 12px;
    font-weight: 600;
    color: var(--fg-muted);
    display: flex;
    justify-content: space-between;
  }
  .value {
    font-weight: 400;
  }
  .hint {
    margin: -6px 0 0;
    font-size: 12px;
    line-height: 1.4;
  }
  .segmented {
    display: flex;
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    overflow: hidden;
  }
  .segmented button {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    height: 30px;
    font-size: 13px;
  }
  .segmented button + button {
    border-left: 1px solid var(--border);
  }
  .segmented button.selected {
    background: var(--accent-soft);
    color: var(--accent);
    font-weight: 600;
  }
  .row {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }
  .row h2 {
    margin: 0;
  }
  .stepper {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  .stepper span {
    min-width: 44px;
    text-align: center;
  }
  input[type='range'] {
    width: 100%;
  }
  .checks {
    display: flex;
    flex-wrap: wrap;
    gap: 6px 16px;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 6px;
  }
  select {
    width: 100%;
  }
</style>
