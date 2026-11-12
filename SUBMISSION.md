# Submission: Ajaia Docs

**Live URL:** `<DEPLOYMENT_URL>`
**Video:** see `VIDEO_URL.txt`
**Demo accounts (no password; pick one on the sign-in screen):** alice@ajaia.dev, bob@ajaia.dev, carol@ajaia.dev. Alice owns the welcome doc and Bob can edit it. Use a second browser or incognito window to act as a second user.

## Included

| Item | Location |
|---|---|
| Source code | `server/`, `client/`, `e2e/` |
| Setup & run instructions | `README.md` |
| Architecture note | `ARCHITECTURE.md` |
| AI workflow note | `AI_WORKFLOW.md` |
| Walkthrough video URL | `VIDEO_URL.txt` |
| Screenshots | `docs/screenshots/` (login, home, editor, share dialog, shared list, view-only, import, comments, history, mobile) |
| Automated tests | `server/test/` (19 API tests), `e2e/smoke.mjs` (browser flow covering every feature) |
| Deployment config | `Dockerfile`, `render.yaml` |

## Status

**Working end to end**
- Create, rename, edit, autosave, reopen and delete documents. Rich text: bold, italic, underline, strike, H1–H3, bulleted and numbered lists, quote, divider.
- Import .txt / .md / .docx as a new document (max 5 MB). Other types are rejected with a message.
- Sharing by email with an owner and Can edit / Can view roles. Roles can be changed and access removed. *My documents* and *Shared with me* are separate lists, and viewers get a read-only editor.
- SQLite persistence for documents, formatting and shares.
- Server-side access checks, input validation, HTML sanitization, and conflict detection (409) with a resolution UI.
- Stretch:
  - live collaboration indicators (presence, "is editing", instant sync over SSE)
  - comments on selected text
  - version history with preview and restore
  - export to Markdown and a server-generated PDF download
  - role-based permissions (editor/viewer)

**Partial / known limitations**
- No simultaneous co-editing (CRDT). Concurrent saves are detected and resolved, and other users' changes arrive live over SSE.
- Suggestion mode was not built. Comments cover the "propose a change" need.
- Comments are flat (no threads or @mentions), and the quoted text is not highlighted inside the document.
- PDF export uses the built-in PDF fonts, which cover Latin text only; other scripts appear as `?`.
- Auth is mocked with seeded users.
- .docx images and tables are not imported.
- On Render's free plan, data resets when the instance redeploys or spins down. Mount a volume at `/data` for durability.

**Intentionally deprioritized:** see the "Intentionally deprioritized" tables in `ARCHITECTURE.md`, which list each cut, why, and what the product does instead.

**Next 2–4 hours:** in-text comment highlights and threads, a diff view between versions, e2e in CI, real auth plus Postgres.
