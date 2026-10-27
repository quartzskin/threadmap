import { transaction } from './db.js';
import { CONFIDENCE, isWeak } from './model.js';

const withWeak = (e) => ({ ...e, weak: isWeak(e) });
const parseNode = (n) => n && { ...n, aliases: JSON.parse(n.aliases) };

export function getGraph(db) {
  const nodes = db.prepare('SELECT * FROM nodes ORDER BY type, name').all().map(parseNode);
  const edges = db.prepare('SELECT * FROM edges ORDER BY id').all().map(withWeak);
  return { nodes, edges };
}

export function getNode(db, id) {
  const node = parseNode(db.prepare('SELECT * FROM nodes WHERE id = ?').get(id));
  if (!node) return null;
  const edges = db.prepare(`
    SELECT e.*, s.name AS src_name, s.type AS src_type, d.name AS dst_name, d.type AS dst_type
    FROM edges e JOIN nodes s ON s.id = e.src JOIN nodes d ON d.id = e.dst
    WHERE e.src = ?1 OR e.dst = ?1 ORDER BY e.ts`).all(id).map(withWeak);
  return { node, edges };
}

export function search(db, q) {
  const term = `%${String(q).trim().replace(/[\\%_]/g, '\\$&')}%`;
  if (term === '%%') return [];
  return db.prepare(`
    SELECT id, type, name FROM nodes
    WHERE name LIKE ?1 ESCAPE '\\' OR summary LIKE ?1 ESCAPE '\\' OR canon LIKE ?1 ESCAPE '\\'
       OR aliases LIKE ?1 ESCAPE '\\'
    ORDER BY type, name LIMIT 50`).all(term);
}

export function duplicates(db) {
  const rows = db.prepare(`
    SELECT n.*, (SELECT COUNT(*) FROM edges WHERE src = n.id OR dst = n.id) AS edge_count
    FROM nodes n WHERE type = 'indicator' AND canon IN
      (SELECT canon FROM nodes WHERE type = 'indicator' GROUP BY canon HAVING COUNT(*) > 1)
    ORDER BY canon, id`).all().map(parseNode);
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.canon)) groups.set(r.canon, []);
    groups.get(r.canon).push(r);
  }
  return [...groups].map(([canon, members]) => ({ canon, members }));
}

export function mergeIndicators(db, keepId, dropId) {
  const get = db.prepare('SELECT * FROM nodes WHERE id = ?');
  const keep = get.get(keepId);
  const drop = get.get(dropId);
  if (!keep || !drop || keepId === dropId) throw new Error('need two different existing nodes');
  if (keep.type !== 'indicator' || drop.type !== 'indicator' || keep.canon !== drop.canon) {
    throw new Error('only indicators with the same canonical value can be merged');
  }
  transaction(db, () => {
    db.prepare('UPDATE OR IGNORE edges SET src = ? WHERE src = ?').run(keepId, dropId);
    db.prepare('UPDATE OR IGNORE edges SET dst = ? WHERE dst = ?').run(keepId, dropId);
    db.prepare('DELETE FROM edges WHERE src = ?1 OR dst = ?1').run(dropId);
    const aliases = new Set([...JSON.parse(keep.aliases), ...JSON.parse(drop.aliases), drop.name]);
    aliases.delete(keep.name);
    db.prepare('UPDATE nodes SET aliases = ? WHERE id = ?').run(JSON.stringify([...aliases]), keepId);
    db.prepare('DELETE FROM nodes WHERE id = ?').run(dropId);
  });
}

function shortestPath(adj, from, to, allow) {
  const prev = new Map([[from, null]]);
  const queue = [from];
  while (queue.length) {
    const cur = queue.shift();
    if (cur === to) break;
    for (const { edge, other } of adj.get(cur) ?? []) {
      if (prev.has(other) || !allow(edge)) continue;
      prev.set(other, { edge, from: cur });
      queue.push(other);
    }
  }
  if (!prev.has(to)) return null;
  const steps = [];
  for (let at = to; prev.get(at); at = prev.get(at).from) steps.unshift(prev.get(at).edge);
  return steps;
}

function attributions(edges, id) {
  return edges.filter((e) => e.rel === 'attributed-to' && e.src === id);
}

// Walks undirected, strong edges first. A weak edge on the result means no strong route exists.
export function link(db, a, b) {
  const { nodes, edges } = getGraph(db);
  const byId = new Map(nodes.map((n) => [n.id, n]));
  if (!byId.has(a) || !byId.has(b)) return null;

  const adj = new Map();
  for (const e of edges) {
    for (const [x, y] of [[e.src, e.dst], [e.dst, e.src]]) {
      if (!adj.has(x)) adj.set(x, []);
      adj.get(x).push({ edge: e, other: y });
    }
  }

  const sharedActors = [];
  const bActors = attributions(edges, b);
  for (const ea of attributions(edges, a)) {
    const eb = bActors.find((e) => e.dst === ea.dst);
    if (!eb || a === b) continue;
    sharedActors.push({
      actor: byId.get(ea.dst).name,
      edges: [ea, eb],
      weak: isWeak(ea) || isWeak(eb),
    });
  }

  let path = a === b ? [] : shortestPath(adj, a, b, (e) => !e.weak);
  let weakOnly = false;
  if (!path && a !== b) {
    path = shortestPath(adj, a, b, () => true);
    weakOnly = path !== null;
  }

  const warnings = [];
  if (weakOnly) {
    warnings.push('No route avoids weak edges (low confidence or related-to). This is a lead, not a link.');
  }
  if (path?.some((e) => e.alt)) {
    warnings.push('Some edges on this path carry an alternative explanation.');
  }
  for (const s of sharedActors.filter((x) => x.weak)) {
    warnings.push(`The attribution to ${s.actor} rests on a low-confidence edge.`);
  }

  let verdict;
  const hasActor = byId.get(a).type === 'actor' || byId.get(b).type === 'actor';
  if (sharedActors.length) {
    const names = sharedActors.map((s) => s.actor).join(', ');
    verdict = `Both carry an evidenced attributed-to edge to the actor label: ${names}.`;
  } else if (!path) {
    verdict = 'No connection found.';
  } else if (hasActor) {
    verdict = 'Connected. Read the attributed-to edges and their evidence on the path.';
  } else {
    verdict = 'Connected, but there is no shared attributed-to edge. This does not show a shared operator.';
  }

  const minConf = (es) => Math.min(...es.map((e) => CONFIDENCE[e.confidence]));
  return {
    a: byId.get(a),
    b: byId.get(b),
    connected: path !== null,
    path: path ?? [],
    weakOnly,
    sharedActors: sharedActors.map((s) => ({ ...s, minConfidence: minConf(s.edges) })),
    verdict,
    warnings,
  };
}
