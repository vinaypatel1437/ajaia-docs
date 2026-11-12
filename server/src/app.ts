import express, { type NextFunction, type Request, type Response } from 'express';
import cookieParser from 'cookie-parser';
import multer from 'multer';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { getRole, type DB, type DocumentRow, type Role, type UserRow } from './db.js';
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

function parse<T>(schema: z.ZodType<T>, body: unknown): T {
  const result = schema.safeParse(body);
  if (!result.success) throw new HttpError(400, result.error.issues[0]?.message ?? 'Invalid request');
  return result.data;
}

export interface AppOptions { db: DB; cookieSecret: string; secureCookies?: boolean }

export function createApp({ db, cookieSecret, secureCookies = false }: AppOptions) {
  const app = express();
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

  app.get('/api/me', requireUser, (req, res) => { res.json({ user: req.user }); });

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
    const now = new Date().toISOString();
    db.prepare(
      'INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at) VALUES (?, ?, ?, ?, 1, ?, ?)',
    ).run(id, ownerId, title, content, now, now);
    return docById.get(id) as DocumentRow;
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
    const now = new Date().toISOString();
    const result = db.prepare(`
      UPDATE documents SET title = ?, content = ?, version = version + 1, updated_at = ?
      WHERE id = ? AND version = ?`).run(
      body.title ?? doc.title,
      body.content !== undefined ? cleanHtml(body.content) : doc.content,
      now, doc.id, doc.version,
    );
    if (result.changes === 0) throw new HttpError(409, 'This document was changed by someone else.');
    res.json({ document: serializeDoc(docById.get(doc.id) as DocumentRow, role) });
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
      .run(doc.id, target.id, role, new Date().toISOString());
    res.status(201).json({ shares: listShares(doc.id) });
  });

  app.delete('/api/documents/:id/shares/:userId', requireUser, (req, res) => {
    const { doc } = loadDoc(req, 'owner');
    db.prepare('DELETE FROM document_shares WHERE document_id = ? AND user_id = ?').run(doc.id, req.params.userId);
    res.json({ shares: listShares(doc.id) });
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
