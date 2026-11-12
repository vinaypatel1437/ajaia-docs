import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createApp } from '../src/app.js';
import { makeDocx } from './docx.js';

type Agent = ReturnType<typeof request.agent>;
let app: ReturnType<typeof createApp>;

async function login(email: string): Promise<Agent> {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email }).expect(200);
  return agent;
}

beforeEach(() => {
  app = createApp({ db: openDb(':memory:'), cookieSecret: 'test' });
});

describe('auth', () => {
  it('rejects unauthenticated access and unknown accounts', async () => {
    await request(app).get('/api/documents').expect(401);
    await request(app).post('/api/auth/login').send({ email: 'mallory@evil.dev' }).expect(401);
  });
});

describe('documents', () => {
  it('creates, renames, edits and reopens a document with formatting preserved', async () => {
    const alice = await login('alice@ajaia.dev');
    const created = await alice.post('/api/documents').send({}).expect(201);
    const { id, version } = created.body.document;
    expect(created.body.document.title).toBe('Untitled document');

    const html = '<h2>Plan</h2><p><strong>bold</strong> <em>it</em> <u>u</u></p><ul><li>one</li></ul>';
    const saved = await alice.patch(`/api/documents/${id}`)
      .send({ title: '  Q3 plan ', content: html, version }).expect(200);
    expect(saved.body.document.version).toBe(version + 1);

    const reopened = await alice.get(`/api/documents/${id}`).expect(200);
    expect(reopened.body.document.title).toBe('Q3 plan');
    expect(reopened.body.document.content).toBe(html);

    const list = await alice.get('/api/documents').expect(200);
    expect(list.body.owned.map((d: { id: string }) => d.id)).toContain(id);
  });

  it('strips unsafe HTML before persisting', async () => {
    const alice = await login('alice@ajaia.dev');
    const res = await alice.post('/api/documents')
      .send({ content: '<p onclick="x()">hi<script>alert(1)</script><img src=x onerror=alert(1)></p>' }).expect(201);
    expect(res.body.document.content).toBe('<p>hi</p>');
  });

  it('validates input', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body } = await alice.post('/api/documents').send({}).expect(201);
    const res = await alice.patch(`/api/documents/${body.document.id}`)
      .send({ title: '   ', version: 1 }).expect(400);
    expect(res.body.error).toMatch(/empty/i);
  });

  it('rejects stale saves with 409 instead of overwriting', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body } = await alice.post('/api/documents').send({}).expect(201);
    const id = body.document.id;
    await alice.patch(`/api/documents/${id}`).send({ content: '<p>first</p>', version: 1 }).expect(200);
    const stale = await alice.patch(`/api/documents/${id}`).send({ content: '<p>stale</p>', version: 1 }).expect(409);
    expect(stale.body.document.content).toBe('<p>first</p>');
  });
});

describe('sharing', () => {
  it('enforces owner / editor / viewer access end to end', async () => {
    const alice = await login('alice@ajaia.dev');
    const bob = await login('bob@ajaia.dev');
    const { body } = await alice.post('/api/documents').send({ title: 'Secret' }).expect(201);
    const id = body.document.id;

    // No access: indistinguishable from a missing document.
    await bob.get(`/api/documents/${id}`).expect(404);

    // Viewer: can read, cannot edit or re-share.
    await alice.post(`/api/documents/${id}/shares`).send({ email: 'BOB@ajaia.dev', role: 'viewer' }).expect(201);
    const shared = await bob.get('/api/documents').expect(200);
    expect(shared.body.shared).toContainEqual(expect.objectContaining({ id, role: 'viewer', ownerName: 'Alice Chen' }));
    expect(shared.body.owned.find((d: { id: string }) => d.id === id)).toBeUndefined();
    expect((await bob.get(`/api/documents/${id}`).expect(200)).body.document.role).toBe('viewer');
    await bob.patch(`/api/documents/${id}`).send({ content: '<p>hack</p>', version: 1 }).expect(403);
    await bob.post(`/api/documents/${id}/shares`).send({ email: 'carol@ajaia.dev' }).expect(403);

    // Editor: can edit, still cannot delete.
    await alice.post(`/api/documents/${id}/shares`).send({ email: 'bob@ajaia.dev', role: 'editor' }).expect(201);
    await bob.patch(`/api/documents/${id}`).send({ content: '<p>edit</p>', version: 1 }).expect(200);
    await bob.delete(`/api/documents/${id}`).expect(403);

    // Revoke.
    const bobId = (await bob.get('/api/me')).body.user.id;
    await alice.delete(`/api/documents/${id}/shares/${bobId}`).expect(200);
    await bob.get(`/api/documents/${id}`).expect(404);
  });

  it('rejects sharing with unknown users or the owner', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body } = await alice.post('/api/documents').send({}).expect(201);
    await alice.post(`/api/documents/${body.document.id}/shares`).send({ email: 'nobody@ajaia.dev' }).expect(404);
    await alice.post(`/api/documents/${body.document.id}/shares`).send({ email: 'alice@ajaia.dev' }).expect(400);
    await alice.post(`/api/documents/${body.document.id}/shares`).send({ email: 'not-an-email' }).expect(400);
  });
});

describe('file import and export', () => {
  it('turns a markdown upload into an editable document', async () => {
    const alice = await login('alice@ajaia.dev');
    const md = '# Launch notes\n\nShip **fast**, _carefully_.\n\n- one\n- two\n';
    const res = await alice.post('/api/documents/import')
      .attach('file', Buffer.from(md), 'launch-notes.md').expect(201);
    expect(res.body.document.title).toBe('launch-notes');
    expect(res.body.document.content).toContain('<h1>Launch notes</h1>');
    expect(res.body.document.content).toContain('<strong>fast</strong>');
    expect(res.body.document.content).toContain('<li>one</li>');
  });

  it('converts a .docx upload, keeping headings and bold', async () => {
    const alice = await login('alice@ajaia.dev');
    const res = await alice.post('/api/documents/import')
      .attach('file', await makeDocx(), 'Quarterly Review.docx').expect(201);
    expect(res.body.document.title).toBe('Quarterly Review');
    expect(res.body.document.content).toBe('<h1>Quarterly review</h1><p><strong>Revenue</strong> grew.</p>');
  });

  it('escapes plain text and keeps paragraphs', async () => {
    const alice = await login('alice@ajaia.dev');
    const res = await alice.post('/api/documents/import')
      .attach('file', Buffer.from('a <b> c\n\nsecond'), 'notes.txt').expect(201);
    expect(res.body.document.content).toBe('<p>a &lt;b&gt; c</p><p>second</p>');
  });

  it('rejects unsupported file types with a clear message', async () => {
    const alice = await login('alice@ajaia.dev');
    const res = await alice.post('/api/documents/import')
      .attach('file', Buffer.from('%PDF'), 'report.pdf').expect(415);
    expect(res.body.error).toMatch(/\.txt, \.md or \.docx/);
  });

  it('exports markdown', async () => {
    const alice = await login('alice@ajaia.dev');
    const { body } = await alice.post('/api/documents')
      .send({ title: 'Export me', content: '<h2>Hi</h2><ul><li>x</li></ul>' }).expect(201);
    const res = await alice.get(`/api/documents/${body.document.id}/export.md`).expect(200);
    expect(res.text).toContain('# Export me');
    expect(res.text).toContain('## Hi');
    expect(res.text).toMatch(/-\s+x/);
  });
});
