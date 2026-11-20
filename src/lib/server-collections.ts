import 'server-only';

import { cache } from 'react';
import {
  COLLECTIONS,
  STACK_POSTERS,
  collectionHref,
  type Collection,
  type CollectionStack,
} from '@/lib/collections';
import { resolveCuratedTitles } from '@/lib/tmdb';

/** The index and detail routes resolve the same full register (not the 12-card home shelf). */
export const resolveCollection = cache(async (collection: Collection) => {
  const items = await resolveCuratedTitles(collection.entries);
  return { items, unavailableCount: collection.entries.length - items.length };
});

/**
 * The home page's "Curated collections" shelf: four registers, three posters
 * each. Only the first three entries of a register are fetched, so the shelf
 * costs 12 requests once per ISR window rather than a full register per
 * collection.
 */
export const resolveCollectionStacks = cache(async (): Promise<CollectionStack[]> =>
  Promise.all(
    COLLECTIONS.map(async (collection) => {
      const posters = await resolveCuratedTitles(collection.entries.slice(0, STACK_POSTERS));
      return {
        slug: collection.slug,
        title: collection.title,
        blurb: collection.blurb,
        href: collectionHref(collection),
        posters: posters.slice(0, STACK_POSTERS),
        count: collection.entries.length,
        previewNote: collection.entries[0]?.note || collection.blurb,
      };
    })
  )
);
