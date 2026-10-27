import { DatabaseSync } from 'node:sqlite';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS nodes (
  id TEXT PRIMARY KEY,
  type TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT,
  canon TEXT,
  summary TEXT,
  first_seen TEXT,
  aliases TEXT NOT NULL DEFAULT '[]'
);
CREATE INDEX IF NOT EXISTS nodes_canon ON nodes(canon);
CREATE TABLE IF NOT EXISTS edges (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  src TEXT NOT NULL REFERENCES nodes(id),
  dst TEXT NOT NULL REFERENCES nodes(id),
  rel TEXT NOT NULL,
  source TEXT NOT NULL,
  ts TEXT NOT NULL,
  confidence TEXT NOT NULL,
  alt TEXT,
  evidence TEXT,
  UNIQUE (src, dst, rel, source)
);
CREATE INDEX IF NOT EXISTS edges_src ON edges(src);
CREATE INDEX IF NOT EXISTS edges_dst ON edges(dst);
`;

export function openDb(path = ':memory:') {
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec(SCHEMA);
  return db;
}

export function transaction(db, fn) {
  db.exec('BEGIN');
  try {
    const out = fn();
    db.exec('COMMIT');
    return out;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
