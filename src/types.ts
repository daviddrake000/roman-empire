// The timeline's records. Field meanings are in README.md ("The data").

export type Era = 'legend' | 'kingdom' | 'republic' | 'empire';

export interface TimelineEvent {
  id: string;
  /** BCE is negative, CE positive; there is no year 0 */
  year: number;
  label: string;
  title: string;
  detail: string;
  place: string;
  people: string[];
  era: Era;
  /** One-line summary; only key events have one, and only they appear in the TLDR timeline */
  tldr?: string;
  // Record-keeping only; never shown on the page
  source?: string;
  note?: string;
  chapter?: number;
}

export interface Person {
  id: string;
  name: string;
  short: string;
  born: number;
  died: number;
  life: string;
  role: string;
  faction: string;
  summary: string;
  moments: string[];
  fate: string;
  kind: 'main' | 'link';
  tree: { x: number; y: number } | null;
  parents?: string[];
  spouses?: string[];
  adoptedBy?: string[];
  siblings?: string[];
  sub?: string;
}

export interface Place {
  id: string;
  name: string;
  lat: number;
  lon: number;
}

export interface PowerSpan {
  id: string;
  person: string;
  start: number;
  end: number;
  lane: number;
  label: string;
}

export interface PowerLink {
  id: string;
  kind: 'alliance' | 'war' | 'handoff';
  start: number;
  end: number;
  people: string[];
  label: string;
}

export interface Milestone {
  id: string;
  year: number;
  label: string;
}

export interface Progress {
  book: string;
  author: string;
  chapter: number;
}

export interface Geo {
  land: GeoJSON.GeometryCollection;
  /** Roman territory snapshots keyed by year; client kingdoms have client: 1 */
  territory: Record<string, GeoJSON.FeatureCollection<GeoJSON.Geometry, { client?: number; n?: string }>>;
}
