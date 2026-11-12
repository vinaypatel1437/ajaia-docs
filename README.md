# Ajaia Docs

A lightweight collaborative document editor: create and format documents, import files, share them with teammates as editors or viewers, and have everything persist.

**Live demo:** `<DEPLOYMENT_URL>` · **Walkthrough video:** see [VIDEO_URL.txt](VIDEO_URL.txt)

## Demo accounts

Auth is mocked: pick an account on the sign-in screen (no password).

> Seed data: Bob also has an open comment on the welcome doc.

| User | Email | Seed data |
|---|---|---|
| Alice Chen | alice@ajaia.dev | Owns "Welcome to Ajaia Docs" |
| Bob Okafor | bob@ajaia.dev | Has **edit** access to Alice's welcome doc |
| Carol Diaz | carol@ajaia.dev | Nothing shared yet, so you can test granting access |

**To test sharing:** sign in as Alice in one browser window and as Bob in a private/incognito window (the session is a per-browser cookie). Alternatively, use **Switch user** in the top bar.

## Features

- **Documents**: create, rename (click the title), edit, delete (owner only). Autosaves about 0.7s after you stop typing, and the save state is shown next to the title.
- **Rich text** (TipTap/ProseMirror): bold, italic, underline, strikethrough, H1–H3, bulleted and numbered lists, quotes, dividers, undo/redo, and the usual ⌘B / ⌘I / ⌘U shortcuts.
- **File import**: **.txt, .md, .docx** (max 5 MB) become a new editable document, keeping headings, lists, bold and italic. Use the *Import file* button or drag a file onto the home page. Images and tables inside .docx files are dropped. Other file types are rejected with a clear message.
- **Sharing**: every document has an owner. The owner shares by email with **Can edit** or **Can view**, can change roles, and can remove access. The home page separates **My documents** from **Shared with me** and shows the owner and your access level. Viewers get a read-only editor.
- **Safe concurrent edits**: every save carries the document version. A stale save is rejected (HTTP 409), and the user chooses *Load their version* or *Keep mine*, so nothing is silently overwritten.
- **Live collaboration indicators** (Server-Sent Events): avatars of who's in the document, a green "is editing" dot, and instant sync. Collaborators' saves, comment changes and access changes appear in under a second. If your access is revoked, your editor locks immediately.
- **Comments**: select text and comment. Anyone with access (including viewers) can comment. Click a comment to jump to its text. Resolve, reopen, and delete according to role.
- **Version history**: automatic snapshots, one per editing session (when a different person starts editing, or every 5 minutes). Preview any version read-only and restore it; the replaced state stays in history.
- **Export** to Markdown (.md) or PDF (.pdf). The PDF is generated on the server as a real text document: selectable text, headings, lists, bold/italic/underline/strike, quotes, code blocks and page numbers. It downloads directly.

## Run locally

Requirements: Node.js 20+.

```bash
npm install
npm run dev          # API on :3001 + Vite on :5173 → open http://localhost:5173
```

Production mode (single server that serves the built client and the API):

```bash
npm run build
npm start            # http://localhost:3001
```

The SQLite database is created at `./data/ajaia.db` and seeded on first run. Delete that file to reset.

| Env var | Default | Purpose |
|---|---|---|
| `PORT` | `3001` | HTTP port |
| `DATABASE_FILE` | `./data/ajaia.db` | SQLite file location (point it at a persistent volume in production) |
| `COOKIE_SECRET` | dev value | Signs the session cookie. **Set this in production.** |
| `INSECURE_COOKIES` | unset | Set to `1` to run production mode over plain http locally |

## Tests

```bash
npm test             # API integration tests (Vitest + Supertest, in-memory SQLite)
npm run typecheck
```

The 19 API tests cover:
- auth, and create/rename/edit/reopen with formatting preserved
- HTML sanitization and validation
- 409 conflict detection
- the full owner/editor/viewer access matrix, including revoking access
- .md/.txt/.docx import and rejection of unsupported types
- Markdown export
- version-history coalescing and restore, using a fake clock
- comment permissions per role
- presence de-duplication and live save broadcasts
- PDF export: the downloaded file is parsed and its text and order are checked

**Browser smoke test (optional, needs Google Chrome installed):** start a fresh server, then run the flow end to end. The flow is: 1. Alice creates and formats a doc, reloads, and checks the formatting persisted.
2. She shares with Bob as a viewer; Bob is read-only.
3. She upgrades him to editor; Bob's edit reaches Alice live, and she sees his presence.
4. Bob comments on a selection; Alice sees the comment live, jumps to the quoted text, and resolves it.
5. Alice restores a version; Bob receives it live.
6. A PDF export downloads a valid .pdf file.
7. Alice revokes Bob's access, and his editor locks.
8. A .md file is imported and a .pdf is rejected.

```bash
npm run build && DATABASE_FILE=/tmp/e2e.db INSECURE_COOKIES=1 npm start   # terminal 1
npm run e2e                                                              # terminal 2
```

## Deploy

The repo includes a `Dockerfile` and a Render blueprint (`render.yaml`).

- **Render (free):** New → Blueprint → select this repo. Note: the free plan's disk is ephemeral, so data resets on redeploy or idle spin-down, and the app reseeds the demo data.
- **Durable data:** run the same image anywhere with a persistent volume mounted at `/data` (Railway volume, Fly.io volume, or a Render paid disk).

## Project layout

```
server/src/app.ts       Express routes, validation, access checks, error handling
server/src/db.ts        SQLite schema, seed data, getRole() access helper
server/src/content.ts   File → HTML conversion, HTML sanitizer, Markdown export
server/src/realtime.ts  In-memory event hub behind the SSE endpoint (presence, saves, comments)
server/test/            API integration tests
client/src/             React app (Home, EditorPage, CommentsPanel, HistoryPanel, ShareDialog,
                        useAutosave, useCollab)
e2e/smoke.mjs           Browser smoke test (Playwright + local Chrome)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions and [AI_WORKFLOW.md](AI_WORKFLOW.md) for how AI tools were used.
