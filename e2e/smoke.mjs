import { chromium } from 'playwright-core';
// Browser smoke test of the main user flows. Requires a running server and a local Chrome:
//   npm run build && npm start   (in another terminal; use a fresh DATABASE_FILE)
//   npm run e2e
// Set E2E_BASE to target another URL, E2E_SHOTS to a directory to save screenshots.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
const BASE = process.env.E2E_BASE ?? 'http://localhost:3001';
const OUT = process.env.E2E_SHOTS;
if (OUT) fs.mkdirSync(OUT, { recursive: true });
const here = path.dirname(fileURLToPath(import.meta.url));
const browser = await chromium.launch({ channel: 'chrome' });
const errors = [];
const mk = async () => { const c = await browser.newContext({ viewport: { width: 1280, height: 860 }, acceptDownloads: true }); const p = await c.newPage(); p.on('pageerror', e => errors.push(e.message)); p.on('console', m => m.type()==='error' && errors.push(m.text())); return p; };
const login = async (p, name) => { await p.goto(BASE); await p.locator('.user-option', { hasText: `${name.toLowerCase()}@ajaia.dev` }).click(); await p.locator('.home-hero h1').waitFor(); };

const alice = await mk();
await alice.goto(BASE); if (OUT) await alice.screenshot({ path: `${OUT}/01-login.png` });
await login(alice, 'Alice');
if (OUT) await alice.screenshot({ path: `${OUT}/02-home-alice.png` });

// Create + rename + format
await alice.getByRole('button', { name: 'New document' }).click();
await alice.locator('.ProseMirror').waitFor();
await alice.getByLabel('Document title').fill('Launch plan');
await alice.locator('.ProseMirror').click();
await alice.getByLabel('Text style').selectOption('h1');
await alice.keyboard.type('Launch plan');
await alice.keyboard.press('Enter');
await alice.keyboard.press('Meta+b'); await alice.keyboard.type('Bold goal'); await alice.keyboard.press('Meta+b');
await alice.keyboard.type(' then '); await alice.keyboard.press('Meta+u'); await alice.keyboard.type('underlined'); await alice.keyboard.press('Meta+u');
await alice.keyboard.press('Enter');
await alice.getByRole('button', { name: 'Bulleted list' }).click();
await alice.keyboard.type('First item'); await alice.keyboard.press('Enter'); await alice.keyboard.type('Second item');
await alice.getByText(/^Saved/).waitFor({ timeout: 5000 });
const docUrl = alice.url();
await alice.reload(); await alice.locator('.ProseMirror h1').waitFor();
const html = await alice.locator('.ProseMirror').innerHTML();
for (const t of ['<h1', '<strong', '<u>', '<ul']) assert.ok(html.includes(t), `formatting lost after reload: ${t}`);
assert.equal(await alice.getByLabel('Document title').inputValue(), 'Launch plan');
if (OUT) await alice.screenshot({ path: `${OUT}/03-editor.png` });

// Share with Bob as viewer
await alice.getByRole('button', { name: 'Share' }).click();
await alice.getByLabel('Email to share with').fill('bob@ajaia.dev');
await alice.getByLabel('Access level').selectOption('viewer');
await alice.getByRole('button', { name: 'Share', exact: true }).last().click();
await alice.getByText('Bob Okafor').waitFor();
if (OUT) await alice.screenshot({ path: `${OUT}/04-share-dialog.png` });
await alice.keyboard.press('Escape');

// Bob sees it as shared, view only
const bob = await mk();
await login(bob, 'Bob');
await bob.getByText('Launch plan').waitFor();
if (OUT) await bob.screenshot({ path: `${OUT}/05-home-bob-shared.png` });
await bob.getByText('Launch plan').click();
await bob.getByText(/view-only access/).waitFor();
assert.equal(await bob.locator('.ProseMirror').getAttribute('contenteditable'), 'false');
if (OUT) await bob.screenshot({ path: `${OUT}/06-bob-viewonly.png` });

