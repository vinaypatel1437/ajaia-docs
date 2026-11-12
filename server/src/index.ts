import express from 'express';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { createApp } from './app.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const isProd = process.env.NODE_ENV === 'production';
const port = Number(process.env.PORT ?? 3001);
const dbFile = process.env.DATABASE_FILE ?? path.join(root, 'data', 'ajaia.db');
const cookieSecret = process.env.COOKIE_SECRET ?? 'dev-only-secret-change-me';
if (isProd && !process.env.COOKIE_SECRET) console.warn('[warn] COOKIE_SECRET not set; using an insecure default');

const db = openDb(dbFile);
const app = createApp({ db, cookieSecret, secureCookies: isProd && process.env.INSECURE_COOKIES !== '1' });
if (isProd) app.set('trust proxy', 1);

const clientDir = path.join(root, 'dist', 'client');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir));
  app.get('/{*splat}', (_req, res) => res.sendFile(path.join(clientDir, 'index.html')));
}

app.listen(port, () => console.log(`Ajaia Docs listening on http://localhost:${port} (db: ${dbFile})`));
