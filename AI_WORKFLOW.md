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
- **Scope:** declined real-time CRDT collaboration and real auth. I chose optimistic locking with conflict resolution instead, explained in ARCHITECTURE.md.

## How I verified correctness, UX and reliability

- **12 API integration tests** against an in-memory DB: the access matrix (none → viewer → editor → revoked), 409 conflicts, sanitization of `<script>`/`onerror`, validation, and all three import formats.
- **`tsc --noEmit`** on the full client and server with strict mode.
- **Browser e2e run on the production build**, asserting on behaviour (formatting survives reload, viewer has `contenteditable=false`, a collaborator's edit appears via polling) and failing on any browser console error.
- **Screenshot review** of each screen for layout and clarity, at desktop width with a mobile breakpoint in CSS.
