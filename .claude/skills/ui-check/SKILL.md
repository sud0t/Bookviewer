---
name: ui-check
description: Look at BookViewer's real UI after changing it. Drives the built Electron app headlessly, screenshots every screen in light and dark themes, and runs an accessibility check. Use after any change to src/renderer (layout, styles, controls, wording) and before calling UI work done.
license: Adapted from the webapp-testing skill (Apache 2.0, see LICENSE.txt)
---

# Checking BookViewer's UI

This is the webapp-testing skill's "reconnaissance, then action" method, adapted
to this app. BookViewer is an Electron app, so the Python Playwright scripts that
skill describes do not apply: Electron is driven from Node with
`scripts/drive.mjs`, which the repo already has.

## The loop

1. Build: `npm run build` (the driver runs what is in `out/`, not the source).
2. Tour: `PROFILE=.scratch/tour node scripts/drive.mjs scripts/scenarios/ui-tour.mjs`
   - Screenshots land in `.scratch/shots/tour-<theme>-<screen>.png`:
     library grid and list, reader, each side-panel tab, the appearance panel,
     paginated mode.
   - `THEMES=light,sepia,gray,dark,black` picks themes (default `light,dark`).
   - `AXE=1` also runs axe-core on every screen and prints violations
     (contrast, controls without names, bad roles).
   - A folder of books can be given as the last argument; the default is `~/Books`.
3. Look at the screenshots with the Read tool. A picture is the evidence; a
   passing typecheck is not. Check both themes, and compare against the shots
   from before the change.
4. For a state the tour does not reach, write a scenario: copy
   `scripts/scenarios/open-book.mjs`, whose header lists the traps.

## Traps

- Native dialogs block forever when headless. Add folders with
  `window.bridge.invoke('folders:addPath', path)`, never the "Add folder" button.
- Book text lives in sandboxed iframes inside the `<bv-scroller>` shadow root
  (scrolled mode) or foliate's paginator. Reach it with `page.evaluate` through
  `iframe.contentDocument`, not frame locators.
- No real mouse drags: select text with click, then shift-click (`drag()` in the
  scenario arguments does this).
- Wait for what you need (`waitForSelector`, a short `waitForTimeout` after
  scrolling) before reading state or taking a shot; relocation is debounced.
- The driver uses its own profile under `.scratch/`, so the real library in
  `~/.config/BookViewer` is never touched. `~/Books` is read-only test material.
- Prefer selecting controls by role and accessible name; it keeps scenarios
  working when class names change and proves the names exist.

## What to check on every UI change

- Every icon-only button has a visible state when on, a tooltip and an
  accessible name; the most used actions are reachable without opening a menu.
- The reader always shows where you are (chapter, page or location, percent).
- Empty, loading and error states say what happened and what to do next.
- Keyboard: Tab order is sensible, focus is visible, Escape closes what is open.
- All five themes: text contrast, borders that do not vanish, the bookmark red
  and the accent still distinguishable.
- A window around 800px wide still works (toolbar does not overflow or clip).

Behaviour that must not regress is covered by `npm run test:e2e`; add a test
there for anything a user would notice breaking.
