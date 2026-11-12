# AI workflow note

> Draft based on the build session. Edit to reflect your own experience before submitting.

## Tools used

- **Claude Code** (Claude Opus, in VS Code) as a pair programmer. It scaffolded the project, wrote first drafts of modules, ran the tests, and drove a headless Chrome to check UI flows.
- I owned the decisions on scope, architecture, and what counts as "done". Each phase was reviewed and run before moving on.

## Where AI materially sped things up

- **Boilerplate across the stack:** Express routes with Zod validation, SQLite schema, the React screens and the CSS. That's hours of typing reduced to review time.
- **Test scaffolding:** the Supertest access-matrix test, and a valid minimal `.docx` built in-test with JSZip so the import path is tested without a binary fixture.
- **Verification:** a Playwright script that runs the real two-user flow in Chrome and captures the screenshots in `docs/screenshots/`. It's now kept as `npm run e2e`.

## What I changed or rejected

- **Autosave side effect inside a React state updater:** rejected. The first draft triggered the save from inside `setStatus(prev => …)`. Under StrictMode, updaters run twice, so this is fragile. I replaced it with a status ref that the debounce timer reads.
- **`flush` keyed on the whole document object:** changed. Every save replaced the object, which re-created callbacks and re-registered listeners. It's now keyed on the document id.
- **Test that assumed Bob had no shared documents:** fixed. It ignored the seeded welcome document. The assertion now checks that the list *contains* the new share rather than equals it.
- **`/api/me` returned 401 for signed-out users:** changed. It produced console errors on every first load, which the e2e run caught. It now returns `{ user: null }`.
- **TipTap v3 (the npm default):** rejected in favour of v2. v3 changes React re-rendering defaults, and I wasn't willing to debug an unfamiliar API under a timebox.
- **Stretch scope:** built presence, comments, history and PDF, but rejected suggestion mode and CRDT co-editing as too costly to do well. PDF export first used the browser's print dialog. On review, a real file download was the better product behaviour, so it's now generated server-side with pdfkit. Headless Chrome (too heavy) and html2canvas (unselectable, blurry text) were rejected. A test parses the generated PDF to check that its content and order are correct. See "Intentionally deprioritized" in ARCHITECTURE.md.
- **Version snapshot on every save:** rejected. With autosave that would mean one history entry per second, so snapshots are grouped by editing session, and an injectable clock makes the rule testable.
- **A bug that only showed up in screenshots:** in the redesigned UI, the side panel's sticky offset assumed the toolbar was always visible, so with the toolbar hidden it sat out of line with the page. I fixed it with a per-layout CSS variable.
- **Flaky selection in the e2e test:** a double-click landed on the space between two words. I diagnosed it from a debug screenshot rather than weakening the assertion, and switched to keyboard selection.

## How I verified correctness, UX and reliability

- **19 API integration tests** against an in-memory DB: the access matrix (none → viewer → editor → revoked), 409 conflicts, sanitization of `<script>`/`onerror`, validation, all three import formats, version coalescing and restore, comment permissions, the realtime hub, and PDF content (parsed back out of the generated file).
- **`tsc --noEmit`** on the full client and server with strict mode.
- **Browser e2e run on the production build**, asserting on behaviour (formatting survives reload, viewer has `contenteditable=false`, a collaborator's edit appears via polling) and failing on any browser console error.
- **Screenshot review** of every screen at desktop width and at a 390px phone width, which drove a full design pass: icon toolbar, page-style canvas, toasts instead of layout-shifting banners, and a drag-and-drop import area.
