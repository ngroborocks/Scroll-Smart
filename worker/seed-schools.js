#!/usr/bin/env node
// Turns a CSV export of the school list into:
//   1) seed-schools-logins.json  -> feed to `wrangler kv bulk put --binding=LOGINS`
//   2) seed-schools-roster.csv   -> Neil/Aiden's own reference: which school got which password
//
// Usage: node seed-schools.js path/to/schools.csv
//
// Looks for a column that's clearly the school name (School Name / Campus / School / Name).
// Everything else in the row is currently ignored — flag if there are other columns
// (principal email, distance tier, etc.) worth wiring in once the real file is in hand.

const fs = require('fs');
const crypto = require('crypto');
const path = require('path');

const WORDS = ['coral','teal','violet','sora','maple','cedar','falcon','harbor','summit','delta','quartz','willow'];

function parseCsv(text) {
  // minimal CSV parser: handles quoted fields with commas/escaped quotes, no external deps
  const rows = [];
  let row = [], field = '', inQuotes = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i], next = text[i + 1];
    if (inQuotes) {
      if (c === '"' && next === '"') { field += '"'; i++; }
      else if (c === '"') { inQuotes = false; }
      else field += c;
    } else {
      if (c === '"') inQuotes = true;
      else if (c === ',') { row.push(field); field = ''; }
      else if (c === '\n' || c === '\r') {
        if (c === '\r' && next === '\n') i++;
        row.push(field); field = '';
        if (row.length > 1 || row[0] !== '') rows.push(row);
        row = [];
      } else field += c;
    }
  }
  if (field.length || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function slugify(name) {
  const ascii = name.normalize('NFD').replace(/[\u0300-\u036f]/g, ''); // é->e, í->i, etc.
  return ascii.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
}

function genPassword() {
  const a = WORDS[crypto.randomInt(WORDS.length)];
  let b = WORDS[crypto.randomInt(WORDS.length)];
  while (b === a) b = WORDS[crypto.randomInt(WORDS.length)];
  return `${a}-${b}-${crypto.randomInt(100, 999)}`;
}

function findNameColumn(header) {
  const candidates = ['school name', 'campus name', 'campus', 'school', 'name'];
  const lower = header.map(h => h.trim().toLowerCase());
  for (const c of candidates) {
    const idx = lower.indexOf(c);
    if (idx !== -1) return idx;
  }
  return -1;
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node seed-schools.js path/to/schools.csv');
    process.exit(1);
  }
  const text = fs.readFileSync(inputPath, 'utf8');
  const rows = parseCsv(text);
  if (rows.length < 2) { console.error('No data rows found.'); process.exit(1); }

  const header = rows[0];
  const nameIdx = findNameColumn(header);
  if (nameIdx === -1) {
    console.error('Could not find a school-name column. Headers seen:', header.join(', '));
    console.error('Rename the relevant column to "School Name" and re-run, or tell Claude the exact header to use.');
    process.exit(1);
  }

  const seenSlugs = new Set();
  const bulk = [];
  const roster = [['school_id', 'school_name', 'password']];

  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    const name = (r[nameIdx] || '').trim();
    if (!name) continue;

    let slug = slugify(name);
    let n = 2;
    while (seenSlugs.has(slug)) { slug = slugify(name) + '-' + n; n++; }
    seenSlugs.add(slug);

    const password = genPassword();
    const hash = crypto.createHash('sha256').update(password).digest('hex');

    bulk.push({ key: 'login:' + hash, value: JSON.stringify({ role: 'school', name, schoolId: slug }) });
    roster.push([slug, name, password]);
  }

  const outDir = path.dirname(inputPath);
  const bulkPath = path.join(outDir, 'seed-schools-logins.json');
  const rosterPath = path.join(outDir, 'seed-schools-roster.csv');

  fs.writeFileSync(bulkPath, JSON.stringify(bulk, null, 2));
  fs.writeFileSync(rosterPath, roster.map(r => r.map(f => `"${String(f).replace(/"/g, '""')}"`).join(',')).join('\n'));

  console.log(`Processed ${bulk.length} schools from ${rows.length - 1} data rows.`);
  console.log(`Wrote ${bulkPath}`);
  console.log(`Wrote ${rosterPath}  <-- keep this one private, it has every school's password`);
  if (bulk.length !== rows.length - 1) {
    console.log(`Note: ${rows.length - 1 - bulk.length} row(s) had no name and were skipped.`);
  }
}

main();
