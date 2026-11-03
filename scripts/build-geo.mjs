// Rebuilds public/geo.json: coastlines plus Roman territory snapshots, cut to the map's frame.
//
//   npm run build-geo
//
// Land: Natural Earth 1:50m (the world-atlas package). Territory: A. Ourednik's open
// historical-basemaps, fetched from GitHub. To cover later periods, add a year to YEARS; to show
// more of the world, widen BBOX (and the frame in setupProjection() in src/app.ts).

import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { feature } from 'topojson-client';
import polygonClipping from 'polygon-clipping';

const require = createRequire(import.meta.url);

/** [west, south, east, north] in degrees */
const BBOX = [-12, 24, 50, 56];
/** Snapshot years (BCE negative) → historical-basemaps file suffix */
const YEARS = { [-500]: 'bc500', [-323]: 'bc323', [-200]: 'bc200', [-100]: 'bc100', [-1]: 'bc1', 100: '100' };
const BASE = 'https://cdn.jsdelivr.net/gh/aourednik/historical-basemaps@master/geojson';

const [w, s, e, n] = BBOX;
const frame = [[[w, s], [e, s], [e, n], [w, n], [w, s]]];
// Two decimals (about 1 km) is plenty at this scale and keeps the file small
const round = (c) => (typeof c[0] === 'number' ? [+c[0].toFixed(2), +c[1].toFixed(2)] : c.map(round));

/** The part of a (Multi)Polygon inside the frame, or null */
function clip(geometry) {
  const polys = geometry.type === 'Polygon' ? [geometry.coordinates] : geometry.type === 'MultiPolygon' ? geometry.coordinates : [];
  const out = polys.length ? polygonClipping.intersection(frame, polys) : [];
  return out.length ? { type: 'MultiPolygon', coordinates: round(out) } : null;
}

// Land
const topo = JSON.parse(readFileSync(require.resolve('world-atlas/land-50m.json'), 'utf8'));
const land = feature(topo, topo.objects.land);
const landGeoms = (land.type === 'FeatureCollection' ? land.features : [land]).map((f) => clip(f.geometry)).filter(Boolean);

// Territory: Rome itself, plus kingdoms the basemaps mark as subject to it ("client")
const isRome = (name) => /^(Rome|Roman (Republic|Empire))$/i.test(name || '');
const territory = {};
for (const [year, suffix] of Object.entries(YEARS)) {
  const res = await fetch(`${BASE}/world_${suffix}.geojson`);
  if (!res.ok) throw new Error(`world_${suffix}.geojson: HTTP ${res.status}`);
  const fc = await res.json();
  const features = [];
  for (const f of fc.features) {
    const p = f.properties || {};
    const own = isRome(p.NAME);
    const client = !own && (isRome(p.SUBJECTO) || isRome(p.PARTOF));
    if (!own && !client) continue;
    const geometry = f.geometry && clip(f.geometry);
    if (geometry) features.push({ type: 'Feature', properties: { y: suffix, client: client ? 1 : 0, n: p.NAME }, geometry });
  }
  territory[year] = { type: 'FeatureCollection', features };
  console.log(`${year}: ${features.map((f) => f.properties.n).join(', ')}`);
}

const out = new URL('../public/geo.json', import.meta.url);
writeFileSync(out, JSON.stringify({ land: { type: 'GeometryCollection', geometries: landGeoms }, territory }));
console.log(`Wrote public/geo.json (${Math.round(readFileSync(out).length / 1024)} KB)`);
