<script lang="ts">
  import type { ThemeName } from '@shared/types'
  import { PALETTES } from '../engines/appearance'
  import { app, updateSettings } from './app.svelte'

  const THEMES: { name: ThemeName; label: string }[] = [
    { name: 'light', label: 'Light' },
    { name: 'sepia', label: 'Sepia' },
    { name: 'gray', label: 'Gray' },
    { name: 'dark', label: 'Dark' },
    { name: 'black', label: 'Black' },
  ]
  const settings = $derived(app.settings)
</script>

<div class="themes" role="group" aria-label="Theme">
  <button
    class="choice"
    aria-pressed={settings.themeAuto}
    title="Light or dark, following the system"
    onclick={() => updateSettings({ themeAuto: true })}
  >
    <span class="swatch auto" aria-hidden="true"></span>
    <span>Auto</span>
  </button>
  {#each THEMES as theme (theme.name)}
    <button
      class="choice"
      aria-pressed={!settings.themeAuto && settings.theme === theme.name}
      onclick={() => updateSettings({ themeAuto: false, theme: theme.name })}
    >
      <span
        class="swatch"
        aria-hidden="true"
        style:background={PALETTES[theme.name].bg}
        style:color={PALETTES[theme.name].fg}
      >
        Aa
      </span>
      <span>{theme.label}</span>
    </button>
  {/each}
</div>

<style>
  .themes {
    display: grid;
    grid-template-columns: repeat(6, 1fr);
    gap: 6px;
  }
  .choice {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
    min-width: 0;
    font-size: 11px;
    color: var(--fg-muted);
  }
  .swatch {
    display: flex;
    align-items: center;
    justify-content: center;
    width: 100%;
    height: 34px;
    border-radius: var(--radius-sm);
    border: 1px solid var(--border);
    font-family: 'Literata Variable', Georgia, serif;
    font-size: 14px;
  }
  .swatch.auto {
    background: linear-gradient(115deg, #ffffff 50%, #1c1b1a 50%);
  }
  .choice[aria-pressed='true'] {
    color: var(--fg);
    font-weight: 600;
  }
  .choice[aria-pressed='true'] .swatch {
    outline: 2px solid var(--accent-strong);
    outline-offset: 1px;
  }
</style>
