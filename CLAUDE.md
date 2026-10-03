# BookViewer

An Electron desktop app: a library and reader for e-books and for books saved
from the web. You add a folder; it indexes the EPUB, MOBI/AZW3, FB2, CBZ and
PDF files in it, plus any saved HTML sites (mdBook, Sphinx, Jupyter Book,
MkDocs, or a plain folder of pages), and reads them all in one window.

Built with Electron + Vite (electron-vite), TypeScript, Svelte 5, SQLite
(better-sqlite3), foliate-js for e-book formats and pdf.js for PDFs. Linux only.

## Features

- Library: add folders (button, or drop one on the window), auto-scan and watch
  them, covers, sort/filter/search, arrow keys between books
- `bookviewer book.epub` (or a book dropped on the window) opens that book; a
  file outside every library folder is added on its own, as a one-file "folder"
- A book can be removed from the library alone: its row is hidden (`books.hidden`),
  not deleted, so scans do not re-add it; Undo, or Settings > "Put back removed books"
- Reading in one continuous vertical scroll, or paginated (two pages)
- HTML sites read as books: site chrome and scripts stripped, contents and
  page order taken from the site's own navigation
- TeX math left in the text is rendered (MathJax); code is syntax-highlighted
- Highlights and notes (5 colours, 4 styles) in EPUB, HTML and PDF; they
  re-anchor by quoted text if the book changes; export to Markdown/JSON. A PDF
  selection over a page break is saved as one highlight per page
- Right-click in book text selects the word under the pointer and shows the
  selection menu; F6 goes between the book text and the toolbar
- Bookmarks: red ribbon on a bookmarked page, toast naming the page with Undo,
  marks on the progress bar
- Reading progress restored on reopen; bottom bar with prev/next, back/forward
  history, chapter marks, jump preview, go to page, time left in chapter
- Library: "Continue reading" shelf, per-book menu (details, mark finished/unread)
- Search within a book; the result you are on is drawn filled in the page
- Dictionary and Wikipedia lookup for the selection; translate link; the
  fallback lookup language and the translation language are in the library's Settings
- Read aloud, sentence by sentence (system voices, espeak-ng, or Piper)
- Themes (light, sepia, gray, dark, black), fonts, size, spacing, width; the UI
  colours are tokens in app.css (orange accent, red only for bookmarks)
- OPDS catalogs: browse, search, download into a library folder
- "Add from web address": a URL is saved into a library folder (`src/main/webgrab.ts`):
  an HTML page plus, for "the whole book", the same-site pages under its directory
  that it links to (and `rel=next` chains, mdBook's `toc.html`), with images and
  stylesheets, as a saved site the scanner then reads; a PDF/e-book URL is
  downloaded as it is. With no library folder yet it creates and adds `~/Books`
- Covers: the file's own, else Open Library by title/author (setting
  `onlineCovers`), else a picture of the first page (`Library/meta.ts`)
- Code in books is set in the bundled JetBrains Mono, inline code gets a chip;
  a book's own `prefers-color-scheme: dark` rules are removed (dark themes
  invert a light page, see appearance.ts)
- Packaging: AppImage, .deb, .pacman, and an Arch PKGBUILD

Not done yet: MOBI/AZW3 untested with real files (none on the dev machine),
offline (StarDict) dictionaries. Drag-and-drop is only checked through the
`library:openPaths` call it ends in (Playwright cannot drop files here), and a
single saved HTML file cannot be opened from the command line. Saving from a
URL does not run scripts, so sites that build their pages in the browser come
out empty; it follows links one level deep only; there is no "update this
saved book" yet.

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
Then `git config core.hooksPath .githooks`: the pre-commit hook refuses commits
that contain build output (`packaging/arch/pkg`, `.BUILDINFO`, packages), this
machine's home path or user name, key-like strings, or anything listed in the
untracked `.git/info/private-strings`. The repository is public.

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
  webgrab.ts                 saving a site / page from a URL into a library folder
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
