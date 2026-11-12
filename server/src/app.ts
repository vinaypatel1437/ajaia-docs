import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getRole, type DB, type DocumentRow, type Role, type UserRow } from './db.js';
import { Hub, type HubEvent } from './realtime.js';
import {
  cleanHtml, fileToDocument, htmlToMarkdown, MAX_UPLOAD_BYTES, SUPPORTED_EXTENSIONS, UnsupportedFileError,
} from './content.js';

export class HttpError extends Error {
  constructor(public status: number, message: string, public details?: unknown) { super(message); }
}

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express { interface Request { user?: UserRow } }
}

const SESSION_COOKIE = 'ajaia_uid';
const MAX_CONTENT_CHARS = 2_000_000;

const titleSchema = z.string().trim().min(1, 'Title cannot be empty').max(200, 'Title is too long');
const createSchema = z.object({ title: titleSchema.optional(), content: z.string().max(MAX_CONTENT_CHARS).optional() });
const updateSchema = z.object({
  title: titleSchema.optional(),
  content: z.string().max(MAX_CONTENT_CHARS, 'Document is too large').optional(),
  version: z.number().int().positive(),
}).refine((b) => b.title !== undefined || b.content !== undefined, 'Nothing to update');
const shareSchema = z.object({
  email: z.string().trim().toLowerCase().pipe(z.email('Enter a valid email')),
  role: z.enum(['viewer', 'editor']).default('editor'),
});
const loginSchema = z.object({ email: z.string().trim().toLowerCase() });
const commentSchema = z.object({
  body: z.string().trim().min(1, 'Comment cannot be empty').max(2000, 'Comment is too long'),
  quote: z.string().trim().max(500).optional().transform((q) => q || null),
});
const resolveSchema = z.object({ resolved: z.boolean() });

/** Edits by the same person within this window are coalesced into one history entry. */
export const VERSION_SESSION_MS = 5 * 60 * 1000;

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid request');
  return result.data;
}

export interface AppOptions {
  db: DB; cookieSecret: string; secureCookies?: boolean;
  hub?: Hub;
  /** Injectable clock so version-history coalescing can be tested. */
  now?: () => Date;
}

