const COLORS = {
  actor: '#c0392b', campaign: '#e08a1e', malware: '#7b4fc9',
  indicator: '#2b8a9e', technique: '#4d8f3a', report: '#8a8f9c',
};
const TYPES = Object.keys(COLORS);
const $ = (id) => document.getElementById(id);

function el(tag, props = {}, ...kids) {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k.startsWith('on')) n.addEventListener(k.slice(2), v);
    else if (k.includes('-')) n.setAttribute(k, v);
    else n[k] = v;
  }
  n.append(...kids.filter((k) => k != null));
  return n;
}

async function api(path, opts) {
  const res = await fetch(path, opts);
  const body = await res.json();
  if (!res.ok) throw new Error(body.error || body.errors?.join('; ') || res.statusText);
  return body;
}

const state = {
  nodes: [], edges: [], byId: new Map(),
  hidden: new Set(), minConf: 1, hideWeak: false, onlyAttr: false,
  selected: null, linkA: null, pathEdges: new Set(), pathNodes: new Set(),
  view: { x: 0, y: 0, k: 1 }, alpha: 1,
};

const canvas = $('canvas');
const ctx = canvas.getContext('2d');
const CONF = { low: 1, medium: 2, high: 3 };

function edgeVisible(e) {
  const a = state.byId.get(e.src);
  const b = state.byId.get(e.dst);
  return !state.hidden.has(a.type) && !state.hidden.has(b.type)
    && CONF[e.confidence] >= state.minConf
    && !(state.hideWeak && e.weak)
    && !(state.onlyAttr && e.rel !== 'attributed-to');
}

const nodeVisible = (n) => !state.hidden.has(n.type);

async function load(keepSelection) {
  const g = await api('/api/graph');
  const old = state.byId;
  state.nodes = g.nodes;
  state.edges = g.edges;
  state.byId = new Map(g.nodes.map((n) => [n.id, n]));
  const r = Math.max(120, Math.sqrt(g.nodes.length) * 40);
  g.nodes.forEach((n, i) => {
    const prev = old.get(n.id);
    const ang = (i / g.nodes.length) * Math.PI * 2;
    n.x = prev ? prev.x : Math.cos(ang) * r + Math.random();
    n.y = prev ? prev.y : Math.sin(ang) * r + Math.random();
    n.vx = n.vy = 0;
    n.deg = 0;
  });
  for (const e of g.edges) {
    state.byId.get(e.src).deg++;
    state.byId.get(e.dst).deg++;
  }
  state.alpha = 1;
  if (!keepSelection) state.selected = null;
  else if (state.selected && !state.byId.has(state.selected)) state.selected = null;
  requestAnimationFrame(frame);
}

function tick() {
  const nodes = state.nodes.filter(nodeVisible);
  const alpha = state.alpha;
  for (let i = 0; i < nodes.length; i++) {
    const a = nodes[i];
    for (let j = i + 1; j < nodes.length; j++) {
      const b = nodes[j];
      let dx = a.x - b.x;
      let dy = a.y - b.y;
      const d2 = Math.max(dx * dx + dy * dy, 25);
      const f = (3200 / d2) * alpha;
      const d = Math.sqrt(d2);
      dx = (dx / d) * f;
      dy = (dy / d) * f;
      a.vx += dx; a.vy += dy;
      b.vx -= dx; b.vy -= dy;
    }
    a.vx -= a.x * 0.004 * alpha;
    a.vy -= a.y * 0.004 * alpha;
  }
  for (const e of state.edges) {
    if (!edgeVisible(e)) continue;
    const a = state.byId.get(e.src);
    const b = state.byId.get(e.dst);
    const dx = b.x - a.x;
    const dy = b.y - a.y;
    const d = Math.sqrt(dx * dx + dy * dy) || 1;
    const f = ((d - 85) / d) * 0.06 * alpha;
    a.vx += dx * f; a.vy += dy * f;
    b.vx -= dx * f; b.vy -= dy * f;
  }
  for (const n of nodes) {
    if (n.fixed) { n.vx = n.vy = 0; continue; }
    n.vx *= 0.82; n.vy *= 0.82;
    n.x += n.vx; n.y += n.vy;
  }
  state.alpha = Math.max(state.alpha * 0.992, 0.02);
}

