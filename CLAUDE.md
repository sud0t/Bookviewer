# BookViewer

An Electron desktop app: a library and reader for e-books and for books saved
from the web. You add a folder; it indexes the EPUB, MOBI/AZW3, FB2, CBZ and
PDF files in it, plus any saved HTML sites (mdBook, Sphinx, Jupyter Book,
MkDocs, or a plain folder of pages), and reads them all in one window.

Built with Electron + Vite (electron-vite), TypeScript, Svelte 5, SQLite
(better-sqlite3), foliate-js for e-book formats and pdf.js for PDFs. Linux only.

## Features

- Library: add folders, auto-scan and watch them, covers, sort/filter/search
- Reading in one continuous vertical scroll, or paginated (two pages)
- HTML sites read as books: site chrome and scripts stripped, contents and
  page order taken from the site's own navigation
- TeX math left in the text is rendered (MathJax); code is syntax-highlighted
- Highlights and notes (5 colours, 4 styles) in EPUB, HTML and PDF; they
  re-anchor by quoted text if the book changes; export to Markdown/JSON
- Bookmarks: red ribbon on a bookmarked page, toast naming the page with Undo,
  marks on the progress bar
- Reading progress restored on reopen; bottom bar with prev/next, back/forward
  history, chapter marks, jump preview, go to page, time left in chapter
- Library: "Continue reading" shelf, per-book menu (details, mark finished/unread)
- Search within a book
- Dictionary and Wikipedia lookup for the selection; translate link
- Read aloud, sentence by sentence (system voices, espeak-ng, or Piper)
- Themes (light, sepia, gray, dark, black), fonts, size, spacing, width; the UI
  colours are tokens in app.css (orange accent, red only for bookmarks)
- OPDS catalogs: browse, search, download into a library folder
- Packaging: AppImage, .deb, .pacman, and an Arch PKGBUILD

Not done yet: MOBI/AZW3 untested with real files, offline (StarDict)
dictionaries, a UI for lookup/translation language, opening a file from the
command line, PDF highlights spanning pages. From the 2026-10-02 usability
reviews, still open: Tab gets caught in the book text (no F6-style way to the
toolbar), the current search match is not drawn differently in the page,
right-click menu in book text, removing a single book from the library,
arrow-key movement in the library grid, drag-and-drop of a folder.

## Commands

```sh
npm run dev          # run with hot reload
npm run build        # build into out/   (npm start runs the build)
npm run typecheck
npm test             # unit tests (vitest)
npm run test:e2e     # builds, then drives the real app headlessly (Playwright)
npm run dist         # packages into dist/
node scripts/drive.mjs scripts/scenarios/open-book.mjs   # ad-hoc headless run + screenshots
PROFILE=.scratch/tour AXE=1 node scripts/drive.mjs scripts/scenarios/ui-tour.mjs   # every screen, both themes, + accessibility check
```

After a UI change, look at the tour's screenshots (the `ui-check` skill in
`.claude/skills/` describes the loop; `frontend-design` there is the design guidance).

After cloning: `git submodule update --init` (foliate-js lives in `vendor/`).

## Where everything is

```
src/shared/types.ts        all shared types, settings, and the list of IPC calls
src/main/                  Electron main process
  index.ts                   window and app lifecycle
  ipc.ts                     the handler for each IPC call
  db.ts                      SQLite: folders, books, annotations, bookmarks, settings
  library.ts                 scanning and watching folders
  webbook.ts                 recognising saved HTML sites; their page order and contents
  protocol.ts                book:// (serves book files to the UI) and app:// (the UI itself)
  covers.ts lookup.ts tts.ts opds.ts util.ts
src/preload/index.ts       the bridge the UI uses to call the main process
src/renderer/              the UI
  App.svelte  app.css        root component, global styles and theme colours
  lib/                       global state and toasts (app.svelte.ts), IPC wrapper, icons,
                             Dialog, keyboard-shortcut sheet, theme picker
  Library/                   library grid, book cards and covers, metadata/cover extraction
                             (meta.ts), OPDS browser (Catalogs.svelte, opds.ts)
  Reader/                    Reader.svelte (the reader screen), side panel, appearance panel,
                             popovers, lookup view, read-aloud controller (tts.svelte.ts)
  engines/                   what actually renders a book
    types.ts                   the interface every engine implements
    epub.ts                    EPUB/MOBI/FB2/CBZ and HTML books (on top of foliate-js)
    scroller.ts                the continuous-scroll renderer
    webbook.ts webpage.ts      turning a saved site into a book; cleaning up its pages
    pdf.ts pdf-text.ts rects.ts  the PDF engine (pdf.js) and its helpers
    math.ts cfi.ts             math rendering that keeps highlights in place
    appearance.ts fonts.ts     themes and typography applied to book content; the bundled
                               reading typeface (Literata)
    formats.ts remote-file.ts speech.ts pdfjs.ts
  annotations/               text anchoring (anchor.ts), annotation store, export
  types/foliate.d.ts         typings for foliate-js
vendor/foliate-js          e-book parsing/rendering library (git submodule, don't edit)
tests/unit/                vitest tests
tests/e2e/                 Playwright test of the real app; fixtures.ts builds test books
scripts/drive.mjs          headless driver for trying things by hand (scenarios/ui-tour.mjs
                           screenshots every screen)
.claude/skills/            frontend-design, theme-factory, ui-check (project skills)
packaging/                 Arch PKGBUILD and .desktop file
build/  resources/         app icons
electron.vite.config.ts  electron-builder.yml  playwright.config.ts  vitest.config.ts
README.md                  user-facing description, keyboard shortcuts
docs/screenshots/          screenshots used by the README
```

User data is in `~/.config/BookViewer` (`library.db` and `covers/`). Tests and
`scripts/drive.mjs` use a separate throwaway profile via `BOOKVIEWER_USER_DATA`,
and stub `shell.openExternal` so a clicked link never opens the real browser.

Things that are easy to break (each has an e2e test in "coming back to a book"):
a book must reopen at exactly the text it was left at, however often; the
scroller reports the line `goTo` would restore (see `READING_LINE` in
scroller.ts), and chapters are measured only after their fonts have loaded.
