// The timeline content as it stands in seed/, bundled into the build. seed/ is the source of
// truth: chapter updates are made there, then the owner's browser mirrors it into Firestore
// (src/sync.ts). Until that first sync, the page shows this copy so it is never empty.

export const CONTENT_COLLECTIONS = ['events', 'people', 'places', 'power', 'links', 'milestones', 'meta'] as const;
export type ContentCollection = (typeof CONTENT_COLLECTIONS)[number];

export type Doc = Record<string, unknown>;

const files = import.meta.glob<Doc>('../seed/*/*.json', { eager: true, import: 'default' });

/** collection → doc id → fields */
export const seed = Object.fromEntries(CONTENT_COLLECTIONS.map((c) => [c, {} as Record<string, Doc>])) as Record<
  ContentCollection,
  Record<string, Doc>
>;

for (const [path, data] of Object.entries(files)) {
  const m = /seed\/([^/]+)\/([^/]+)\.json$/.exec(path);
  if (!m) continue;
  const [, col, id] = m;
  if ((CONTENT_COLLECTIONS as readonly string[]).includes(col)) seed[col as ContentCollection][id] = data;
}