// Upgrade to editor; Bob edits; Alice picks it up via polling
await alice.getByRole('button', { name: 'Share' }).click();
await alice.getByLabel('Access for Bob Okafor').selectOption('editor');
await alice.waitForTimeout(500); await alice.keyboard.press('Escape');
await bob.reload(); await bob.locator('.ProseMirror').waitFor();
assert.equal(await bob.locator('.ProseMirror').getAttribute('contenteditable'), 'true');
await bob.locator('.ProseMirror p').first().click(); await bob.keyboard.press('End'); await bob.keyboard.type(' (Bob was here)');
await bob.getByText(/^Saved/).waitFor({ timeout: 5000 });
// Live sync over SSE: well under the 30s fallback poll.
await alice.getByText('(Bob was here)').waitFor({ timeout: 4000 });
// Presence: Alice sees Bob in the document.
await alice.locator('.presence-avatar[title^="Bob Okafor"]').waitFor({ timeout: 4000 });

// Comments: Bob comments on a selection; Alice's comment count updates live.
await bob.locator('.ProseMirror strong').first().click({ position: { x: 1, y: 8 } });
await bob.keyboard.press('Home');
for (let i = 0; i < 'Bold goal'.length; i++) await bob.keyboard.press('Shift+ArrowRight');
await bob.getByRole('button', { name: 'Comments' }).click();
await bob.locator('.comment-form .quote').waitFor();
await bob.getByRole('textbox', { name: 'Comment' }).fill('Can we make this goal more specific?');
await bob.getByRole('button', { name: 'Comment', exact: true }).click();
await bob.locator('.comment-body', { hasText: 'more specific' }).waitFor();
await alice.getByRole('button', { name: 'Comments (1)' }).waitFor({ timeout: 4000 });
await alice.getByRole('button', { name: 'Comments (1)' }).click();
await alice.locator('.comment button.quote').first().click(); // jump to the quoted text
if (OUT) await alice.screenshot({ path: `${OUT}/08-comments.png` });
await alice.getByRole('button', { name: 'Resolve' }).click();
await alice.getByRole('button', { name: 'Comments', exact: true }).waitFor();

// History: restore Alice's version from before Bob's edit; Bob receives it live.
await alice.getByRole('button', { name: 'History' }).click();
await alice.locator('.version-list li').nth(1).locator('button').click();
await alice.getByText(/Viewing the version from/).waitFor();
if (OUT) await alice.screenshot({ path: `${OUT}/09-history.png` });
await alice.getByRole('button', { name: 'Restore this version' }).click();
await alice.getByText('Version restored').waitFor();
assert.equal(await alice.locator('.ProseMirror').getByText('(Bob was here)').count(), 0);
await bob.waitForFunction(() => !document.querySelector('.ProseMirror')?.textContent?.includes('(Bob was here)'), null, { timeout: 4000 });

// PDF export downloads a generated .pdf file.
await alice.getByRole('button', { name: 'Export' }).click();
const [download] = await Promise.all([
  alice.waitForEvent('download'),
  alice.getByRole('menuitem', { name: /PDF/ }).click(),
]);
assert.equal(download.suggestedFilename(), 'Launch plan.pdf');
const pdfHead = fs.readFileSync(await download.path()).subarray(0, 5).toString();
assert.equal(pdfHead, '%PDF-');

// Revoking access is reflected immediately for Bob. (His re-check gets an expected 404.)
const errorsBeforeRevoke = errors.length;
await alice.getByRole('button', { name: 'Share' }).click();
await alice.getByRole('button', { name: 'Remove' }).click();
await alice.getByText('Not shared with anyone yet.').waitFor();
await alice.keyboard.press('Escape');
await bob.getByText('Your access to this document was removed').waitFor({ timeout: 4000 });


// Import markdown
await alice.goto(BASE);
await alice.locator('input[type=file]').setInputFiles(`${here}/sprint.md`);
await alice.locator('.ProseMirror h1').waitFor();
assert.equal(await alice.getByLabel('Document title').inputValue(), 'sprint');
if (OUT) await alice.screenshot({ path: `${OUT}/07-imported.png` });
// Unsupported file
await alice.goto(BASE);
await alice.locator('input[type=file]').setInputFiles({ name: 'x.pdf', mimeType: 'application/pdf', buffer: Buffer.from('%PDF') });
assert.match(await alice.getByRole('alert').textContent(), /supported file/);
await browser.close();
const unexpected = errors.filter((e, i) => i < errorsBeforeRevoke || !/404/.test(e));
assert.deepEqual(unexpected, [], 'browser console errors');
console.log('e2e smoke: all flows passed');
