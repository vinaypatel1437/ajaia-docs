# Ajaia Docs

A lightweight collaborative document editor: create and format documents, import files, share them with teammates as editors or viewers, and have everything persist.

**Live demo:** `<DEPLOYMENT_URL>` · **Walkthrough video:** see [VIDEO_URL.txt](VIDEO_URL.txt)

## Demo accounts

Auth is mocked: pick an account on the sign-in screen (no password).

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
- **Safe concurrent edits**: every save carries the document version. A stale save is rejected (HTTP 409), and the user chooses *Load their version* or *Keep mine*, so nothing is silently overwritten. When you have no unsaved changes, collaborators' saves are pulled in automatically (polling every 8s).
- **Export** to Markdown.

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

The 12 API tests cover auth, create/rename/edit/reopen with formatting preserved, HTML sanitization, validation, 409 conflict detection, the full owner/editor/viewer access matrix including revoking access, .md/.txt/.docx import, rejection of unsupported types, and Markdown export.

**Browser smoke test (optional, needs Google Chrome installed):** start a fresh server, then run the flow end to end. The flow is: Alice creates and formats a doc → reloads and checks formatting persisted → shares with Bob as viewer → Bob is read-only → Alice upgrades him to editor → Bob edits → Alice receives the change → .md import → .pdf rejection.

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
server/test/            API integration tests
client/src/             React app (Home, EditorPage, ShareDialog, useAutosave)
```

See [ARCHITECTURE.md](ARCHITECTURE.md) for design decisions and [AI_WORKFLOW.md](AI_WORKFLOW.md) for how AI tools were used.