export function createApp({ db, cookieSecret, secureCookies = false, hub = new Hub(), now = () => new Date() }: AppOptions) {
  const app = express();
  const nowIso = () => now().toISOString();
  app.use(express.json({ limit: '4mb' }));
  app.use(cookieParser(cookieSecret));

  const userById = db.prepare('SELECT * FROM users WHERE id = ?');
  const userByEmail = db.prepare('SELECT * FROM users WHERE email = ?');
  const docById = db.prepare('SELECT * FROM documents WHERE id = ?');

  // --- auth (mocked: choose a seeded account, stored in a signed httpOnly cookie) ---
  app.use((req, _res, next) => {
    const uid = req.signedCookies?.[SESSION_COOKIE];
    if (typeof uid === 'string') req.user = userById.get(uid) as UserRow | undefined;
    next();
  });
  const requireUser = (req: Request, _res: Response, next: NextFunction) => {
    if (!req.user) return next(new HttpError(401, 'Please sign in'));
    next();
  };

  app.get('/api/health', (_req, res) => { res.json({ ok: true }); });

  app.post('/api/auth/login', (req, res) => {
    const { email } = parse(loginSchema, req.body);
    const user = userByEmail.get(email) as UserRow | undefined;
    if (!user) throw new HttpError(401, 'Unknown account. Use one of the demo users.');
    res.cookie(SESSION_COOKIE, user.id, {
      signed: true, httpOnly: true, sameSite: 'lax', secure: secureCookies, maxAge: 7 * 24 * 3600 * 1000,
    });
    res.json({ user });
  });

  app.post('/api/auth/logout', (_req, res) => {
    res.clearCookie(SESSION_COOKIE);
    res.status(204).end();
  });

  // Returns { user: null } rather than 401 so the client can check session state without error noise.
  app.get('/api/me', (req, res) => { res.json({ user: req.user ?? null }); });

  app.get('/api/users', (_req, res) => {
    // Public list of demo accounts: powers the login picker and share suggestions.
    res.json({ users: db.prepare('SELECT * FROM users ORDER BY name').all() });
  });

  // --- documents ---
  const loadDoc = (req: Request, minimum: Role) => {
    const id = String(req.params.id);
    const role = getRole(db, id, req.user!.id);
    // 404 (not 403) when there is no access at all, so ids can't be probed.
    if (!role) throw new HttpError(404, 'Document not found');
    const rank: Record<Role, number> = { viewer: 0, editor: 1, owner: 2 };
    if (rank[role] < rank[minimum]) {
      throw new HttpError(403, minimum === 'owner' ? 'Only the owner can do that' : 'You have view-only access');
    }
    return { doc: docById.get(id) as DocumentRow, role };
  };

  const serializeDoc = (doc: DocumentRow, role: Role) => {
    const owner = userById.get(doc.owner_id) as UserRow;
    return {
      id: doc.id, title: doc.title, content: doc.content, version: doc.version,
      createdAt: doc.created_at, updatedAt: doc.updated_at,
      owner: { id: owner.id, name: owner.name, email: owner.email, color: owner.color },
      role,
    };
  };

  const insertDoc = (ownerId: string, title: string, content: string) => {
    const id = randomUUID();
    const ts = nowIso();
    db.prepare(`INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at, last_editor_id)
      VALUES (?, ?, ?, ?, 1, ?, ?, ?)`).run(id, ownerId, title, content, ts, ts, ownerId);
    return docById.get(id) as DocumentRow;
  };

  const publicUser = (u: UserRow) => ({ id: u.id, name: u.name, color: u.color });
  const publish = (docId: string, event: HubEvent) => hub.publish(docId, event);

  /**
   * Version history: before a document changes, keep a snapshot of its current state when
   * (a) a different person is now editing, (b) the last snapshot is older than the session
   * window, or (c) `force` (restores). Autosave fires every second, so snapshotting every
   * save would flood history; this yields one entry per editing session instead.
   */
  const snapshotBeforeChange = (doc: DocumentRow, editorId: string, force = false) => {
    const latest = db.prepare(
      'SELECT version, created_at FROM document_versions WHERE document_id = ? ORDER BY version DESC LIMIT 1',
    ).get(doc.id) as { version: number; created_at: string } | undefined;
    if (latest?.version === doc.version) return; // this exact state is already saved
    const stale = !latest || now().getTime() - new Date(latest.created_at).getTime() > VERSION_SESSION_MS;
    if (!force && !stale && doc.last_editor_id === editorId) return;
    db.prepare(`INSERT INTO document_versions (id, document_id, version, title, content, author_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`)
      .run(randomUUID(), doc.id, doc.version, doc.title, doc.content, doc.last_editor_id, doc.updated_at);
  };

  app.get('/api/documents', requireUser, (req, res) => {
    const uid = req.user!.id;
    const owned = db.prepare(`
      SELECT d.id, d.title, d.updated_at AS updatedAt,
        (SELECT COUNT(*) FROM document_shares s WHERE s.document_id = d.id) AS shareCount
      FROM documents d WHERE d.owner_id = ? ORDER BY d.updated_at DESC`).all(uid);
    const shared = db.prepare(`
      SELECT d.id, d.title, d.updated_at AS updatedAt, s.role, u.name AS ownerName, u.color AS ownerColor
      FROM document_shares s
      JOIN documents d ON d.id = s.document_id
      JOIN users u ON u.id = d.owner_id
      WHERE s.user_id = ? ORDER BY d.updated_at DESC`).all(uid);
    res.json({ owned, shared });
  });

  app.post('/api/documents', requireUser, (req, res) => {
    const body = parse(createSchema, req.body ?? {});
    const doc = insertDoc(req.user!.id, body.title ?? 'Untitled document', cleanHtml(body.content ?? ''));
    res.status(201).json({ document: serializeDoc(doc, 'owner') });
  });

  const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 } });
  app.post('/api/documents/import', requireUser, upload.single('file'), async (req, res) => {
    if (!req.file) throw new HttpError(400, 'Attach a file in the "file" field');
    try {
      const { title, html } = await fileToDocument(req.file.originalname, req.file.buffer);
      const doc = insertDoc(req.user!.id, title, html);
      res.status(201).json({ document: serializeDoc(doc, 'owner') });
    } catch (err) {
      if (err instanceof UnsupportedFileError) throw new HttpError(415, err.message);
      throw new HttpError(422, 'Could not read that file. Is it a valid .txt, .md or .docx?');
    }
  });

  app.get('/api/documents/:id', requireUser, (req, res) => {
    const { doc, role } = loadDoc(req, 'viewer');
    res.json({ document: serializeDoc(doc, role) });
  });

  app.patch('/api/documents/:id', requireUser, (req, res) => {
    const { doc, role } = loadDoc(req, 'editor');
    const body = parse(updateSchema, req.body);
    // Optimistic concurrency: a stale client must reload instead of overwriting someone else's edits.
    if (body.version !== doc.version) {
      throw new HttpError(409, 'This document was changed by someone else.', { document: serializeDoc(doc, role) });
    }
    const update = db.transaction(() => {
      snapshotBeforeChange(doc, req.user!.id);
      return db.prepare(`
        UPDATE documents SET title = ?, content = ?, version = version + 1, updated_at = ?, last_editor_id = ?
        WHERE id = ? AND version = ?`).run(
        body.title ?? doc.title,
        body.content !== undefined ? cleanHtml(body.content) : doc.content,
        nowIso(), req.user!.id, doc.id, doc.version,
      );
    });
    if (update().changes === 0) throw new HttpError(409, 'This document was changed by someone else.');
    const saved = docById.get(doc.id) as DocumentRow;
    publish(doc.id, { type: 'saved', version: saved.version, by: publicUser(req.user!) });
    res.json({ document: serializeDoc(saved, role) });
  });

  app.delete('/api/documents/:id', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'owner');
    db.prepare('DELETE FROM documents WHERE id = ?').run(doc.id);
    res.status(204).end();
  });

  app.get('/api/documents/:id/export.md', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'viewer');
    const filename = doc.title.replace(/[^\w\- ]+/g, '').trim() || 'document';
    res.setHeader('Content-Type', 'text/markdown; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="${filename}.md"`);
    res.send(`# ${doc.title}\n\n${htmlToMarkdown(doc.content)}\n`);
  });

  // --- sharing (owner manages; everyone with access can see who else has it) ---
  const listShares = (docId: string) => db.prepare(`
    SELECT u.id, u.name, u.email, u.color, s.role FROM document_shares s
    JOIN users u ON u.id = s.user_id WHERE s.document_id = ? ORDER BY s.created_at`).all(docId);

  app.get('/api/documents/:id/shares', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'viewer');
    res.json({ shares: listShares(doc.id) });
  });

  app.post('/api/documents/:id/shares', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'owner');
    const { email, role } = parse(shareSchema, req.body);
    const target = userByEmail.get(email) as UserRow | undefined;
    if (!target) throw new HttpError(404, `No user with email ${email}`);
    if (target.id === doc.owner_id) throw new HttpError(400, 'The owner already has full access');
    db.prepare(`
      INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)
      ON CONFLICT (document_id, user_id) DO UPDATE SET role = excluded.role`)
      .run(doc.id, target.id, role, nowIso());
    publish(doc.id, { type: 'access' });
    res.status(201).json({ shares: listShares(doc.id) });
  });

  app.delete('/api/documents/:id/shares/:userId', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'owner');
    const userId = String(req.params.userId);
    db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?').run(doc.id, userId);
    publish(doc.id, { type: 'access' });
    hub.kick(doc.id, userId);
    res.json({ shares: listShares(doc.id) });
  });

  // --- version history ---
  app.get('/api/documents/:id/versions', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'viewer');
    const versions = db.prepare(`
      SELECT v.id, v.version, v.title, v.created_at AS createdAt, u.id AS authorId, u.name AS authorName, u.color AS authorColor
      FROM document_versions v LEFT JOIN users u ON u.id = v.author_id
      WHERE v.document_id = ? ORDER BY v.version DESC LIMIT 100`).all(doc.id);
    res.json({ versions });
  });

  const loadVersion = (docId: string, versionId: string) => {
    const v = db.prepare('SELECT * FROM document_versions WHERE id = ? AND document_id = ?').get(versionId, docId) as
      | { id: string; version: number; title: string; content: string; created_at: string } | undefined;
    if (!v) throw new HttpError(404, 'Version not found');
    return v;
  };

  app.get('/api/documents/:id/versions/:versionId', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'viewer');
    const v = loadVersion(doc.id, String(req.params.versionId));
    res.json({ version: { id: v.id, version: v.version, title: v.title, content: v.content, createdAt: v.created_at } });
  });

  app.post('/api/documents/:id/versions/:versionId/restore', requireUser, (req, res) => {
    const { doc, role } = loadDoc(req, 'editor');
    const v = loadVersion(doc.id, String(req.params.versionId));
    db.transaction(() => {
      snapshotBeforeChange(doc, req.user!.id, true); // the state being replaced stays recoverable
      db.prepare(`UPDATE documents SET title = ?, content = ?, version = version + 1, updated_at = ?, last_editor_id = ?
        WHERE id = ?`).run(v.title, v.content, nowIso(), req.user!.id, doc.id);
    })();
    const saved = docById.get(doc.id) as DocumentRow;
    publish(doc.id, { type: 'saved', version: saved.version, by: publicUser(req.user!) });
    res.json({ document: serializeDoc(saved, role) });
  });

  // --- comments (anyone with access may comment; resolving needs edit rights or authorship) ---
  const listComments = (docId: string) => (db.prepare(`
    SELECT c.id, c.body, c.quote, c.resolved, c.created_at AS createdAt,
      u.id AS authorId, u.name AS authorName, u.color AS authorColor
    FROM comments c JOIN users u ON u.id = c.author_id
    WHERE c.document_id = ? ORDER BY c.created_at, c.rowid`).all(docId) as Array<{ resolved: number }>)
    .map((c) => ({ ...c, resolved: !!c.resolved }));

  const loadComment = (docId: string, commentId: string) => {
    const c = db.prepare('SELECT * FROM comments WHERE id = ? AND document_id = ?').get(commentId, docId) as
      | { id: string; author_id: string } | undefined;
    if (!c) throw new HttpError(404, 'Comment not found');
    return c;
  };

  app.get('/api/documents/:id/comments', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'viewer');
    res.json({ comments: listComments(doc.id) });
  });

  app.post('/api/documents/:id/comments', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'viewer');
    const { body, quote } = parse(commentSchema, req.body);
    db.prepare('INSERT INTO comments (id, document_id, author_id, body, quote, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(randomUUID(), doc.id, req.user!.id, body, quote, nowIso());
    publish(doc.id, { type: 'comments' });
    res.status(201).json({ comments: listComments(doc.id) });
  });

  app.patch('/api/documents/:id/comments/:commentId', requireUser, (req, res) => {
    const { doc, role } = loadDoc(req, 'viewer');
    const comment = loadComment(doc.id, String(req.params.commentId));
    if (role === 'viewer' && comment.author_id !== req.user!.id) {
      throw new HttpError(403, 'Only editors or the comment author can resolve this');
    }
    const { resolved } = parse(resolveSchema, req.body);
    db.prepare('UPDATE comments SET resolved = ? WHERE id = ?').run(resolved ? 1 : 0, comment.id);
    publish(doc.id, { type: 'comments' });
    res.json({ comments: listComments(doc.id) });
  });

  app.delete('/api/documents/:id/comments/:commentId', requireUser, (req, res) => {
    const { doc, role } = loadDoc(req, 'viewer');
    const comment = loadComment(doc.id, String(req.params.commentId));
    if (role !== 'owner' && comment.author_id !== req.user!.id) {
      throw new HttpError(403, 'Only the document owner or the comment author can delete this');
    }
    db.prepare('DELETE FROM comments WHERE id = ?').run(comment.id);
    publish(doc.id, { type: 'comments' });
    res.json({ comments: listComments(doc.id) });
  });

  // --- realtime: Server-Sent Events for presence, saves, comments and access changes ---
  app.get('/api/documents/:id/events', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'viewer');
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    const leave = hub.join(doc.id, publicUser(req.user!), {
      send: (event) => res.write(`data: ${JSON.stringify(event)}\n\n`),
      close: () => res.end(),
    });
    const heartbeat = setInterval(() => res.write(': ping\n\n'), 25_000);
    req.on('close', () => { clearInterval(heartbeat); leave(); });
  });

  app.post('/api/documents/:id/activity', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'editor');
    publish(doc.id, { type: 'activity', user: publicUser(req.user!) });
    res.status(204).end();
  });

  app.use('/api', (_req, _res, next) => next(new HttpError(404, 'Not found')));
  app.use(errorHandler);

  return app;
}

/** JSON error handler for all API routes. */
export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message, ...(err.details as object | undefined) });
    return;
  }
  const e = err as { code?: string; type?: string };
  if (e?.code === 'LIMIT_FILE_SIZE') {
    res.status(413).json({ error: `File is too large (max ${MAX_UPLOAD_BYTES / 1024 / 1024} MB)` });
    return;
  }
  if (e?.type === 'entity.parse.failed') { res.status(400).json({ error: 'Malformed JSON' }); return; }
  if (e?.type === 'entity.too.large') { res.status(413).json({ error: 'Request is too large' }); return; }
  console.error(err);
  res.status(500).json({ error: 'Something went wrong' });
}

export { SUPPORTED_EXTENSIONS };
