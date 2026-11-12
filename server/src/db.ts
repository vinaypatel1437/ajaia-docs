import Database from 'better-sqlite3';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type DB = Database.Database;
export type Role = 'owner' | 'editor' | 'viewer';

export interface UserRow { id: string; email: string; name: string; color: string }
export interface DocumentRow {
  id: string; owner_id: string; title: string; content: string;
  version: number; created_at: string; updated_at: string; last_editor_id: string | null;
}

/** Demo accounts. Auth is mocked: picking one of these "logs you in". */
export const SEED_USERS: Omit<UserRow, 'id'>[] = [
  { email: 'alice@ajaia.dev', name: 'Alice Chen', color: '#6366f1' },
  { email: 'bob@ajaia.dev', name: 'Bob Okafor', color: '#10b981' },
  { email: 'carol@ajaia.dev', name: 'Carol Diaz', color: '#f59e0b' },
];

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id TEXT PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT NOT NULL,
  color TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  owner_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title TEXT NOT NULL,
  content TEXT NOT NULL DEFAULT '',
  version INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_owner ON documents(owner_id);
CREATE TABLE IF NOT EXISTS document_shares (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_shares_user ON document_shares(user_id);
CREATE TABLE IF NOT EXISTS document_versions (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  version INTEGER NOT NULL,
  title TEXT NOT NULL,
  content TEXT NOT NULL,
  author_id TEXT REFERENCES users(id) ON DELETE SET NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_versions_doc ON document_versions(document_id, created_at);
CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  author_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  body TEXT NOT NULL,
  quote TEXT,
  resolved INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_comments_doc ON comments(document_id, created_at);
`;

/** Additive column migrations for databases created by earlier builds. */
function migrate(db: DB) {
  const cols = (db.prepare('PRAGMA table_info(documents)').all() as { name: string }[]).map((c) => c.name);
  if (!cols.includes('last_editor_id')) {
    db.exec('ALTER TABLE documents ADD COLUMN last_editor_id TEXT REFERENCES users(id) ON DELETE SET NULL');
    db.exec('UPDATE documents SET last_editor_id = owner_id');
  }
}

export function openDb(file: string): DB {
  if (file !== ':memory:') fs.mkdirSync(path.dirname(file), { recursive: true });
  const db = new Database(file);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA);
  migrate(db);
  seed(db);
  return db;
}

const WELCOME_HTML = `<h1>Welcome to Ajaia Docs</h1>
<p>This document is owned by <strong>Alice</strong> and shared with <strong>Bob</strong> as an <em>editor</em>.</p>
<h2>Try these</h2>
<ul>
<li>Format text with <strong>bold</strong>, <em>italic</em> and <u>underline</u></li>
<li>Use headings and lists from the toolbar</li>
<li>Import a <code>.txt</code>, <code>.md</code> or <code>.docx</code> file from the home screen</li>
</ul>
<ol><li>Switch user (top right) to see the shared view</li><li>Open the Share dialog to grant access</li></ol>`;

function seed(db: DB) {
  const count = (db.prepare('SELECT COUNT(*) AS n FROM users').get() as { n: number }).n;
  if (count > 0) return;
  const now = new Date().toISOString();
  const insertUser = db.prepare('INSERT INTO users (id, email, name, color) VALUES (?, ?, ?, ?)');
  const ids = SEED_USERS.map((u) => {
    const id = randomUUID();
    insertUser.run(id, u.email, u.name, u.color);
    return id;
  });
  const docId = randomUUID();
  db.prepare(
    'INSERT INTO documents (id, owner_id, title, content, version, created_at, updated_at, last_editor_id) VALUES (?, ?, ?, ?, 1, ?, ?, ?)',
  ).run(docId, ids[0], 'Welcome to Ajaia Docs', WELCOME_HTML, now, now, ids[0]);
  db.prepare('INSERT INTO comments (id, document_id, author_id, body, quote, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(randomUUID(), docId, ids[1], 'Should we add a section on keyboard shortcuts?', 'Try these', now);
  db.prepare('INSERT INTO document_shares (document_id, user_id, role, created_at) VALUES (?, ?, ?, ?)')
    .run(docId, ids[1], 'editor', now);
}

/** Single source of truth for access checks. */
export function getRole(db: DB, documentId: string, userId: string): Role | null {
  const doc = db.prepare('SELECT owner_id FROM documents WHERE id = ?').get(documentId) as
    | { owner_id: string } | undefined;
  if (!doc) return null;
  if (doc.owner_id === userId) return 'owner';
  const share = db.prepare('SELECT role FROM document_shares WHERE document_id = ? AND user_id = ?')
    .get(documentId, userId) as { role: Role } | undefined;
  return share?.role ?? null;
}
