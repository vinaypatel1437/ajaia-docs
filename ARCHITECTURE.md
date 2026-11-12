# Architecture note

## Shape

One Node.js service (Express 5 + TypeScript) serves the JSON API, a Server-Sent Events stream, and the built React SPA. Data lives in a single SQLite file (better-sqlite3). There's one process, one deploy target, no external services, and nothing for reviewers to pay for.

```
React + TipTap (Vite) ──fetch /api──────────▶ Express ──▶ SQLite
        ▲                                        │        users · documents · document_shares
        └──── EventSource /api/…/events ◀── Hub ─┘        document_versions · comments
              (presence, saves, comments, access)
```

| Module | Responsibility |
|---|---|
| `server/src/app.ts` | Routes, Zod validation, access checks, version snapshots, error handling |
| `server/src/db.ts` | Schema and additive migrations, seed data, and `getRole()`, the single access-control function |
| `server/src/content.ts` | File → HTML import (`marked`, `mammoth`), the allowlist sanitizer, Markdown export |
| `server/src/realtime.ts` | In-memory per-document event hub behind the SSE endpoint |
| `client/src/useAutosave.ts` | Debounced, serialised saves carrying the document version, plus conflict state |
| `client/src/useCollab.ts` | Subscribes to the SSE stream: presence, "is editing", live updates |

## What I prioritized and why

1. **Nobody loses work.** A docs product fails the moment it eats an edit, so the core of the frontend is `useAutosave`:
   - Edits are debounced and merged into one pending patch, with at most one request in flight.
   - Failed saves keep the edits and offer a retry, and the save state is always visible.
   - Every save carries the document's `version`. The server updates `WHERE version = ?` and returns **409** with the server copy on a mismatch. The user then chooses *Load their version* or *Keep mine*, so nothing is silently overwritten.
   - Version history backs this up: restoring a version snapshots the state it replaces first.
2. **Access control on the server, in one place.** `getRole(db, docId, userId)` returns `owner | editor | viewer | null`, and every route declares the minimum role it needs. A user with no access gets **404** rather than 403, so ids can't be probed. When access is revoked, that user's live connection is closed and their editor locks immediately. The UI hides controls by role only for convenience; the tests hit the API directly.
3. **Shared content is safe to open.** HTML is passed through an allowlist sanitizer on every write: editor saves, imports and restores. The allowlist matches exactly what the editor can produce, so a collaborator can't plant script in a document you open.
4. **Collaboration feels live without CRDT complexity.** SSE pushes saves, presence, typing activity, comment changes and access changes. A collaborator's save appears in under a second when you have nothing unsaved; if you do, the 409 flow resolves it. A 30-second poll is a fallback if the stream is blocked.

## Key decisions

| Decision | Why |
|---|---|
| **TipTap 2 (ProseMirror)** | Schema-based editor, so formatting is structured, not `contentEditable` soup. v2 was chosen over v3 for its stable, well-known React API. |
| **Store HTML, not ProseMirror JSON** | Import (Markdown/docx → HTML), export (HTML → Markdown) and print all become simple. The sanitizer constrains HTML to the editor schema, so formatting round-trips. JSON would be the better base for CRDTs later. |
| **SQLite** | Zero-ops, with real constraints: foreign keys with cascade, CHECK on role, composite PK on shares. The SQL is small and portable, so moving to Postgres is mechanical. |
| **SSE, not WebSockets** | All realtime traffic flows server → client, and writes stay ordinary REST calls with the same validation and access checks. SSE needs no extra library, reconnects by itself, and works through standard proxies. |
| **Session-based version history** | Autosave fires about once a second, so a snapshot per save would flood the history. A snapshot is taken when a *different person* starts editing, or when the last snapshot is more than 5 minutes old. The tests use an injectable clock. |
| **Comments anchored by quoted text** | The comment stores the selected text. Clicking it finds and selects that text in the current document, and fails gracefully if the text has since been edited away. This avoids position-mapping machinery while staying useful. |
| **Viewers can comment** | This matches how review works in practice. Viewers can resolve only their own comments; editors can resolve any; only the comment author or the document owner can delete. |
| **PDF via the browser's print-to-PDF** | A print stylesheet renders just the page (title + content) with no app chrome. The output is good, and it needs no server-side headless Chrome, which would be heavy and slow on a free host. |
| **Mocked auth with seeded users** | The assignment is about sharing semantics, not identity. A signed httpOnly cookie carries the user id, and sharing is by email, as it would be with real auth. |
| **Import creates a new document** | The clearest product behaviour. It reuses the same sanitizer as editor saves. |

## Intentionally deprioritized

The cuts below are deliberate, ranked roughly by how much they would have cost. Each row says what we do instead, so the product is still coherent without it.

### Product scope

| Deprioritized | Why | What we do instead |
|---|---|---|
| **Real-time co-editing** (CRDT/OT, live cursors) | The biggest possible sink. It needs Yjs, a websocket provider and a persistence adapter, and it changes the storage model. Most shared docs are edited by people taking turns. | Optimistic locking with a conflict choice, SSE live updates, presence, and "Bob is editing" indicators |
| **Suggestion mode** (tracked changes) | Needs custom insert/delete marks in the editor schema, plus accept/reject UI and merge rules. Too much to do well in the timebox. | Comments on selected text cover the "propose a change" need |
| **Comment threads, @mentions, notifications** | Each is its own feature, and notifications also need email or in-app delivery. | Flat comments with resolve/reopen that sync live |
| **Live comment highlights in the text** | Needs ProseMirror decorations that track positions as text changes. | Click a comment to jump to and select its quoted text |
| **Diff view between versions** | Needs an HTML diff renderer, and it's a polish item. | Full read-only preview of any version, plus restore |
| **Tables, images, links UI, fonts, colours, alignment** | Each widens the editor schema, the sanitizer, import/export and the tests. | The core formatting set the brief asks for, done well |
| **Search, folders, pagination, trash/undo-delete** | Not needed at demo scale. | Owned and shared lists sorted by last edit, and a confirmation dialog before delete |
| **PDF import, .docx images and tables, import into an existing doc** | Low value for the cost, and PDF text extraction is unreliable. | .txt/.md/.docx → new document, with limits stated in the UI |
| **Link sharing, inviting people without an account, org roles** | These depend on real identity and invitations. | Share by email with existing users, with Can edit / Can view roles |

### Engineering scope

| Deprioritized | Why | Mitigation |
|---|---|---|
| **Real authentication** | Orthogonal to what's being evaluated. | Signed httpOnly cookie, server-side checks on every route |
| **Horizontal scaling** | The SSE hub is in process memory, and SQLite is single-node. | Fine for a single instance. Scaling would need Redis pub/sub and Postgres; the hub interface already isolates this. |
| **CSRF tokens, rate limiting** | Demo scope. | `SameSite=Lax` cookies and JSON-only write endpoints; size limits on bodies and uploads |
| **Frontend unit tests, e2e in CI** | Time. | 17 API integration tests, plus a Playwright browser smoke test of every main flow (`npm run e2e`) |
| **Dark mode, i18n, full accessibility audit** | Polish beyond the core. | Labelled controls, keyboard shortcuts, visible focus rings, responsive down to phone width |

## What I'd build next (2–4 hours)

1. Comment highlights in the text, using ProseMirror decorations, and threaded replies.
2. A diff view between versions, and named versions.
3. Run `e2e/smoke.mjs` in CI against the Docker image.
4. Real auth (magic link or OAuth) plus Postgres, for a durable hosted deploy.
