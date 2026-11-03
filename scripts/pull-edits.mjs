// Copies edits made on the page (Firestore personEdits/) into seed/people/, so seed/ stays the
// full record before Claude works on the next chapter. Reads the public REST API, so no sign-in
// is needed. The edits stay in Firestore; once seed/ matches them they change nothing.
//
//   npm run pull-edits

import { readFileSync, writeFileSync, existsSync } from 'node:fs';

const project = JSON.parse(readFileSync(new URL('../.firebaserc', import.meta.url))).projects.default;
const url = `https://firestore.googleapis.com/v1/projects/${project}/databases/(default)/documents/personEdits?pageSize=300`;

// Firestore REST wraps every value in its type, e.g. { integerValue: "-63" }
function decode(v) {
  if ('stringValue' in v) return v.stringValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('booleanValue' in v) return v.booleanValue;
  if ('nullValue' in v) return null;
  if ('arrayValue' in v) return (v.arrayValue.values || []).map(decode);
  if ('mapValue' in v) return Object.fromEntries(Object.entries(v.mapValue.fields || {}).map(([k, x]) => [k, decode(x)]));
  return undefined;
}

const res = await fetch(url);
if (!res.ok) throw new Error(`Firestore answered ${res.status}: ${await res.text()}`);
const { documents = [] } = await res.json();

let changed = 0;
for (const d of documents) {
  const id = d.name.split('/').pop();
  const file = new URL(`../seed/people/${id}.json`, import.meta.url);
  if (!existsSync(file)) {
    console.log(`skip ${id}: no seed/people/${id}.json`);
    continue;
  }
  const person = JSON.parse(readFileSync(file, 'utf8'));
  const fields = Object.entries(d.fields || {}).filter(([k]) => k !== 'updatedAt');
  const diffs = fields.filter(([k, v]) => JSON.stringify(person[k]) !== JSON.stringify(decode(v)));
  if (!diffs.length) continue;
  for (const [k, v] of diffs) {
    console.log(`${id}.${k}: ${JSON.stringify(person[k])} → ${JSON.stringify(decode(v))}`);
    person[k] = decode(v);
  }
  writeFileSync(file, JSON.stringify(person, null, 2) + '\n');
  changed++;
}
console.log(changed ? `Updated ${changed} file(s) in seed/people.` : 'seed/people already matches the page edits.');
