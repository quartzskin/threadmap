import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readFileSync } from 'node:fs';
import { openDb } from '../src/db.js';
import { importDataset, validateDataset } from '../src/import.js';
import { canonicalIndicator, indicatorKind } from '../src/model.js';
import { getGraph, getNode, search, duplicates, mergeIndicators, link } from '../src/graph.js';
import { createServer } from '../src/server.js';

const sample = () => JSON.parse(readFileSync(new URL('../data/sample.json', import.meta.url), 'utf8'));

function loaded() {
  const db = openDb();
  const out = importDataset(db, sample());
  assert.equal(out.ok, true);
  return db;
}

const node = (id, type, name) => ({ id, type, name });
const edge = (o) => ({ rel: 'uses', source: 'r', ts: '2024-01-01', confidence: 'high', ...o });

test('canonicalisation folds defanging, case and zero-padding', () => {
  assert.equal(canonicalIndicator('Evil[.]Example.'), 'evil.example');
  assert.equal(canonicalIndicator('203.0.113.014'), '203.0.113.14');
  assert.equal(canonicalIndicator('hxxps://A.example/x/'), 'https://a.example/x');
  assert.equal(indicatorKind('d41d8cd98f00b204e9800998ecf8427e'), 'md5');
  assert.equal(indicatorKind('not an indicator'), 'other');
});

test('sample dataset imports and re-import adds nothing', () => {
  const db = loaded();
  const g = getGraph(db);
  assert.equal(g.nodes.length, 35);
  assert.equal(g.edges.length, 40);
  const again = importDataset(db, sample());
  assert.equal(again.edgesAdded, 0);
  assert.equal(getGraph(db).edges.length, 40);
});

test('validation rejects malformed input', () => {
  assert.ok(validateDataset(null).length);
  assert.ok(validateDataset({ nodes: [], edges: 'x' }).length);
  const nodes = [node('a', 'campaign', 'A'), node('b', 'actor', 'B'), node('c', 'indicator', 'x.example')];
  const cases = [
    edge({ src: 'a', dst: 'b', rel: 'attributed-to' }),
    edge({ src: 'a', dst: 'zzz' }),
    edge({ src: 'c', dst: 'b', rel: 'uses' }),
    edge({ src: 'a', dst: 'b', rel: 'attributed-to', evidence: 'x', confidence: 'certain' }),
    edge({ src: 'a', dst: 'b', rel: 'attributed-to', evidence: 'x', source: '' }),
    edge({ src: 'a', dst: 'b', rel: 'attributed-to', evidence: 'x', ts: 'yesterday' }),
  ];
  for (const bad of cases) {
    assert.ok(validateDataset({ nodes, edges: [bad] }).length > 0, JSON.stringify(bad));
  }
  const ok = edge({ src: 'a', dst: 'b', rel: 'attributed-to', evidence: 'cert reuse' });
  assert.deepEqual(validateDataset({ nodes, edges: [ok] }), []);
});

test('a rejected import leaves the database untouched', () => {
  const db = openDb();
  const out = importDataset(db, { nodes: [node('a', 'bogus', 'A')], edges: [] });
  assert.equal(out.ok, false);
  assert.equal(getGraph(db).nodes.length, 0);
});

test('duplicates are grouped by canonical value and merge rewires edges', () => {
  const db = loaded();
  const groups = duplicates(db);
  const quill = groups.find((g) => g.members.some((m) => m.id === 'ind-quill-hash'));
  assert.ok(quill);
  assert.equal(quill.canon, quill.canon.toLowerCase());
  assert.deepEqual(groups.map((g) => g.canon).sort(), [
    '203.0.113.14',
    quill.canon,
    'update-cdn.saltmarsh-docs.example',
  ].sort());
  assert.ok(groups.every((g) => g.members.length === 2));

  mergeIndicators(db, 'ind-salt-ip', 'ind-salt-ip-b');
  const n = getNode(db, 'ind-salt-ip');
  assert.deepEqual(n.node.aliases, ['203.0.113.014']);
  assert.ok(n.edges.some((e) => e.dst === 'mal-brackenrat'));
  assert.equal(getNode(db, 'ind-salt-ip-b'), null);
  assert.equal(duplicates(db).length, 2);
});

test('merge refuses unrelated nodes', () => {
  const db = loaded();
  assert.throws(() => mergeIndicators(db, 'ind-salt-ip', 'ind-paper-ip'));
  assert.throws(() => mergeIndicators(db, 'mal-quillwisp', 'mal-brackenrat'));
});

test('search matches names, canonical values and escapes wildcards', () => {
  const db = loaded();
  assert.ok(search(db, 'quillwisp').some((r) => r.id === 'mal-quillwisp'));
  assert.ok(search(db, 'saltmarsh-docs').some((r) => r.type === 'indicator'));
  assert.equal(search(db, '%').length, 0);
  assert.equal(search(db, '').length, 0);
});

