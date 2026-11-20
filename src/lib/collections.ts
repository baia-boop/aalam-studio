import type { MediaItem, MediaType } from '@/types/media';
import {
  AUTHORS_CHOICE_ANIME,
  AUTHORS_CHOICE_DOCUMENTARIES,
  AUTHORS_CHOICE_MOVIES,
  AUTHORS_CHOICE_TV,
  type CuratedChoiceItem,
} from '@/data/curated-lists';

/**
 * Curated collections.
 *
 * A collection is an authored register — a list a person at AALAM chose, with a
 * written note per title — not an algorithmic shelf and not a genre landing.
 * Keeping the four registers in one place lets Browse, the collection pages and
 * the title pages agree on what exists.
 */
export type CollectionCategory = 'movie' | 'tv' | 'anime' | 'documentary';

export interface Collection {
  slug: string;
  title: string;
  /** Why this collection exists, in one sentence. */
  blurb: string;
  category: CollectionCategory;
  entries: readonly CuratedChoiceItem[];
  /** Landing the collection's "keep looking" link points at. */
  browseHref: string;
}

export const COLLECTIONS: readonly Collection[] = [
  {
    slug: 'films',
    title: 'The film shelf',
    blurb: 'Crime epics, quiet science fiction and animation — films the editors keep returning to.',
    category: 'movie',
    entries: AUTHORS_CHOICE_MOVIES,
    browseHref: '/movies',
  },
  {
    slug: 'series',
    title: 'The series shelf',
    blurb: 'Long-form shows worth the commitment, from workplace dystopia to fantasy.',
    category: 'tv',
    entries: AUTHORS_CHOICE_TV,
    browseHref: '/series',
  },
  {
    slug: 'anime',
    title: 'The anime shelf',
    blurb: 'Animation from Japan that the editors recommend before any chart does.',
    category: 'anime',
    entries: AUTHORS_CHOICE_ANIME,
    browseHref: '/anime',
  },
  {
    slug: 'documentaries',
    title: 'The documentary shelf',
    blurb: 'True stories, investigation and observation — non-fiction the editors rate.',
    category: 'documentary',
    entries: AUTHORS_CHOICE_DOCUMENTARIES,
    browseHref: '/documentaries',
  },
];

/** How many posters a collection stack shows on the home page. */
export const STACK_POSTERS = 3;

export function collectionHref(collection: Collection): string {
  return `/collections/${collection.slug}`;
}

/**
 * A collection as the home page shows it: the authored name and one-line note,
 * plus the first posters of the register as artwork. The stack is a *preview* of
 * a real collection page, never a second, separately-maintained list.
 */
export interface CollectionStack {
  slug: string;
  title: string;
  /** One line, written by an editor: why this collection exists. */
  blurb: string;
  href: string;
  posters: MediaItem[];
  count: number;
  previewNote: string;
}

export function collectionBySlug(slug: string): Collection | undefined {
  return COLLECTIONS.find((collection) => collection.slug === slug);
}

/** The authored note for a title inside a collection, when there is one. */
export function noteFor(collection: Collection, type: MediaType, id: number): string | null {
  const entry = collection.entries.find(
    (candidate) => candidate.tmdbId === id && candidate.mediaType === type
  );
  return entry?.note ?? null;
}