function frame() {
  if (state.alpha > 0.03 || state.dragging) {
    for (let i = 0; i < 2; i++) tick();
    requestAnimationFrame(frame);
  }
  draw();
}

function resize() {
  const r = canvas.getBoundingClientRect();
  const dpr = window.devicePixelRatio || 1;
  canvas.width = r.width * dpr;
  canvas.height = r.height * dpr;
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  if (!state.view.set) state.view = { x: r.width / 2, y: r.height / 2, k: 1, set: true };
  draw();
}

function neighbors(id) {
  const s = new Set([id]);
  for (const e of state.edges) {
    if (e.src === id) s.add(e.dst);
    if (e.dst === id) s.add(e.src);
  }
  return s;
}

const radius = (n) => (n.type === 'actor' ? 11 : 6 + Math.min(n.deg, 8) * 0.8);

function draw() {
  const { width, height } = canvas.getBoundingClientRect();
  ctx.clearRect(0, 0, width, height);
  ctx.save();
  ctx.translate(state.view.x, state.view.y);
  ctx.scale(state.view.k, state.view.k);

  const focus = state.selected ? neighbors(state.selected) : null;
  const hasPath = state.pathEdges.size > 0;

  for (const e of state.edges) {
    if (!edgeVisible(e)) continue;
    const a = state.byId.get(e.src);
    const b = state.byId.get(e.dst);
    const onPath = state.pathEdges.has(e.id);
    const dim = (focus && !(focus.has(e.src) && focus.has(e.dst) && (e.src === state.selected || e.dst === state.selected))) || (hasPath && !onPath);
    ctx.globalAlpha = dim ? 0.12 : 1;
    ctx.beginPath();
    ctx.setLineDash(e.weak ? [4, 4] : []);
    ctx.strokeStyle = onPath ? '#e67e00' : e.rel === 'attributed-to' ? '#c0392b' : '#a0a6b4';
    ctx.lineWidth = onPath ? 3.5 : e.rel === 'attributed-to' ? 2.5 : 1;
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
  }
  ctx.setLineDash([]);

  for (const n of state.nodes) {
    if (!nodeVisible(n)) continue;
    const dim = (focus && !focus.has(n.id)) || (hasPath && !state.pathNodes.has(n.id));
    ctx.globalAlpha = dim ? 0.2 : 1;
    const r = radius(n);
    ctx.fillStyle = COLORS[n.type];
    ctx.beginPath();
    if (n.type === 'actor') ctx.rect(n.x - r, n.y - r, r * 2, r * 2);
    else ctx.arc(n.x, n.y, r, 0, Math.PI * 2);
    ctx.fill();
    if (n.id === state.selected || n.id === state.linkA) {
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = '#111';
      ctx.stroke();
    }
    if (!dim && (state.view.k > 0.6 || n.type !== 'indicator' || n.id === state.selected)) {
      ctx.fillStyle = '#1d2330';
      ctx.font = '11px system-ui, sans-serif';
      ctx.fillText(short(n.name), n.x + r + 3, n.y + 4);
    }
  }
  ctx.restore();
  ctx.globalAlpha = 1;
}

const short = (s) => (s.length > 26 ? s.slice(0, 24) + '..' : s);

function toWorld(ev) {
  const r = canvas.getBoundingClientRect();
  return { x: (ev.clientX - r.left - state.view.x) / state.view.k, y: (ev.clientY - r.top - state.view.y) / state.view.k };
}

