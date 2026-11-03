import { geoArea, geoMercator, geoPath, type GeoPath, type GeoProjection } from 'd3-geo';
import { select } from 'd3-selection';
import { zoom, zoomIdentity, zoomTransform, type D3ZoomEvent, type ZoomBehavior } from 'd3-zoom';
import { onAuthStateChanged, type User } from 'firebase/auth';
import { collection, deleteDoc, doc, onSnapshot, serverTimestamp, setDoc } from 'firebase/firestore';
import { auth, firestore, isOwner, redirectSignInResult, signIn, signOut } from './firebase';
import { CONTENT_COLLECTIONS, seed, type ContentCollection, type Doc } from './seed';
import { stable, syncSeed } from './sync';
import type { Geo, Milestone, Person, Place, PowerLink, PowerSpan, Progress, TimelineEvent } from './types';

/* ---------- State ---------- */
interface State {
  events: TimelineEvent[];
  people: Record<string, Person>;
  places: Record<string, Place>;
  power: PowerSpan[];
  links: PowerLink[];
  milestones: Milestone[];
  meta: Progress | null;
  photos: Record<string, string>;
  /** People as seed/ has them; `people` is these with the owner's page edits on top */
  basePeople: Record<string, Person>;
  personEdits: Record<string, Partial<Person>>;
  geo: Geo | null;
}
const S: State = {
  events: [], people: {}, places: {}, power: [], links: [], milestones: [], meta: null, photos: {}, geo: null,
  basePeople: {}, personEdits: {},
};
function mergePeople() {
  S.people = Object.fromEntries(Object.entries(S.basePeople).map(([id, p]) => [id, { ...p, ...S.personEdits[id], id }]));
}

function apply(c: ContentCollection, rows: Doc[]) {
  if (c === 'events') S.events = rows as unknown as TimelineEvent[];
  if (c === 'people') {
    S.basePeople = Object.fromEntries(rows.map((r) => [r.id, r])) as unknown as State['people'];
    mergePeople();
  }
  if (c === 'places') S.places = Object.fromEntries(rows.map((r) => [r.id, r])) as unknown as State['places'];
  if (c === 'power') S.power = rows as unknown as PowerSpan[];
  if (c === 'links') S.links = rows as unknown as PowerLink[];
  if (c === 'milestones') S.milestones = rows as unknown as Milestone[];
  if (c === 'meta') S.meta = (rows.find((r) => r.id === 'progress') as unknown as Progress) ?? null;
}
// Start from the bundled copy; Firestore takes over as soon as it answers
CONTENT_COLLECTIONS.forEach((c) => apply(c, Object.entries(seed[c]).map(([id, d]) => ({ id, ...d }))));

let user: User | null = null;
let canEdit = false;
let mapIdx = 0;
let playing: ReturnType<typeof setInterval> | null = null;
let uploadFor: string | null = null;

const ERA: Record<string, { name: string; range: string }> = {
  legend: { name: 'Legend', range: 'before 753 BCE' },
  kingdom: { name: 'The Kingdom', range: '753–509 BCE' },
  republic: { name: 'The Republic', range: '509–27 BCE' },
  empire: { name: 'The Empire', range: '27 BCE onward' },
};
const FACTION: Record<string, string> = {
  legend: 'Legend', kings: 'Kings of Rome', republic: 'Early Republic', enemy: 'Enemy of Rome',
  optimates: "Senate's side", populares: 'Popular side', caesarians: "Caesar's side", egypt: 'Ptolemaic Egypt', family: 'Family',
};
const COLOR = (id: string) => `var(--c-${id}, var(--muted))`;
const $ = <T extends Element = HTMLElement>(s: string) => document.querySelector(s) as T;
const esc = (s: unknown) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const yr = (y: number) => (y < 0 ? `${-y} BCE` : `${y} CE`);
const initials = (n: string) =>
  n.replace(/\(.*?\)/g, '').split(/\s+/).filter((w) => /^[A-Z]/.test(w)).slice(0, 2).map((w) => w[0]).join('');
const sortedEvents = () => [...S.events].sort((a, b) => a.year - b.year || a.id.localeCompare(b.id));
const mapEvents = () => sortedEvents().filter((e) => S.places[e.place]);
const mainPeople = () => Object.values(S.people).filter((p) => p.kind === 'main').sort((a, b) => a.born - b.born);
const reducedMotion = () => matchMedia('(prefers-reduced-motion: reduce)').matches;

/* ---------- Routing ---------- */
const VIEWS = ['timeline', 'map', 'family', 'power', 'people'];
function route() {
  const v = VIEWS.includes(location.hash.slice(1)) ? location.hash.slice(1) : 'timeline';
  document.querySelectorAll<HTMLElement>('section[data-view]').forEach((s) => (s.hidden = s.dataset.view !== v));
  document.querySelectorAll('nav.tabs a').forEach((a) => a.setAttribute('aria-current', (a as HTMLElement).dataset.v === v ? 'page' : 'false'));
  if (v !== 'map') stopPlay();
  return v;
}
window.addEventListener('hashchange', () => render());

