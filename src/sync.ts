import { collection, doc, getDocs, writeBatch, type WriteBatch } from 'firebase/firestore';
import { firestore } from './firebase';
import { CONTENT_COLLECTIONS, seed, type Doc } from './seed';

// Mirrors seed/ into Firestore when the owner opens the page: new and changed documents are
// written, documents no longer in seed/ are deleted. Photos live in their own collection and
// are never touched. Returns the number of documents written or deleted.

/** JSON with object keys sorted, so field order doesn't count as a change */
export function stable(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`;
  if (v && typeof v === 'object') {
    return `{${Object.keys(v as Doc)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable((v as Doc)[k])}`)
      .join(',')}}`;
  }
  return JSON.stringify(v ?? null);
}

export async function syncSeed(): Promise<number> {
  const remote = await Promise.all(CONTENT_COLLECTIONS.map((c) => getDocs(collection(firestore, c))));
  // A Firestore commit takes at most 500 writes
  const batches: WriteBatch[] = [];
  let ops = 0;
  const batch = () => {
    if (ops % 500 === 0) batches.push(writeBatch(firestore));
    ops++;
    return batches[batches.length - 1];
  };
  CONTENT_COLLECTIONS.forEach((c, i) => {
    const have = new Map(remote[i].docs.map((d) => [d.id, d.data()]));
    for (const [id, data] of Object.entries(seed[c])) {
      if (!have.has(id) || stable(have.get(id)) !== stable(data)) batch().set(doc(firestore, c, id), data);
    }
    for (const id of have.keys()) if (!(id in seed[c])) batch().delete(doc(firestore, c, id));
  });
  await Promise.all(batches.map((b) => b.commit()));
  return ops;
}
