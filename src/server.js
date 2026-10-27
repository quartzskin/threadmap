import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.js';
import { importDataset } from './import.js';
import { getGraph, getNode, search, duplicates, mergeIndicators, link } from './graph.js';

const root = resolve(fileURLToPath(new URL('..', import.meta.url)));
const publicDir = join(root, 'public');
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const MAX_BODY = 2 * 1024 * 1024;
const LOCAL_HOST = /^(127\.0\.0\.1|localhost)(:\d+)?$/i;

// Blocks DNS rebinding (Host) and cross-site requests (Origin, Content-Type).
function guard(req) {
  if (!LOCAL_HOST.test(req.headers.host ?? '')) return [403, 'forbidden host'];
  const origin = req.headers.origin;
  if (origin !== undefined && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) {
    return [403, 'forbidden origin'];
  }
  if (req.method === 'POST' && !/^application\/json\s*(;|$)/i.test(req.headers['content-type'] ?? '')) {
    return [415, 'content-type must be application/json'];
  }
  return null;
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v);
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'content-type': type + (type === 'application/json' ? '; charset=utf-8' : '') });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

async function readJson(req) {
  let size = 0;
  const chunks = [];
  for await (const c of req) {
    size += c.length;
    if (size > MAX_BODY) throw Object.assign(new Error('body too large'), { status: 413 });
    chunks.push(c);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw Object.assign(new Error('invalid JSON'), { status: 400 });
  }
}

export function createServer(db) {
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, 'http://localhost');
    const path = url.pathname;
    try {
      if (path.startsWith('/api/')) {
        const denied = guard(req);
        if (denied) return send(res, denied[0], { error: denied[1] });
        return await api(db, req, res, url);
      }
      if (req.method !== 'GET') return send(res, 405, { error: 'method not allowed' });
      const file = normalize(join(publicDir, path === '/' ? 'index.html' : path));
      if (!file.startsWith(publicDir + sep)) return send(res, 403, { error: 'forbidden' });
      const data = await readFile(file).catch(() => null);
      if (!data) return send(res, 404, { error: 'not found' });
      send(res, 200, data, MIME[extname(file)] ?? 'application/octet-stream');
    } catch (err) {
      send(res, err.status ?? 500, { error: err.message });
    }
  });
}

async function api(db, req, res, url) {
  const { pathname: path, searchParams: q } = url;
  const get = req.method === 'GET';
  if (get && path === '/api/graph') return send(res, 200, getGraph(db));
  if (get && path.startsWith('/api/node/')) {
    const out = getNode(db, decodeURIComponent(path.slice('/api/node/'.length)));
    return out ? send(res, 200, out) : send(res, 404, { error: 'no such node' });
  }
  if (get && path === '/api/search') return send(res, 200, search(db, q.get('q') ?? ''));
  if (get && path === '/api/duplicates') return send(res, 200, duplicates(db));
  if (get && path === '/api/link') {
    const out = link(db, q.get('a'), q.get('b'));
    return out ? send(res, 200, out) : send(res, 404, { error: 'unknown node' });
  }
  if (req.method === 'POST' && path === '/api/import') {
    const body = await readJson(req);
    if (!isObject(body)) return send(res, 400, { error: 'body must be a JSON object' });
    const out = importDataset(db, body);
    return send(res, out.ok ? 200 : 400, out);
  }
  if (req.method === 'POST' && path === '/api/merge') {
    const body = await readJson(req);
    if (!isObject(body)) return send(res, 400, { error: 'body must be a JSON object' });
    try {
      mergeIndicators(db, body.keep, body.drop);
    } catch (err) {
      return send(res, 400, { error: err.message });
    }
    return send(res, 200, { ok: true });
  }
  return send(res, 404, { error: 'not found' });
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const db = openDb(process.env.THREADMAP_DB ?? join(root, 'threadmap.db'));
  if (db.prepare('SELECT COUNT(*) AS n FROM nodes').get().n === 0) {
    const seed = JSON.parse(readFileSync(join(root, 'data', 'sample.json'), 'utf8'));
    console.log('seeded', importDataset(db, seed));
  }
  const port = Number(process.env.PORT ?? 8787);
  createServer(db).listen(port, '127.0.0.1', () => console.log(`http://127.0.0.1:${port}`));
}
