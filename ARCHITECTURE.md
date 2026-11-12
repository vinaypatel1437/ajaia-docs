# Architecture note

## Shape

One Node.js service (Express 5 + TypeScript) serves both the JSON API and the built React SPA, backed by a single SQLite file (better-sqlite3). That means one process, one deploy target, no external services, and nothing for reviewers to pay for.

```
React + TipTap (Vite)  ──fetch /api──▶  Express  ──▶  SQLite (users, documents, document_shares)
```

## What I prioritized and why

1. **The editing loop feels trustworthy.** A docs product fails if people lose work, so most of the frontend effort went into `useAutosave`:
   - Edits are debounced and merged into one pending patch.
   - At most one save is in flight, and a failed save keeps the edits and offers a retry.
   - The save state is always visible.
   - A warning appears if you close the tab with unsaved changes.
2. **Access control is enforced on the server, in one place.** `getRole(db, docId, userId)` returns `owner | editor | viewer | null`, and every document route declares the minimum role it needs. A user with no access gets **404**, not 403, so document ids can't be probed. The UI hides controls by role, but that's convenience only; the tests exercise the API directly.
3. **Shared documents are safe to open.** Content is stored as HTML and passed through an allowlist sanitizer (`sanitize-html`) on every write, both editor saves and imports. The allowlist matches exactly what the editor can produce, so a collaborator can't plant script in a document you open.
4. **Concurrent edits don't silently clobber each other.** Each document has a `version` integer. Saves send the version they were based on, the server updates with `WHERE version = ?`, and a mismatch returns 409 with the current server copy. The user then picks *load theirs* or *keep mine*. With idle polling, a second user's edits appear within seconds. This is deliberately not real-time co-editing (see below).

## Key decisions

| Decision | Why |
|---|---|
| **TipTap 2 (ProseMirror)** | Mature schema-based editor. Formatting is a structured document, not `contentEditable` soup. I pinned v2 because its React API is stable and well understood. |
| **Store HTML, not ProseMirror JSON** | Import (Markdown/docx → HTML) and export (HTML → Markdown) become simple. The sanitizer constrains HTML to the editor schema, so formatting round-trips. The tradeoff: JSON would be better for future CRDT or diffing. |
| **SQLite** | Zero-ops persistence with real constraints: foreign keys with cascade delete, a CHECK constraint on role, and a composite primary key on shares. The data access is plain SQL and small, so moving to Postgres would be mechanical. |
| **Mocked auth with seeded users** | The assignment is about sharing semantics, not identity. A signed httpOnly cookie holds the user id, and the login screen lists demo accounts. Sharing is by email, as it would be with real auth. |
| **Import creates a new document** | This is the clearest product behaviour. It reuses the same sanitizer as editor saves, and server-side conversion (`marked`, `mammoth`) keeps the client light. |
| **Hash routing, no state library** | Two screens don't justify a router or a store. |

## Deliberately cut

- **Real-time co-editing** (CRDT/OT, live cursors). This is the biggest cut. It would need Yjs + websockets + a persistence adapter, which is a project in itself. Optimistic locking + polling gives correct behaviour for the likely case (people taking turns) within the timebox.
- **Real authentication**, password reset, inviting users who don't have an account yet.
- **Comments, suggestions, version history**, images and tables in documents, PDF import.
- **Pagination and search** on the document list.

## What I'd build next (2–4 hours)

1. Version history: snapshot the content on each version bump (the version column already exists) and add a restore UI.
2. Real-time presence (who's viewing) over SSE, as a step toward Yjs collaboration.
3. Run the Playwright smoke test (`e2e/smoke.mjs`) in CI against the Docker image.
4. Real auth (magic link or OAuth), and Postgres for a durable hosted deploy.