/* ---------- Timeline ---------- */
// FULL shows every event; TLDR only the key ones (those with a tldr line), one line each
type Mode = 'full' | 'tldr';
let mode: Mode = 'full';
try { if (localStorage.getItem('timeline-mode') === 'tldr') mode = 'tldr'; } catch {}
function setMode(m: Mode) {
  mode = m;
  try { localStorage.setItem('timeline-mode', m); } catch {}
  renderTimeline();
}
function renderTimeline() {
  const all = sortedEvents();
  const shown = mode === 'tldr' ? all.filter((e) => e.tldr) : all;
  document.querySelectorAll<HTMLElement>('[data-mode]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.mode === mode)));
  $('#timeline-sub').textContent = mode === 'tldr'
    ? (shown.length ? `The ${shown.length} turning points, one line each.` : "The turning points, one line each.")
    : 'From the legend of Troy to the death of Augustus.';
  const groups: Record<string, TimelineEvent[]> = {};
  shown.forEach((e) => (groups[e.era] ||= []).push(e));
  const html = Object.keys(ERA)
    .filter((k) => groups[k])
    .map(
      (k) => `
    <div class="era" style="--era: var(--era-${k})">
      <div class="era-head"><h3>${ERA[k].name}</h3><span>${ERA[k].range}</span></div>
      <ol class="events${mode === 'tldr' ? ' tldr' : ''}">${groups[k].map(mode === 'tldr' ? tldrHTML : evHTML).join('')}</ol>
    </div>`,
    )
    .join('');
  $('#timeline').innerHTML = html || `<p class="status">${mode === 'tldr' ? 'No key events yet.' : 'No events yet.'}</p>`;
}
function personTags(ids: string[] = []) {
  return ids
    .map((id) => S.people[id])
    .filter(Boolean)
    .map((p) => `<button class="tag" data-person="${esc(p.id)}">${esc(p.short)}</button>`)
    .join('');
}
function evHTML(e: TimelineEvent) {
  const place = S.places[e.place];
  return `<li class="ev" id="ev-${esc(e.id)}">
    <div class="ev-date">${esc(e.label)}</div>
    <div class="ev-body">
      <p class="ev-title">${esc(e.title)}</p>
      <p class="ev-detail">${esc(e.detail)}</p>
      <div class="ev-meta">
        ${personTags(e.people)}
        ${place ? `<button class="tag place" data-mapto="${esc(e.id)}">${esc(place.name)}</button>` : ''}
      </div>
    </div></li>`;
}
function tldrHTML(e: TimelineEvent) {
  return `<li class="ev" id="ev-${esc(e.id)}">
    <div class="ev-date">${esc(e.label)}</div>
    <div class="ev-body">
      <p class="ev-title">${esc(e.title)}</p>
      <p class="ev-detail">${esc(e.tldr)} <button class="link-btn more" data-full="${esc(e.id)}">More</button></p>
    </div></li>`;
}
function goToEvent(id: string) {
  closeDossier();
  // An event the TLDR list leaves out needs the full timeline
  if (mode === 'tldr' && !S.events.find((e) => e.id === id)?.tldr) setMode('full');
  // pushState fires no hashchange, so the timeline is drawn now rather than after the scroll below
  if (location.hash !== '#timeline') history.pushState(null, '', '#timeline');
  render();
  requestAnimationFrame(() => {
    const el = document.getElementById('ev-' + id);
    if (!el) return;
    el.scrollIntoView({ block: 'center', behavior: reducedMotion() ? 'auto' : 'smooth' });
    el.classList.remove('flash');
    void el.offsetWidth;
    el.classList.add('flash');
  });
}

/* ---------- Map ---------- */
const W = 1000, H = 560;
let proj: GeoProjection | null = null, path: GeoPath | null = null;
function setupProjection() {
  proj = geoMercator().fitExtent([[10, 10], [W - 10, H - 10]], { type: 'MultiPoint', coordinates: [[-10, 28], [44, 54]] });
  path = geoPath(proj);
}
function snapshotFor(year: number) {
  if (!S.geo || year < -510) return null;
  const keys = Object.keys(S.geo.territory).map(Number).sort((a, b) => a - b);
  let k = keys[0];
  keys.forEach((x) => { if (x <= year) k = x; });
  return k;
}
function renderMap() {
  const svg = $('#map');
  if (!S.geo) { svg.innerHTML = `<text x="500" y="280" text-anchor="middle" class="map-borders">Loading map…</text>`; return; }
  if (!proj) setupProjection();
  const evs = mapEvents();
  if (!evs.length) return;
  mapIdx = Math.max(0, Math.min(mapIdx, evs.length - 1));
  const cur = evs[mapIdx];
  const snap = snapshotFor(cur.year);
  const pt = (id: string) => { const p = S.places[id]; return proj!([p.lon, p.lat])!; };
  const land = `<path class="land" d="${path!(S.geo.land)}"/>`;
  const terr = snap === null ? '' : S.geo.territory[snap].features
    .map((f) => `<path class="terr${f.properties?.client ? ' client' : ''}" d="${path!(f)}"/>`).join('');
  const usedPlaces = [...new Set(evs.map((e) => e.place))];
  const soFar = evs.slice(0, mapIdx + 1);
  const trailPts = new Set(soFar.map((e) => e.place)).size > 1 ? soFar.map((e) => pt(e.place)) : [];
  const trail = trailPts.length > 1 ? `<path class="trail" d="M${trailPts.map((p) => p.map((n) => n.toFixed(1)).join(',')).join('L')}"/>` : '';
  const pins = usedPlaces.map((id) => {
    const [x, y] = pt(id); const on = id === cur.place;
    return `<circle class="pin${on ? ' on' : ''}" cx="${x}" cy="${y}" r="${on ? 7 : 4.5}" data-place="${esc(id)}"><title>${esc(S.places[id].name)}</title></circle>`;
  }).join('');
  const [cx, cy] = pt(cur.place);
  const anchorEnd = cx > W * 0.68;
  const label = `<circle class="pin-ring" cx="${cx}" cy="${cy}" r="9"/>
    <text class="map-label" x="${cx + (anchorEnd ? -14 : 14)}" y="${cy + 5}" text-anchor="${anchorEnd ? 'end' : 'start'}">${esc(S.places[cur.place].name)}</text>`;
  const bordersTxt = snap === null ? (cur.year < -753 ? 'Before Rome existed' : 'Rome is a single city-state') : `Borders: c. ${yr(snap)}`;
  svg.innerHTML = `<rect width="${W}" height="${H}" fill="var(--sea)"/>${land}${terr}${trail}${pins}${label}
    <text class="map-year" x="24" y="${H - 52}">${esc(yr(cur.year))}</text>
    <text class="map-borders" x="26" y="${H - 26}">${esc(bordersTxt)}</text>`;
  const scrub = $<HTMLInputElement>('#scrub');
  scrub.max = String(evs.length - 1); scrub.value = String(mapIdx);
  scrub.setAttribute('aria-valuetext', `${cur.label}: ${cur.title}`);
  $('#mapcard').innerHTML = `<div class="ev-date" style="color: var(--era-${esc(cur.era)})">${esc(cur.label)} · ${mapIdx + 1} of ${evs.length}</div>
    <p class="ev-title" style="margin-top:4px">${esc(cur.title)}</p><p class="ev-detail">${esc(cur.detail)}</p>
    <div class="ev-meta">${personTags(cur.people)}
    <button class="tag" data-goto="${esc(cur.id)}">See in timeline</button></div>`;
}
function mapTo(eventId: string) {
  const i = mapEvents().findIndex((e) => e.id === eventId);
  if (i >= 0) mapIdx = i;
  closeDossier();
  if (location.hash !== '#map') location.hash = 'map';
  else render();
}
$('#map').addEventListener('click', (ev) => {
  const c = (ev.target as Element).closest<SVGElement>('[data-place]');
  if (!c) return;
  const evs = mapEvents();
  const after = evs.findIndex((e, i) => i > mapIdx && e.place === c.dataset.place);
  const i = after >= 0 ? after : evs.findIndex((e) => e.place === c.dataset.place);
  if (i >= 0) { mapIdx = i; stopPlay(); renderMap(); }
});
$('#scrub').addEventListener('input', (e) => { mapIdx = +(e.target as HTMLInputElement).value; stopPlay(); renderMap(); });
$('#prev').addEventListener('click', () => { mapIdx--; stopPlay(); renderMap(); });
$('#next').addEventListener('click', () => { mapIdx++; stopPlay(); renderMap(); });
$('#play').addEventListener('click', () => (playing ? stopPlay() : startPlay()));
function startPlay() {
  const n = mapEvents().length;
  if (mapIdx >= n - 1) mapIdx = 0;
  $('#play').textContent = 'Pause';
  renderMap();
  playing = setInterval(() => {
    if (mapIdx >= n - 1) return stopPlay();
    mapIdx++;
    renderMap();
  }, reducedMotion() ? 3500 : 2400);
}
function stopPlay() {
  if (playing) clearInterval(playing);
  playing = null;
  const b = $('#play');
  if (b) b.textContent = 'Play';
}
document.addEventListener('keydown', (e) => {
  if (route() !== 'map' || !$('#overlay').hidden || (e.target as Element).matches('input, textarea, select')) return;
  if (e.key === 'ArrowRight') { mapIdx++; stopPlay(); renderMap(); }
  if (e.key === 'ArrowLeft') { mapIdx--; stopPlay(); renderMap(); }
});

/* ---------- Family tree ---------- */
const NW = 150, NH = 70;
let treeZoom: ZoomBehavior<SVGSVGElement, unknown> | null = null;
let treeSize = { w: 0, h: 0 };
let treePlaced = false;

/** Drag to pan; pinch, Ctrl+scroll or the buttons to zoom. Plain scrolling still scrolls the page. */
function setupTreeZoom() {
  const svg = $<SVGSVGElement>('#tree');
  treeZoom = zoom<SVGSVGElement, unknown>()
    .filter((e: Event) => (e.type === 'wheel' ? (e as WheelEvent).ctrlKey || (e as WheelEvent).metaKey : !(e as MouseEvent).button))
    .on('zoom', (e: D3ZoomEvent<SVGSVGElement, unknown>) => svg.querySelector('#tree-g')?.setAttribute('transform', e.transform.toString()));
  select(svg).call(treeZoom).on('dblclick.zoom', null);
  $('#zoom-in').addEventListener('click', () => treeZoom!.scaleBy(select(svg), 1.3));
  $('#zoom-out').addEventListener('click', () => treeZoom!.scaleBy(select(svg), 1 / 1.3));
  $('#zoom-fit').addEventListener('click', () => placeTree(true));
}
/** Fits the whole tree in view. On a phone that would make names unreadable, so unless asked
    to fit, it starts at a readable size centred on Augustus instead. */
function placeTree(fit = false) {
  const svg = $<SVGSVGElement>('#tree');
  const cw = svg.clientWidth, ch = svg.clientHeight;
  if (!treeZoom || !cw || !treeSize.w) return;
  const fitK = Math.min(cw / treeSize.w, ch / treeSize.h) * 0.96;
  const pad = 120;
  treeZoom
    .scaleExtent([Math.min(0.25, fitK), 2.5])
    .translateExtent([[-pad, -pad], [treeSize.w + pad, treeSize.h + pad]]);
  const k = fit ? fitK : Math.max(fitK, 0.7);
  const focus = S.people.augustus?.tree;
  const [fx, fy] = k > fitK && focus ? [focus.x + NW / 2, focus.y + NH / 2] : [treeSize.w / 2, treeSize.h / 2];
  treeZoom.transform(select(svg), zoomIdentity.translate(cw / 2 - fx * k, ch / 2 - fy * k).scale(k));
}

function renderTree() {
  const ppl = Object.values(S.people).filter((p) => p.tree);
  if (!treeZoom) setupTreeZoom();
  if (!ppl.length) { $('#tree').innerHTML = ''; return; }
  const byId: Record<string, Person> = Object.fromEntries(ppl.map((p) => [p.id, p]));
  const box = (p: Person) => {
    const { x, y } = p.tree!;
    return { x, y, cx: x + NW / 2, cy: y + NH / 2, r: x + NW, b: y + NH };
  };
  const width = Math.max(...ppl.map((p) => p.tree!.x + NW)) + 30;
  const height = Math.max(...ppl.map((p) => p.tree!.y + NH)) + 24;
  const isPair = (a: Person, b: Person) => (a.spouses || []).includes(b.id) || (b.spouses || []).includes(a.id);
  let edges = '', labels = '';
  // spouses / partners
  const seen = new Set<string>();
  ppl.forEach((a) => (a.spouses || []).forEach((bid) => {
    const b = byId[bid]; if (!b) return;
    const key = [a.id, b.id].sort().join('|'); if (seen.has(key)) return; seen.add(key);
    const A = box(a), B = box(b);
    let d, mx, my;
    if (A.y === B.y) {
      const [L, R] = A.x < B.x ? [A, B] : [B, A];
      d = `M${L.r} ${L.cy}H${R.x}`; mx = (L.r + R.x) / 2; my = L.cy;
    } else {
      const [T, Bt] = A.y < B.y ? [A, B] : [B, A];
      const sx = T.cx < Bt.cx ? T.r : T.x, sy = T.cy, ex = Bt.cx, ey = Bt.y;
      d = `M${sx} ${sy}C${(sx + ex) / 2} ${sy} ${ex} ${(sy + ey) / 2} ${ex} ${ey}`;
      mx = (sx + ex) / 2; my = (sy + ey) / 2;
    }
    edges += `<path class="edge-spouse" d="${d}"/><circle class="ring-dot" cx="${mx}" cy="${my}" r="3.5"/>`;
  }));
  // parents
  ppl.forEach((c) => {
    const ps = (c.parents || []).map((id) => byId[id]).filter(Boolean); if (!ps.length) return;
    const C = box(c); let sx, sy;
    if (ps.length === 2 && isPair(ps[0], ps[1]) && ps[0].tree!.y === ps[1].tree!.y) {
      const A = box(ps[0]), B = box(ps[1]);
      sx = ((A.x < B.x ? A.r : B.r) + (A.x < B.x ? B.x : A.x)) / 2; sy = A.cy;
    } else { const P = box(ps[0]); sx = P.cx; sy = P.b; }
    const busY = C.y - 20;
    edges += `<path class="edge-parent" d="M${sx} ${sy}V${busY}H${C.cx}V${C.y}"/>`;
  });
  // siblings
  ppl.forEach((a) => (a.siblings || []).forEach((bid) => {
    const b = byId[bid]; if (!b) return; const A = box(a), B = box(b);
    const top = Math.min(A.y, B.y) - 10;
    edges += `<path class="edge-sibling" d="M${A.cx} ${A.y}V${top}H${B.cx}V${B.y}"/>`;
    labels += `<text class="edge-label" x="${(A.cx + B.cx) / 2}" y="${top + 4}" text-anchor="middle" style="fill: var(--muted)">siblings</text>`;
  }));
  // adoptions
  ppl.forEach((c) => (c.adoptedBy || []).forEach((aid) => {
    const a = byId[aid]; if (!a) return; const A = box(a), C = box(c);
    const left = C.cx < A.cx;
    const sx = A.cx + (left ? -40 : 40), sy = A.b, ex = C.cx + (left ? 50 : -50), ey = C.y;
    edges += `<path class="edge-adopt" d="M${sx} ${sy}L${ex} ${ey}" marker-end="url(#arrowA)"/>`;
    const adoptEv = S.events.find((e) => e.title.toLowerCase().includes('adopt') && (e.people || [])[0] === c.id)
      || (c.id === 'augustus' ? { label: '44 BCE' } : null);
    labels += `<text class="edge-label" x="${(sx + ex) / 2 + (left ? -6 : 6)}" y="${(sy + ey) / 2}" text-anchor="${left ? 'end' : 'start'}">adopted${adoptEv ? ' ' + esc(adoptEv.label.replace(/^\d+ \w+ /, '')) : ''}</text>`;
  }));
  // Every box shows name and dates; family-only people also get their relationship caption
  const nodes = ppl.map((p) => {
    const B = box(p); const main = p.kind === 'main';
    const lines = [p.life, main ? '' : p.sub].filter(Boolean);
    const top = B.y + (lines.length > 1 ? 22 : 28);
    // People without a dossier open straight into the editor for the owner
    const action = main ? `data-person="${esc(p.id)}" tabindex="0" role="button" aria-label="${esc(p.name)} dossier"`
      : canEdit ? `data-edit="${esc(p.id)}" tabindex="0" role="button" aria-label="Edit ${esc(p.name)}"` : '';
    return `<g class="node${main ? ' main' : canEdit ? ' editable' : ''}" ${action}>
      <rect x="${B.x}" y="${B.y}" width="${NW}" height="${NH}" rx="4"/>
      <text class="nm" x="${B.cx}" y="${top}" text-anchor="middle">${esc(p.short)}</text>
      ${lines.map((t, i) => `<text class="sb" x="${B.cx}" y="${top + 19 + i * 17}" text-anchor="middle">${esc(t)}</text>`).join('')}
    </g>`;
  }).join('');
  const svg = $<SVGSVGElement>('#tree');
  svg.innerHTML = `<defs><marker id="arrowA" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--accent)"/></marker></defs>
    <g id="tree-g" transform="${zoomTransform(svg).toString()}">${edges}${nodes}${labels}</g>`;
  treeSize = { w: width, h: height };
  if (!treePlaced && svg.clientWidth) { treePlaced = true; placeTree(); }
}

/* ---------- Power ---------- */
function renderPower() {
  const spans = [...S.power].sort((a, b) => a.lane - b.lane);
  if (!spans.length) { $('#power').innerHTML = ''; return; }
  const minY = Math.min(...spans.map((s) => s.start)) - 3, maxY = Math.max(...spans.map((s) => s.end)) + 2;
  const narrow = narrowScreen.matches;
  const NAMES_W = narrow ? 112 : 160;
  const L = NAMES_W + 8, R = 1060, top = 64, laneH = 50;
  const lanes = Math.max(...spans.map((s) => s.lane)) + 1;
  const height = top + lanes * laneH + 60;
  const x = (y: number) => L + ((y - minY) / (maxY - minY)) * (R - L);
  const ly = (lane: number) => top + lane * laneH + laneH / 2;
  const laneOf = (id: string) => { const s = spans.find((s) => s.person === id); return s ? s.lane : null; };
  let out = `<defs>
    <pattern id="hatch" width="6" height="6" patternUnits="userSpaceOnUse" patternTransform="rotate(45)"><rect width="6" height="6" fill="var(--surface)"/><line x1="0" y1="0" x2="0" y2="6" stroke="var(--c-caesar)" stroke-width="1.5" stroke-opacity=".35"/></pattern>
    <marker id="arrow" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0 0L10 5L0 10z" fill="var(--ink)"/></marker></defs>`;
  // axis
  out += `<g class="axis">`;
  const step = 10;
  for (let t = Math.ceil(minY / step) * step; t <= maxY; t += step) {
    if (t === 0) continue;
    out += `<line x1="${x(t)}" x2="${x(t)}" y1="${top - 6}" y2="${height - 40}"/><text x="${x(t)}" y="${height - 22}" text-anchor="middle">${yr(t)}</text>`;
  }
  out += `</g>`;
  // milestones
  S.milestones.forEach((m) => {
    out += `<line class="mile" x1="${x(m.year)}" x2="${x(m.year)}" y1="${top - 24}" y2="${height - 40}"/>
      <text class="mile-label" x="${x(m.year) + 4}" y="${top - 28}">${esc(m.label)}</text>`;
  });
  // lane tracks; the names go in their own column (below) so they stay in view when scrolling
  let names = '';
  spans.forEach((s) => {
    out += `<line class="lane-track" x1="${L}" x2="${R}" y1="${ly(s.lane)}" y2="${ly(s.lane)}"/>`;
    // On a phone the column is narrow, so "Octavian / Augustus" goes on two lines
    const parts = narrow ? s.label.split(' / ') : [s.label];
    const y0 = ly(s.lane) + 5 - (parts.length - 1) * 8;
    names += `<text class="lane-label" x="10" y="${y0}" data-person="${esc(s.person)}">${parts
      .map((t, i) => `<tspan x="10" dy="${i ? 16 : 0}">${esc(t)}${i < parts.length - 1 ? ' /' : ''}</tspan>`).join('')}</text>`;
  });
  const bands = S.links.filter((l) => l.kind !== 'handoff');
  const bandTop = (l: PowerLink) => {
    const ls = l.people.map(laneOf).filter((v): v is number => v !== null);
    return ls.length ? { y0: ly(Math.min(...ls)) - 18, y1: ly(Math.max(...ls)) + 18 } : null;
  };
  // bands
  bands.forEach((l) => {
    const b = bandTop(l); if (!b) return;
    const x0 = x(l.start), w = Math.max(10, x(l.end) - x0);
    out += `<rect class="${l.kind === 'war' ? 'band-war' : 'band-ally'}" x="${x0}" y="${b.y0}" width="${w}" height="${b.y1 - b.y0}" rx="3"/>`;
  });
  // bars
  spans.forEach((s) => {
    out += `<rect class="bar" data-person="${esc(s.person)}" x="${x(s.start)}" y="${ly(s.lane) - 8}" width="${x(s.end) - x(s.start)}" height="16" rx="8" fill="${COLOR(s.person)}"><title>${esc(s.label)}: ${yr(s.start)} – ${yr(s.end)}</title></rect>`;
  });
  // band labels (above bars)
  bands.forEach((l) => {
    const b = bandTop(l); if (!b) return;
    out += `<text class="band-label" x="${x(l.start) + 4}" y="${b.y0 - 5}">${esc(l.label)}</text>`;
  });
  // handoffs
  S.links.filter((l) => l.kind === 'handoff').forEach((l) => {
    const a = laneOf(l.people[0]), b = laneOf(l.people[1]); if (a === null || b === null) return;
    const hx = x(l.start), y0 = ly(a) + 9, y1 = ly(b) - 11;
    out += `<path class="handoff" d="M${hx} ${y0}C${hx + 26} ${(y0 + y1) / 2} ${hx + 26} ${(y0 + y1) / 2} ${hx} ${y1}" marker-end="url(#arrow)"/>
      <text class="mile-label" x="${hx + 26}" y="${(y0 + y1) / 2 + 4}">${esc(l.label)}</text>`;
  });
  // event dots
  sortedEvents().forEach((e) => (e.people || []).forEach((pid) => {
    const lane = laneOf(pid); if (lane === null || e.year < minY || e.year > maxY) return;
    out += `<circle class="ev-dot" data-goto="${esc(e.id)}" cx="${x(e.year)}" cy="${ly(lane)}" r="5" stroke="${COLOR(pid)}"><title>${esc(e.label)}: ${esc(e.title)}</title></circle>`;
  }));
  const svg = $('#power');
  svg.setAttribute('viewBox', `0 0 ${R + 30} ${height}`);
  svg.setAttribute('width', String(R + 30)); svg.setAttribute('height', String(height));
  svg.innerHTML = out;
  const col = $('#power-names');
  col.setAttribute('viewBox', `0 0 ${NAMES_W} ${height}`);
  col.setAttribute('width', String(NAMES_W)); col.setAttribute('height', String(height));
  col.innerHTML = names;
  col.parentElement!.style.setProperty('--names-w', `${NAMES_W}px`);
}
const narrowScreen = matchMedia('(max-width: 560px)');
narrowScreen.addEventListener('change', () => { if (route() === 'power') renderPower(); });

/* ---------- People ---------- */
function bustHTML(p: Person, big = false) {
  const url = S.photos[p.id];
  if (url) return `<div class="bust"><img src="${esc(url)}" alt="Bust of ${esc(p.name)}" loading="lazy"></div>`;
  return `<div class="bust"><span class="initials" aria-hidden="true">${esc(initials(p.name))}</span>${big ? '' : `<span class="plinth">${canEdit ? 'Add bust photo' : 'No photo yet'}</span>`}</div>`;
}
function renderPeople() {
  $('#people').innerHTML = mainPeople().map((p) => `<button class="card" data-person="${esc(p.id)}">
    ${bustHTML(p)}
    <div class="card-body">
      <div class="card-name">${esc(p.name)}</div>
      <div class="card-dates">${esc(p.life)}</div>
      <div class="card-role"><span class="swatch" style="background:${COLOR(p.id)}"></span>${esc(p.role)}</div>
    </div></button>`).join('');
  $('#people-intro').textContent = canEdit ? 'Dossiers for the key figures. Open one to add a bust photo.' : 'Dossiers for the key figures.';
}

/* ---------- Dossier ---------- */
let openId: string | null = null, lastFocus: Element | null = null;
function openDossier(id: string) {
  const p = S.people[id]; if (!p || p.kind !== 'main') return;
  if (!openId) lastFocus = document.activeElement;
  openId = id;
  const evs = sortedEvents().filter((e) => (e.people || []).includes(id));
  const hasPhoto = !!S.photos[id];
  $('#sheet').innerHTML = `
    <button class="icon-btn sheet-close" data-close aria-label="Close">Close</button>
    <div class="sheet-inner">
      <div>
        ${bustHTML(p, true)}
        ${canEdit || hasPhoto ? `<div class="photo-actions">
          ${canEdit ? `<button class="icon-btn" data-upload="${esc(id)}">${hasPhoto ? 'Replace photo' : 'Add bust photo'}</button>
          <button class="icon-btn" data-paste="${esc(id)}">Paste</button>` : ''}
          ${hasPhoto ? `<button class="icon-btn" data-copy="${esc(id)}">Copy</button>` : ''}
          ${canEdit && hasPhoto ? `<button class="icon-btn" data-remove="${esc(id)}">Remove</button>` : ''}
        </div><div class="photo-msg" id="photo-msg" role="status">${canEdit ? 'You can also paste an image or an image link here with Ctrl+V (⌘V on a Mac).' : ''}</div>` : ''}
      </div>
      <div>
        <h2 id="dossier-name">${esc(p.name)}</h2>
        <div class="sub">${esc(p.life)} · ${esc(p.role)} · ${esc(FACTION[p.faction] || '')}</div>
        ${canEdit ? `<button class="icon-btn edit-btn" data-edit="${esc(id)}">Edit details</button>` : ''}
        <h3>Who</h3><p>${esc(p.summary)}</p>
        ${p.moments?.length ? `<h3>Key moments</h3><ul>${p.moments.map((m) => `<li>${esc(m)}</li>`).join('')}</ul>` : ''}
        ${p.fate ? `<h3>Fate</h3><p>${esc(p.fate)}</p>` : ''}
        ${evs.length ? `<h3>In the timeline</h3><ul class="mini-events">${evs.map((e) => `<li><span class="d">${esc(e.label)}</span><button class="link-btn" data-goto="${esc(e.id)}">${esc(e.title)}</button></li>`).join('')}</ul>` : ''}
      </div>
    </div>`;
  $('#overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  $('#sheet .sheet-close').focus();
}
function closeDossier() {
  if (!openId || !leaveEditor()) return;
  openId = null;
  $('#overlay').hidden = true;
  document.body.style.overflow = '';
  if (lastFocus instanceof HTMLElement && document.contains(lastFocus)) lastFocus.focus();
}
$('#overlay').addEventListener('click', (e) => {
  const t = e.target as Element;
  if (t.id === 'overlay' || t.closest('[data-close]')) closeDossier();
});

/* ---------- Editing people (owner only) ----------
   Edits are saved to personEdits/{id} as just the fields that differ from seed/, and shown on
   top of it. The seed/ sync never touches them, so they survive chapter updates;
   `npm run pull-edits` copies them into seed/ (see README). */
let editingId: string | null = null, editDirty = false;
const EDIT_FIELDS = ['name', 'short', 'life', 'born', 'died', 'role', 'faction', 'summary', 'moments', 'fate', 'sub'] as const;
type EditField = (typeof EDIT_FIELDS)[number];

/** False when the owner has unsaved changes and chooses to keep editing */
function leaveEditor() {
  if (editingId && editDirty && !confirm('Discard your changes?')) return false;
  editingId = null;
  editDirty = false;
  return true;
}
function openEditor(id: string) {
  const p = S.people[id]; if (!p || !canEdit) return;
  if (!openId) lastFocus = document.activeElement;
  openId = id; editingId = id; editDirty = false;
  const main = p.kind === 'main';
  const field = (label: string, input: string, hint = '', wide = false) =>
    `<label class="field${wide ? ' wide' : ''}"><span>${label}</span>${input}${hint ? `<small>${hint}</small>` : ''}</label>`;
  const text = (k: EditField, required = false) =>
    `<input name="${k}" value="${esc(p[k])}" autocomplete="off"${required ? ' required' : ''}>`;
  const year = (k: 'born' | 'died') => `<input name="${k}" type="number" step="1" value="${esc(p[k])}" required>`;
  const area = (k: EditField, v: string, rows: number) => `<textarea name="${k}" rows="${rows}">${esc(v)}</textarea>`;
  const edited = !!S.personEdits[id];
  $('#sheet').innerHTML = `
    <form class="edit-form" id="edit-form" data-id="${esc(id)}" novalidate>
      <h2 id="dossier-name">Edit ${esc(p.short)}</h2>
      <div class="fields">
        ${field('Full name', text('name', true), '', true)}
        ${field('Short name', text('short', true), 'Used on tags, the tree and charts')}
        ${field('Dates as shown', text('life', true), 'e.g. “c. 85–43 BCE” or “63 BCE – 14 CE”')}
        ${field('Born', year('born'), 'Year; BCE is negative (63 BCE is −63)')}
        ${field('Died', year('died'), 'Year; BCE is negative')}
        ${main ? `
          ${field('Role', text('role'))}
          ${field('Side', `<select name="faction">${Object.entries(FACTION).map(([k, v]) => `<option value="${k}"${k === p.faction ? ' selected' : ''}>${esc(v)}</option>`).join('')}</select>`)}
          ${field('Who', area('summary', p.summary, 3), '', true)}
          ${field('Key moments', area('moments', (p.moments || []).join('\n'), 6), 'One per line', true)}
          ${field('Fate', area('fate', p.fate, 2), '', true)}`
        : field('Family-tree caption', text('sub'), 'e.g. “Augustus’ mother”', true)}
      </div>
      <p class="form-msg" id="form-msg" role="alert"></p>
      <div class="form-actions">
        <button class="icon-btn primary" type="submit">Save</button>
        <button class="icon-btn" type="button" data-cancel-edit>Cancel</button>
        ${edited ? `<button class="icon-btn" type="button" data-reset-edit="${esc(id)}">Restore original</button>` : ''}
      </div>
    </form>`;
  $('#overlay').hidden = false;
  document.body.style.overflow = 'hidden';
  $<HTMLInputElement>('#edit-form input[name=name]').focus();
}
/** Back to the dossier, or closed for people who only appear in the family tree */
function finishEditing(id: string) {
  if (!leaveEditor()) return;
  if (S.people[id]?.kind === 'main') openDossier(id);
  else closeDossier();
}
function readForm(form: HTMLFormElement): Partial<Person> | string {
  const fd = new FormData(form);
  const out: Record<string, unknown> = {};
  for (const k of EDIT_FIELDS) {
    const v = fd.get(k);
    if (v === null) continue;
    const s = String(v).trim();
    if (k === 'born' || k === 'died') {
      const n = Number(s);
      if (!s || !Number.isInteger(n) || n === 0) return `${k === 'born' ? 'Born' : 'Died'} needs a whole year. There's no year 0: use −1 for 1 BCE and 1 for 1 CE.`;
      out[k] = n;
    } else if (k === 'moments') {
      out[k] = s.split('\n').map((m) => m.trim()).filter(Boolean);
    } else {
      out[k] = s;
    }
  }
  if (!out.name || !out.short || !out.life) return 'Full name, short name and dates can’t be empty.';
  if ((out.born as number) > (out.died as number)) return 'Born has to come before died.';
  return out as Partial<Person>;
}
function saveEditor(form: HTMLFormElement) {
  const id = form.dataset.id!;
  const next = readForm(form);
  if (typeof next === 'string') { $('#form-msg').textContent = next; return; }
  const base = S.basePeople[id] as unknown as Record<string, unknown>;
  // Keep only what differs from seed/, so later seed/ fixes to other fields still show
  const diff = Object.fromEntries(Object.entries(next).filter(([k, v]) => stable(v) !== stable(base?.[k] ?? '')));
  const ref = doc(firestore, 'personEdits', id);
  // The local copy updates at once; the server write finishes in the background (or once back online)
  (Object.keys(diff).length ? setDoc(ref, { ...diff, updatedAt: serverTimestamp() }) : deleteDoc(ref))
    .catch(() => toast('Your changes couldn’t be saved. Try again.'));
  editDirty = false;
  finishEditing(id);
}
function resetEdits(id: string) {
  if (!confirm('Restore the original details? Your edits to this person will be removed.')) return;
  deleteDoc(doc(firestore, 'personEdits', id)).catch(() => toast('Couldn’t restore the original. Try again.'));
  editDirty = false;
  finishEditing(id);
}
document.addEventListener('submit', (e) => {
  const form = e.target as HTMLFormElement;
  if (form.id !== 'edit-form') return;
  e.preventDefault();
  saveEditor(form);
});
document.addEventListener('input', (e) => { if ((e.target as Element).closest('#edit-form')) editDirty = true; });
document.addEventListener('keydown', (e) => { if (e.key === 'Escape') closeDossier(); });

/* Photo upload: shrink on the device, then store as a JPEG data URL in photos/{personId}.
   Firestore documents top out at 1 MiB, so the size steps down until it fits. */
async function toDataUrl(file: Blob) {
  const bmp = await createImageBitmap(file);
  const c = document.createElement('canvas');
  for (const [max, q] of [[900, 0.86], [700, 0.8], [520, 0.75]] as const) {
    const scale = Math.min(1, max / Math.max(bmp.width, bmp.height));
    c.width = Math.round(bmp.width * scale);
    c.height = Math.round(bmp.height * scale);
    c.getContext('2d')!.drawImage(bmp, 0, 0, c.width, c.height);
    const url = c.toDataURL('image/jpeg', q);
    if (url.length < 850_000) return url;
  }
  throw new Error('too large');
}
const photoMsg = (t: string) => { const m = document.getElementById('photo-msg'); if (m) m.textContent = t; };
async function savePhoto(id: string, image: Blob) {
  photoMsg('Saving…');
  try {
    await setDoc(doc(firestore, 'photos', id), { data: await toDataUrl(image), updatedAt: serverTimestamp() });
    photoMsg('Photo saved.');
  } catch {
    photoMsg("That photo couldn't be saved. Try a JPEG or PNG.");
  }
}
$<HTMLInputElement>('#file').addEventListener('change', (e) => {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0]; input.value = '';
  if (f && uploadFor) savePhoto(uploadFor, f);
});

/* Paste: an image copied from anywhere, or a link to one (Wikimedia and most image hosts
   allow the page to download them; some sites don't, and then the message says so). */
async function pasteText(id: string, text: string) {
  const url = text.trim();
  if (!/^(https?:\/\/|data:image\/)\S+$/i.test(url)) {
    photoMsg('There’s no image on the clipboard. Copy an image (right-click it, then Copy image) or its link.');
    return;
  }
  photoMsg('Fetching the image…');
  try {
    const res = await fetch(url);
    const blob = await res.blob();
    if (!res.ok || !blob.type.startsWith('image/')) throw new Error('not an image');
    await savePhoto(id, blob);
  } catch {
    photoMsg('That site won’t let the page download the image. Open it, right-click it, choose Copy image, then paste.');
  }
}
async function pasteFromClipboard(id: string) {
  try {
    for (const item of await navigator.clipboard.read()) {
      const type = item.types.find((t) => t.startsWith('image/'));
      if (type) return savePhoto(id, await item.getType(type));
      if (item.types.includes('text/plain')) return pasteText(id, await (await item.getType('text/plain')).text());
    }
    photoMsg('The clipboard is empty.');
  } catch {
    // The browser refused access to the clipboard; the keyboard shortcut still works
    photoMsg('Press Ctrl+V (⌘V on a Mac) to paste.');
  }
}
document.addEventListener('paste', (e) => {
  // Pasting into the edit form is ordinary text pasting
  if (!openId || !canEdit || editingId || !e.clipboardData) return;
  const file = [...e.clipboardData.files].find((f) => f.type.startsWith('image/'));
  const text = e.clipboardData.getData('text/plain');
  if (!file && !text) return;
  e.preventDefault();
  if (file) savePhoto(openId, file);
  else pasteText(openId, text);
});

/* Copy: clipboards take PNG, so the stored JPEG is redrawn as one */
async function toPng(dataUrl: string) {
  const bmp = await createImageBitmap(await (await fetch(dataUrl)).blob());
  const c = document.createElement('canvas');
  c.width = bmp.width; c.height = bmp.height;
  c.getContext('2d')!.drawImage(bmp, 0, 0);
  return new Promise<Blob>((ok, fail) => c.toBlob((b) => (b ? ok(b) : fail(new Error('no image'))), 'image/png'));
}
async function copyPhoto(id: string) {
  const url = S.photos[id]; if (!url) return;
  try {
    // Safari needs the ClipboardItem made straight away in the click, with the image to follow
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': toPng(url) })]);
    photoMsg('Photo copied.');
  } catch {
    photoMsg('Couldn’t copy. Right-click the photo and choose Copy image instead.');
  }
}
async function removePhoto(id: string) {
  try { await deleteDoc(doc(firestore, 'photos', id)); }
  catch { photoMsg("Couldn't remove the photo. Try again."); }
}

/* ---------- Global clicks ---------- */
document.addEventListener('click', (e) => {
  const t = (e.target as Element).closest<HTMLElement>('[data-mode],[data-full],[data-person],[data-goto],[data-mapto],[data-upload],[data-paste],[data-copy],[data-remove],[data-signin],[data-signout],[data-edit],[data-cancel-edit],[data-reset-edit]');
  if (!t) return;
  const d = t.dataset;
  if (d.mode) { setMode(d.mode as Mode); return; }
  if (d.full) { setMode('full'); goToEvent(d.full); return; }
  if (d.edit) { openEditor(d.edit); return; }
  if ('cancelEdit' in d) { if (editingId) finishEditing(editingId); return; }
  if (d.resetEdit) { resetEdits(d.resetEdit); return; }
  if ('signin' in d) { signIn().catch(() => toast("Sign-in didn't work. Try again.")); return; }
  if ('signout' in d) { signOut(); return; }
  if (d.upload) { uploadFor = d.upload; $('#file').click(); return; }
  if (d.paste) { pasteFromClipboard(d.paste); return; }
  if (d.copy) { copyPhoto(d.copy); return; }
  if (d.remove) { removePhoto(d.remove); return; }
  if (d.goto) { goToEvent(d.goto); return; }
  if (d.mapto) { mapTo(d.mapto); return; }
  if (d.person) openDossier(d.person);
});
document.addEventListener('keydown', (e) => {
  const t = e.target as HTMLElement;
  if ((e.key === 'Enter' || e.key === ' ') && t.matches('g.node[data-person]')) { e.preventDefault(); openDossier(t.dataset.person!); }
  if ((e.key === 'Enter' || e.key === ' ') && t.matches('g.node[data-edit]')) { e.preventDefault(); openEditor(t.dataset.edit!); }
});

/* ---------- Render ---------- */
function renderAccount() {
  $('#account').innerHTML = !user
    ? `<button class="link-btn" data-signin>Sign in</button>`
    : `${canEdit ? '' : 'View only · '}<button class="link-btn" data-signout>Sign out</button>`;
}
function render() {
  $('#status').hidden = true;
  const v = route();
  if (S.meta?.chapter) $('#reading').innerHTML = `${esc(S.meta.author?.split(' ').pop() || 'Kershaw')}, <i>${esc(S.meta.book)}</i> · through <b>chapter ${esc(S.meta.chapter)}</b>`;
  renderAccount();
  if (v === 'timeline') renderTimeline();
  if (v === 'map') renderMap();
  if (v === 'family') renderTree();
  if (v === 'power') renderPower();
  if (v === 'people') renderPeople();
  // Redraw an open dossier with fresh data, but never under a form being filled in
  if (openId && !editingId) openDossier(openId);
}

let toastTimer: ReturnType<typeof setTimeout> | undefined;
function toast(text: string) {
  const el = $('#toast');
  el.textContent = text;
  el.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (el.hidden = true), 4000);
}

