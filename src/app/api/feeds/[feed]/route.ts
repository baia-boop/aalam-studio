import { NextResponse } from 'next/server';
import { fetchAnimeFeed, fetchAuthorsChoice, fetchHomeFeed } from '@/lib/tmdb';
import {
  DEFERRED_FEEDS,
  isDeferredFeedName,
  splitAnimeFeed,
  splitHomeFeed,
} from '@/lib/feed-split';
import { compactFeed } from '@/lib/media-wire';
import { resolveCollectionStacks } from '@/lib/server-collections';

/**
 * Deferred rails and the Home recovery feed, cached on the same ISR schedule
 * as their pages. Anonymous and identical for every visitor: personalised
 * and regional rails never come from here.
 */
export const revalidate = 600;
export const dynamicParams = false;

export function generateStaticParams() {
  return DEFERRED_FEEDS.map((feed) => ({ feed }));
}

export async function GET(
  _request: Request,
  { params }: { params: Promise<{ feed: string }> }
) {
  const { feed } = await params;
  if (!isDeferredFeedName(feed)) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (feed === 'home-editorial') {
    return NextResponse.json(compactFeed({ items: await fetchAuthorsChoice('all', { authoredOnly: true }) }));
  }

  if (feed === 'home-full') {
    // The curated collections shelf lives here, not in the document: it needs a
    // detail request per poster, and the section sits below the fold.
    const full = await fetchHomeFeed();
    const collectionStacks = await resolveCollectionStacks();
    return NextResponse.json(
      compactFeed({ ...full, collectionStacks }, 'featured')
    );
  }

  const body = feed === 'anime-below'
    ? compactFeed(splitAnimeFeed(await fetchAnimeFeed()).below)
    : compactFeed({
        ...splitHomeFeed(await fetchHomeFeed()).below,
        collectionStacks: await resolveCollectionStacks(),
      });

  return NextResponse.json(body);
}
