import { describe, it, expect, beforeEach } from 'vitest';
import request from 'supertest';
import { openDb } from '../src/db.js';
import { createApp, VERSION_SESSION_MS } from '../src/app.js';
import { Hub, type HubEvent } from '../src/realtime.js';

let app: ReturnType<typeof createApp>;
let hub: Hub;
let clock: number;
const tick = (ms: number) => { clock += ms; };

async function login(email: string) {
  const agent = request.agent(app);
  await agent.post('/api/auth/login').send({ email }).expect(200);
  return agent;
}

beforeEach(() => {
  clock = Date.parse('2026-01-01T09:00:00Z');
  hub = new Hub();
  app = createApp({ db: openDb(':memory:'), cookieSecret: 't', hub, now: () => new Date(clock) });
});

describe('version history', () => {
  it('coalesces autosaves into sessions and restores without losing the replaced state', async () => {
    const alice = await login('alice@ajaia.dev');
    const bob = await login('bob@ajaia.dev');
    const { body } = await alice.post('/api/documents').send({ content: '<p>v1</p>' }).expect(201);
    const id = body.document.id;
    await alice.post(`/api/documents/${id}/shares`).send({ email: 'bob@ajaia.dev', role: 'editor' }).expect(201);

    // Alice autosaves three times in quick succession → only the original state is snapshotted.
    let v = 1;
    for (const text of ['a', 'ab', 'abc']) {
      tick(1000);
      v = (await alice.patch(`/api/documents/${id}`).send({ content: `<p>${text}</p>`, version: v }).expect(200)).body.document.version;
    }
    expect((await alice.get(`/api/documents/${id}/versions`)).body.versions).toHaveLength(1);

    // A different editor starts a new history entry (Alice's "abc").
    tick(1000);
    v = (await bob.patch(`/api/documents/${id}`).send({ content: '<p>bob</p>', version: v }).expect(200)).body.document.version;
    // Same editor after the session window → another entry (Bob's "bob").
    tick(VERSION_SESSION_MS + 1);
    v = (await bob.patch(`/api/documents/${id}`).send({ content: '<p>bob later</p>', version: v }).expect(200)).body.document.version;

    const { versions } = (await alice.get(`/api/documents/${id}/versions`)).body;
    expect(versions.map((x: { authorName: string }) => x.authorName)).toEqual(['Bob Okafor', 'Alice Chen', 'Alice Chen']);
    const aliceAbc = versions[1];
    expect((await alice.get(`/api/documents/${id}/versions/${aliceAbc.id}`)).body.version.content).toBe('<p>abc</p>');

    // Restore Alice's version; the replaced "bob later" state becomes a history entry.
    const restored = await alice.post(`/api/documents/${id}/versions/${aliceAbc.id}/restore`).expect(200);
    expect(restored.body.document.content).toBe('<p>abc</p>');
    expect(restored.body.document.version).toBe(v + 1);
    const after = (await alice.get(`/api/documents/${id}/versions`)).body.versions;
    const latest = (await alice.get(`/api/documents/${id}/versions/${after[0].id}`)).body.version;
    expect(latest.content).toBe('<p>bob later</p>');
  });

  it('lets viewers browse history but not restore', async () => {
    const alice = await login('alice@ajaia.dev');
    const carol = await login('carol@ajaia.dev');
    const { body } = await alice.post('/api/documents').send({}).expect(201);
    const id = body.document.id;
    await alice.patch(`/api/documents/${id}`).send({ content: '<p>x</p>', version: 1 }).expect(200);
    await alice.post(`/api/documents/${id}/shares`).send({ email: 'carol@ajaia.dev', role: 'viewer' }).expect(201);
    const { versions } = (await carol.get(`/api/documents/${id}/versions`).expect(200)).body;
    await carol.post(`/api/documents/${id}/versions/${versions[0].id}/restore`).expect(403);
  });
});

describe('comments', () => {
  it('applies comment permissions per role', async () => {
    const alice = await login('alice@ajaia.dev');
    const bob = await login('bob@ajaia.dev');
    const carol = await login('carol@ajaia.dev');
    const { body } = await alice.post('/api/documents').send({}).expect(201);
    const id = body.document.id;
    await carol.get(`/api/documents/${id}/comments`).expect(404); // no access, no comments
    await alice.post(`/api/documents/${id}/shares`).send({ email: 'bob@ajaia.dev', role: 'viewer' }).expect(201);

    // Viewers can comment, with an optional quoted anchor.
    const posted = await bob.post(`/api/documents/${id}/comments`).send({ body: ' Typo here ', quote: 'teh' }).expect(201);
    const c = posted.body.comments[0];
    expect(c).toMatchObject({ body: 'Typo here', quote: 'teh', resolved: false, authorName: 'Bob Okafor' });
    await bob.post(`/api/documents/${id}/comments`).send({ body: '   ' }).expect(400);

    // Owner comments; a viewer can't resolve someone else's comment but can resolve their own.
    const own = (await alice.post(`/api/documents/${id}/comments`).send({ body: 'Fixed?' }).expect(201)).body.comments[1];
    await bob.patch(`/api/documents/${id}/comments/${own.id}`).send({ resolved: true }).expect(403);
    await bob.patch(`/api/documents/${id}/comments/${c.id}`).send({ resolved: true }).expect(200);
    await bob.delete(`/api/documents/${id}/comments/${own.id}`).expect(403);
    const left = await alice.delete(`/api/documents/${id}/comments/${c.id}`).expect(200);
    expect(left.body.comments.map((x: { id: string }) => x.id)).toEqual([own.id]);
  });
});

describe('realtime hub', () => {
  const sink = () => { const events: HubEvent[] = []; return { events, send: (e: HubEvent) => events.push(e), close() {} }; };
  const alice = { id: 'a', name: 'Alice', color: '#000' };
  const bob = { id: 'b', name: 'Bob', color: '#111' };

  it('tracks unique presence per document and notifies on join/leave', () => {
    const s1 = sink();
    const leaveA1 = hub.join('doc', alice, s1);
    const leaveA2 = hub.join('doc', alice, sink()); // second tab
    const leaveB = hub.join('doc', bob, sink());
    hub.join('other', bob, sink());
    expect(hub.presence('doc').map((u) => u.id)).toEqual(['a', 'b']);
    leaveB();
    expect(s1.events.at(-1)).toEqual({ type: 'presence', users: [alice] });
    leaveA1(); leaveA2();
    expect(hub.presence('doc')).toEqual([]);
  });

  it('broadcasts saves to connected collaborators', async () => {
    const a = await login('alice@ajaia.dev');
    const { body } = await a.post('/api/documents').send({}).expect(201);
    const watcher = sink();
    hub.join(body.document.id, bob, watcher);
    await a.patch(`/api/documents/${body.document.id}`).send({ content: '<p>x</p>', version: 1 }).expect(200);
    expect(watcher.events).toContainEqual(expect.objectContaining({ type: 'saved', version: 2, by: expect.objectContaining({ name: 'Alice Chen' }) }));
  });
});