function hit(ev) {
  const p = toWorld(ev);
  let best = null;
  for (const n of state.nodes) {
    if (!nodeVisible(n)) continue;
    const d = Math.hypot(n.x - p.x, n.y - p.y);
    if (d <= radius(n) + 3 && (!best || d < best.d)) best = { n, d };
  }
  return best?.n ?? null;
}

let drag = null;
canvas.addEventListener('mousedown', (ev) => {
  const n = hit(ev);
  drag = { n, sx: ev.clientX, sy: ev.clientY, moved: false, vx: state.view.x, vy: state.view.y };
  if (n) { n.fixed = true; state.dragging = true; requestAnimationFrame(frame); }
});
window.addEventListener('mousemove', (ev) => {
  if (!drag) return;
  const dx = ev.clientX - drag.sx;
  const dy = ev.clientY - drag.sy;
  if (Math.abs(dx) + Math.abs(dy) > 3) drag.moved = true;
  if (drag.n) {
    const p = toWorld(ev);
    drag.n.x = p.x; drag.n.y = p.y;
    state.alpha = Math.max(state.alpha, 0.3);
  } else {
    state.view.x = drag.vx + dx;
    state.view.y = drag.vy + dy;
    draw();
  }
});
window.addEventListener('mouseup', () => {
  if (!drag) return;
  if (drag.n) {
    drag.n.fixed = false;
    state.dragging = false;
    if (!drag.moved) select(drag.n.id);
  } else if (!drag.moved) {
    select(null);
  }
  drag = null;
});
canvas.addEventListener('wheel', (ev) => {
  ev.preventDefault();
  const r = canvas.getBoundingClientRect();
  const mx = ev.clientX - r.left;
  const my = ev.clientY - r.top;
  const k = Math.min(3, Math.max(0.25, state.view.k * (ev.deltaY < 0 ? 1.12 : 1 / 1.12)));
  state.view.x = mx - ((mx - state.view.x) / state.view.k) * k;
  state.view.y = my - ((my - state.view.y) / state.view.k) * k;
  state.view.k = k;
  draw();
}, { passive: false });

function clearPath() {
  state.pathEdges = new Set();
  state.pathNodes = new Set();
}

async function select(id) {
  state.selected = id;
  clearPath();
  draw();
  if (!id) {
    $('detail').replaceChildren(el('p', { class: 'muted' }, 'Select a node.'));
    return;
  }
  const { node, edges } = await api('/api/node/' + encodeURIComponent(id));
  renderDetail(node, edges);
}

function nodeLink(id, name) {
  return el('a', { onclick: () => { focusOn(id); } }, name);
}

function focusOn(id) {
  const n = state.byId.get(id);
  if (!n) return;
  if (state.hidden.has(n.type)) {
    state.hidden.delete(n.type);
    $('type-filters').querySelector(`input[data-type="${n.type}"]`).checked = true;
  }
  const r = canvas.getBoundingClientRect();
  state.view.x = r.width / 2 - n.x * state.view.k;
  state.view.y = r.height / 2 - n.y * state.view.k;
  select(id);
}

