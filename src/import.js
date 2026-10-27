import { transaction } from './db.js';
import { NODE_TYPES, CONFIDENCE, RELATIONS, canonicalIndicator, indicatorKind } from './model.js';

const str = (v) => typeof v === 'string' && v.trim() !== '';

export function validateDataset(ds) {
  const errors = [];
  if (!ds || typeof ds !== 'object' || !Array.isArray(ds.nodes) || !Array.isArray(ds.edges)) {
    return ['dataset must be an object with "nodes" and "edges" arrays'];
  }
  const types = new Map();
  ds.nodes.forEach((n, i) => {
    const at = `nodes[${i}]`;
    if (!n || !str(n.id)) return errors.push(`${at}: missing id`);
    if (types.has(n.id)) errors.push(`${at}: duplicate id ${n.id}`);
    if (!NODE_TYPES.includes(n.type)) errors.push(`${at} (${n.id}): unknown type ${n.type}`);
    if (!str(n.name)) errors.push(`${at} (${n.id}): missing name`);
    if (n.first_seen != null && Number.isNaN(Date.parse(n.first_seen))) {
      errors.push(`${at} (${n.id}): bad first_seen`);
    }
    types.set(n.id, n.type);
  });
  ds.edges.forEach((e, i) => {
    const at = `edges[${i}]`;
    if (!e || typeof e !== 'object') return errors.push(`${at}: not an object`);
    const rule = RELATIONS[e.rel];
    if (!rule) errors.push(`${at}: unknown relation ${e.rel}`);
    if (!types.has(e.src)) errors.push(`${at}: unknown src ${e.src}`);
    if (!types.has(e.dst)) errors.push(`${at}: unknown dst ${e.dst}`);
    if (e.src === e.dst) errors.push(`${at}: self edge`);
    if (rule && types.has(e.src) && types.has(e.dst)) {
      if (!rule.from.includes(types.get(e.src)) || !rule.to.includes(types.get(e.dst))) {
        errors.push(`${at}: ${e.rel} not allowed from ${types.get(e.src)} to ${types.get(e.dst)}`);
      }
    }
    if (!str(e.source)) errors.push(`${at}: missing source`);
    if (!str(e.ts) || Number.isNaN(Date.parse(e.ts))) errors.push(`${at}: missing or bad ts`);
    if (!(e.confidence in CONFIDENCE)) errors.push(`${at}: confidence must be low, medium or high`);
    if (e.rel === 'attributed-to' && !str(e.evidence)) {
      errors.push(`${at}: attributed-to needs evidence text`);
    }
  });
  return errors;
}

export function importDataset(db, ds) {
  const errors = validateDataset(ds);
  if (errors.length) return { ok: false, errors };

  const upsert = db.prepare(`
    INSERT INTO nodes (id, type, name, kind, canon, summary, first_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET type = excluded.type, name = excluded.name, kind = excluded.kind,
      canon = excluded.canon, summary = excluded.summary, first_seen = excluded.first_seen`);
  const insEdge = db.prepare(`
    INSERT OR IGNORE INTO edges (src, dst, rel, source, ts, confidence, alt, evidence)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);

  let edgesAdded = 0;
  transaction(db, () => {
    for (const n of ds.nodes) {
      const isInd = n.type === 'indicator';
      upsert.run(
        n.id, n.type, n.name,
        isInd ? indicatorKind(n.name) : null,
        isInd ? canonicalIndicator(n.name) : null,
        n.summary ?? null,
        n.first_seen ? new Date(n.first_seen).toISOString() : null,
      );
    }
    for (const e of ds.edges) {
      const r = insEdge.run(
        e.src, e.dst, e.rel, e.source.trim(), new Date(e.ts).toISOString(),
        e.confidence, e.alt ?? null, e.evidence ?? null,
      );
      edgesAdded += Number(r.changes);
    }
  });
  return { ok: true, nodes: ds.nodes.length, edgesAdded, edgesSkipped: ds.edges.length - edgesAdded };
}
