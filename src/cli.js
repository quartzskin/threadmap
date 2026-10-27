import { readFileSync } from 'node:fs';
import { openDb } from './db.js';
import { importDataset } from './import.js';

const [file, dbPath = 'threadmap.db'] = process.argv.slice(2);
if (!file) {
  console.error('usage: node src/cli.js <dataset.json> [db path]');
  process.exit(2);
}

let ds;
try {
  ds = JSON.parse(readFileSync(file, 'utf8'));
} catch (err) {
  console.error(`cannot read ${file}: ${err.message}`);
  process.exit(1);
}

const out = importDataset(openDb(dbPath), ds);
if (!out.ok) {
  for (const e of out.errors) console.error(e);
  process.exit(1);
}
console.log(`${out.nodes} nodes, ${out.edgesAdded} new edges, ${out.edgesSkipped} already present`);