function renderDetail(node, edges, linkResult) {
  const d = $('detail');
  const head = [
    el('h2', {}, node.type),
    el('div', {}, el('strong', {}, node.name)),
  ];
  if (node.kind) head.push(el('div', { class: 'muted' }, `${node.kind} (canonical: `, el('code', {}, node.canon), ')'));
  if (node.aliases.length) head.push(el('div', { class: 'muted' }, 'also recorded as: ', el('code', {}, node.aliases.join(', '))));
  if (node.first_seen) head.push(el('div', { class: 'muted' }, 'first seen ' + node.first_seen.slice(0, 10)));
  if (node.summary) head.push(el('p', {}, node.summary));
  if (node.type === 'actor') {
    head.push(el('div', { class: 'plain' }, 'An actor is a label that groups attributed activity. It is only as strong as the attributed-to edges below.'));
  }

  const linkBox = [];
  if (state.linkA && state.linkA !== node.id) {
    linkBox.push(el('button', { class: 'small', onclick: () => checkLink(state.linkA, node.id) }, 'Check link with ' + short(state.byId.get(state.linkA).name)));
  }
  linkBox.push(el('button', { class: 'small', onclick: () => { state.linkA = node.id; renderDetail(node, edges); draw(); } }, state.linkA === node.id ? 'Link start set' : 'Use as link start'));
  if (state.pathEdges.size) {
    linkBox.push(el('button', { class: 'small', onclick: () => { clearPath(); renderDetail(node, edges); draw(); } }, 'Clear path'));
  }

  const list = edges.map((e) => {
    const out = e.src === node.id;
    const otherId = out ? e.dst : e.src;
    const otherName = out ? e.dst_name : e.src_name;
    const tags = [el('span', { class: 'tag' }, e.confidence)];
    if (e.weak) tags.push(el('span', { class: 'tag weak' }, 'weak'));
    if (e.rel === 'attributed-to') tags.push(el('span', { class: 'tag attr' }, 'attributed-to'));
    const src = state.byId.get(e.source);
    return el('div', { class: 'edge' },
      el('div', {}, out ? `${e.rel} \u2192 ` : `\u2190 ${e.rel} `, nodeLink(otherId, otherName), ' ', ...tags),
      el('div', { class: 'meta' }, 'source: ', src ? nodeLink(src.id, src.name) : e.source, ' \u00b7 ' + e.ts.slice(0, 10)),
      e.evidence ? el('div', { class: 'ev' }, 'Evidence: ' + e.evidence) : null,
      e.alt ? el('div', { class: 'alt' }, 'Alternative explanation: ' + e.alt) : null,
    );
  });

  d.replaceChildren(...head, el('div', {}, ...linkBox), linkResult ?? '', el('h2', {}, `Edges (${edges.length})`), ...list);
}

async function checkLink(a, b) {
  const r = await api(`/api/link?a=${encodeURIComponent(a)}&b=${encodeURIComponent(b)}`);
  state.pathEdges = new Set(r.path.map((e) => e.id));
  state.pathNodes = new Set([a, b, ...r.path.flatMap((e) => [e.src, e.dst])]);
  const { node, edges } = await api('/api/node/' + encodeURIComponent(b));
  const cls = r.warnings.length ? 'warn' : r.sharedActors.length ? 'ok' : 'plain';
  const box = el('div', {},
    el('h2', {}, 'Link check'),
    el('div', { class: cls }, el('strong', {}, r.verdict), ...r.warnings.map((w) => el('div', {}, 'Warning: ' + w))),
  );
  for (const s of r.sharedActors) {
    for (const e of s.edges) {
      box.append(el('div', { class: 'edge' },
        el('div', {}, nodeLink(e.src, state.byId.get(e.src).name), ' attributed-to ', s.actor, ' ', el('span', { class: 'tag' }, e.confidence)),
        el('div', { class: 'ev' }, 'Evidence: ' + e.evidence)));
    }
  }
  if (r.path.length) {
    box.append(el('div', { class: 'muted' }, `Path, ${r.path.length} edge${r.path.length > 1 ? 's' : ''}:`));
    for (const e of r.path) {
      box.append(el('div', { class: 'meta' },
        `${state.byId.get(e.src).name} ${e.rel} ${state.byId.get(e.dst).name} [${e.confidence}${e.weak ? ', weak' : ''}]`));
    }
  }
  state.selected = b;
  renderDetail(node, edges, box);
  draw();
}