/* ---------- Data ---------- */
// geo.json follows the GeoJSON convention (outer rings anticlockwise), but d3 reads rings on
// the sphere and takes anticlockwise as "everything except this shape". Flip any polygon
// that covers more than half the globe.
function rewind(g: GeoJSON.Geometry) {
  const fix = (rings: GeoJSON.Position[][]) => {
    if (geoArea({ type: 'Polygon', coordinates: rings }) > 2 * Math.PI) rings.forEach((r) => r.reverse());
  };
  if (g.type === 'Polygon') fix(g.coordinates);
  if (g.type === 'MultiPolygon') g.coordinates.forEach(fix);
  if (g.type === 'GeometryCollection') g.geometries.forEach(rewind);
}
fetch('/geo.json')
  .then((r) => r.json())
  .then((g: Geo) => {
    rewind(g.land);
    Object.values(g.territory).forEach((fc) => fc.features.forEach((f) => rewind(f.geometry)));
    S.geo = g;
    if (route() === 'map') renderMap();
  })
  .catch(() => {});

CONTENT_COLLECTIONS.forEach((c) =>
  onSnapshot(
    collection(firestore, c),
    (snap) => {
      // An empty collection means the owner hasn't synced yet; keep showing the bundled copy
      if (snap.empty) return;
      apply(c, snap.docs.map((d) => ({ id: d.id, ...d.data() })));
      render();
    },
    () => {},
  ),
);
onSnapshot(
  collection(firestore, 'photos'),
  (snap) => {
    S.photos = Object.fromEntries(snap.docs.map((d) => [d.id, d.data().data as string]));
    render();
  },
  () => {},
);
onSnapshot(
  collection(firestore, 'personEdits'),
  (snap) => {
    S.personEdits = Object.fromEntries(snap.docs.map((d) => {
      const { updatedAt: _, ...fields } = d.data();
      return [d.id, fields as Partial<Person>];
    }));
    mergePeople();
    render();
  },
  () => {},
);

let synced = false;
onAuthStateChanged(auth, (u) => {
  user = u;
  canEdit = isOwner(u);
  render();
  if (canEdit && !synced) {
    synced = true;
    syncSeed()
      .then((n) => { if (n) toast(`Timeline updated: ${n} ${n === 1 ? 'change' : 'changes'} saved.`); })
      .catch(() => { synced = false; toast("The timeline couldn't be updated. Reopen the page to try again."); });
  }
});
redirectSignInResult().catch(() => toast("Sign-in didn't work. Try again."));

render();