test('shared attribution is reported only through attributed-to edges', () => {
  const db = loaded();
  const r = link(db, 'camp-saltmarsh', 'camp-paperkite');
  assert.equal(r.sharedActors.length, 1);
  assert.equal(r.sharedActors[0].actor, 'VIOLET HERON');
  assert.equal(r.sharedActors[0].minConfidence, 2);
  assert.equal(r.weakOnly, false);
});

test('a shared tool alone does not imply a shared operator', () => {
  const db = loaded();
  const r = link(db, 'ind-quill-hash', 'ind-paper-url');
  assert.equal(r.connected, true);
  assert.equal(r.sharedActors.length, 0);
  assert.match(r.verdict, /does not show a shared operator/);
});

test('links that need weak edges are flagged', () => {
  const db = loaded();
  const r = link(db, 'ind-cinder-ip', 'ind-salt-ip');
  assert.equal(r.connected, true);
  assert.equal(r.weakOnly, false, 'a strong route exists through the attribution edges');

  const weak = link(db, 'mal-mothgrinder', 'camp-saltmarsh');
  assert.equal(weak.sharedActors.length, 0);
  assert.ok(weak.warnings.length > 0);

  const low = link(db, 'camp-cindertide', 'camp-saltmarsh');
  assert.equal(low.sharedActors.length, 1);
  assert.ok(low.warnings.some((w) => /low-confidence/.test(w)));
});

test('weak-only connections set weakOnly', () => {
  const db = openDb();
  importDataset(db, {
    nodes: [node('a', 'indicator', 'a.example'), node('b', 'indicator', 'b.example')],
    edges: [edge({ src: 'a', dst: 'b', rel: 'related-to', confidence: 'medium' })],
  });
  const r = link(db, 'a', 'b');
  assert.equal(r.weakOnly, true);
  assert.match(r.warnings[0], /lead, not a link/);
});

const json = { 'content-type': 'application/json' };

// fetch refuses to set Host/Origin, so use raw http.
function raw(port, method, path, headers, body) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, method, path, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end(body);
  });
}

test('api rejects foreign Host, foreign Origin and non-JSON POSTs', async () => {
  const db = loaded();
  const server = createServer(db).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const { port } = server.address();
  const body = JSON.stringify(sample());
  try {
    assert.equal(await raw(port, 'GET', '/api/graph', { host: `127.0.0.1:${port}` }), 200);
    assert.equal(await raw(port, 'GET', '/api/graph', { host: `localhost:${port}` }), 200);
    assert.equal(await raw(port, 'GET', '/api/graph', { host: 'evil.example' }), 403);
    assert.equal(await raw(port, 'GET', '/api/graph', { host: `evil.example:${port}` }), 403);
    assert.equal(await raw(port, 'POST', '/api/import', { host: 'evil.example', ...json }, body), 403);
    assert.equal(await raw(port, 'GET', '/api/graph', { host: `localhost:${port}`, origin: 'https://evil.example' }), 403);
    assert.equal(await raw(port, 'POST', '/api/merge', { host: `localhost:${port}`, origin: 'http://localhost.evil.example', ...json }, '{}'), 403);
    assert.equal(await raw(port, 'POST', '/api/import', { host: `127.0.0.1:${port}`, origin: `http://127.0.0.1:${port}`, ...json }, body), 200);
    assert.equal(await raw(port, 'POST', '/api/import', { host: `127.0.0.1:${port}`, 'content-type': 'text/plain' }, body), 415);
    assert.equal(await raw(port, 'POST', '/api/merge', { host: `127.0.0.1:${port}` }, '{}'), 415);
  } finally {
    server.close();
  }
});

test('http api serves graph, rejects bad import, and blocks path traversal', async () => {
  const db = loaded();
  const server = createServer(db).listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const g = await (await fetch(`${base}/api/graph`)).json();
    assert.equal(g.nodes.length, 35);

    const bad = await fetch(`${base}/api/import`, { method: 'POST', headers: json, body: '{nope' });
    assert.equal(bad.status, 400);
    const invalid = await fetch(`${base}/api/import`, { method: 'POST', headers: json, body: '{"nodes":[],"edges":[{}]}' });
    assert.equal(invalid.status, 400);

    for (const body of ['null', '[]', '5']) {
      for (const route of ['import', 'merge']) {
        const r = await fetch(`${base}/api/${route}`, { method: 'POST', headers: json, body });
        assert.equal(r.status, 400, `${route} ${body}`);
        assert.doesNotMatch((await r.json()).error, /TypeError|null|undefined|properties/);
      }
    }

    assert.equal((await fetch(`${base}/api/node/nope`)).status, 404);
    assert.equal((await fetch(`${base}/api/link?a=x&b=y`)).status, 404);
    assert.equal((await fetch(`${base}/`)).status, 200);
    assert.equal((await fetch(`${base}/..%2fpackage.json`)).status >= 400, true);
  } finally {
    server.close();
  }
});