function buildFilters() {
  const box = $('type-filters');
  const legend = $('legend');
  for (const t of TYPES) {
    box.append(el('label', {},
      el('input', { type: 'checkbox', checked: true, 'data-type': t, onchange: (ev) => {
        if (ev.target.checked) state.hidden.delete(t); else state.hidden.add(t);
        state.alpha = Math.max(state.alpha, 0.5);
        requestAnimationFrame(frame);
      } }),
      ' ' + t));
    legend.append(el('li', {}, el('span', { class: 'dot ' + t, style: `background:${COLORS[t]}` }), t));
  }
  legend.append(
    el('li', {}, el('span', { style: 'color:#c0392b;font-weight:bold' }, '\u2501'), 'attributed-to'),
    el('li', {}, el('span', { style: 'color:#a0a6b4' }, '- - -'), 'weak edge'),
    el('li', {}, el('span', { style: 'color:#e67e00;font-weight:bold' }, '\u2501'), 'link check path'),
  );
  $('min-conf').onchange = (ev) => { state.minConf = Number(ev.target.value); relayout(); };
  $('hide-weak').onchange = (ev) => { state.hideWeak = ev.target.checked; relayout(); };
  $('only-attr').onchange = (ev) => { state.onlyAttr = ev.target.checked; relayout(); };
}

function relayout() {
  state.alpha = Math.max(state.alpha, 0.5);
  requestAnimationFrame(frame);
}

let searchTimer;
$('search').addEventListener('input', (ev) => {
  clearTimeout(searchTimer);
  const q = ev.target.value;
  searchTimer = setTimeout(async () => {
    const box = $('results');
    if (!q.trim()) { box.hidden = true; return; }
    const rows = await api('/api/search?q=' + encodeURIComponent(q));
    box.replaceChildren(...(rows.length
      ? rows.map((r) => el('div', { onclick: () => { box.hidden = true; showTab('graph'); focusOn(r.id); } },
        el('span', { class: 'tag' }, r.type), short(r.name)))
      : [el('div', {}, 'no matches')]));
    box.hidden = false;
  }, 120);
});
document.addEventListener('click', (ev) => {
  if (!ev.target.closest('#results, #search')) $('results').hidden = true;
});

function showTab(name) {
  const graph = name === 'graph';
  for (const id of ['filters', 'stage', 'detail']) $(id).hidden = !graph;
  $('dupes').hidden = graph;
  $('tab-graph').classList.toggle('on', graph);
  $('tab-dupes').classList.toggle('on', !graph);
  if (graph) resize(); else renderDupes();
}

async function renderDupes() {
  const groups = await api('/api/duplicates');
  const root = $('dupes');
  if (!groups.length) {
    root.replaceChildren(el('p', {}, 'No duplicate indicators.'));
    return;
  }
  root.replaceChildren(
    el('p', {}, 'Indicators that normalise to the same value (defanging, case, trailing dot, zero-padded octets). Merging keeps one node, moves its edges over and records the other spelling as an alias.'),
    ...groups.map((g) => el('div', {},
      el('div', {}, 'canonical: ', el('code', {}, g.canon)),
      el('table', {},
        el('tr', {}, ...['recorded as', 'id', 'first seen', 'edges', ''].map((h) => el('th', {}, h))),
        ...g.members.map((m) => el('tr', {},
          el('td', {}, el('code', {}, m.name)),
          el('td', {}, m.id),
          el('td', {}, (m.first_seen ?? '').slice(0, 10)),
          el('td', {}, String(m.edge_count)),
          el('td', {}, el('button', { class: 'small', onclick: () => merge(m.id, g.members.filter((x) => x.id !== m.id)) }, 'keep this one, merge the rest')),
        ))))));
}

async function merge(keep, others) {
  for (const o of others) {
    await api('/api/merge', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ keep, drop: o.id }) });
  }
  await load(false);
  renderDupes();
}

$('tab-graph').onclick = () => showTab('graph');
$('tab-dupes').onclick = () => showTab('dupes');
window.addEventListener('resize', resize);
buildFilters();
resize();
load(false).then(() => {
  const m = location.hash.match(/^#link=([^,]+),(.+)$/);
  if (m) setTimeout(() => checkLink(decodeURIComponent(m[1]), decodeURIComponent(m[2])), 3000);
}).catch((err) => { $('detail').textContent = 'failed to load: ' + err.message; });
