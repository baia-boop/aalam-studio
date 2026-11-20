import { isReleased, isUpcoming } from '@/lib/release';
import {
  AnimeFeedData,
  ContinueItem,
  EpisodeItem,
  HomeFeedData,
  MediaDetail,
  MediaItem,
  MediaType,
  PaginatedResult,
} from '@/types/media';
import { WORLD_GENRES } from '@/lib/genres';
import { curatePopular } from '@/lib/home-curation';
import { THIRD_PARTY_SOURCES } from '@/lib/embed-sources';

const px = (id: number, w: number, h: number) =>
  `https://images.pexels.com/photos/${id}/pexels-photo-${id}.jpeg?auto=compress&cs=tinysrgb&fit=crop&w=${w}&h=${h}`;

type RawRow = [
  string,
  'movie' | 'series',
  string,
  number,
  string[],
  number,
  string,
  number,
  string,
  number,
  string,
  string,
];

const RAW: RawRow[] = [
  ['signal-from-kepler', 'movie', 'Signal From Kepler', 7661601, ['Sci-Fi', 'Drama'], 2025, '2h 18m', 8.4, 'PG-13', 6, 'The message was never meant for us.', 'When a deep-space relay catches a repeating pattern from a dead star system, flight engineer Mara Voss has eleven days to decide whether humanity should answer.'],
  ['kingdom-of-stone', 'series', 'Kingdom of Stone', 5278961, ['Fantasy', 'Drama'], 2022, '4 Seasons', 8.9, 'TV-MA', 6, 'Every throne is built on a grave.', 'Three rival houses fight for a crumbling temple-city whose faces of stone are said to remember every oath ever broken beneath them.'],
  ['the-last-caravan', 'movie', 'The Last Caravan', 29538371, ['Adventure', 'Drama'], 2024, '2h 31m', 8.1, 'PG-13', 6, 'Four hundred miles. One well.', 'A salt trader leads the final crossing of a vanishing desert route, carrying a secret that could save her village or scatter it for good.'],
  ['shibuya-after-dark', 'series', 'Shibuya After Dark', 2303337, ['Crime', 'Thriller', 'Animation'], 2024, '2 Seasons', 8.2, 'TV-MA', 6, 'The city never asks where you were.', 'A night-shift taxi dispatcher becomes the unwilling switchboard for a turf war that only exists between midnight and dawn.'],
  ['above-the-death-zone', 'movie', 'Above the Death Zone', 20558236, ['Documentary', 'Adventure'], 2024, '1h 36m', 8.6, 'PG', 6, '8,000 metres. No second takes.', 'Shot over two seasons, this documentary follows a rescue team working where helicopters cannot fly and every decision costs oxygen.'],
  ['orbital', 'series', 'Orbital', 7662605, ['Sci-Fi', 'Thriller'], 2023, '3 Seasons', 8.7, 'TV-14', 6, 'Six crew. One airlock. No alibi.', 'When a station commander is found dead ninety minutes before resupply, the remaining crew must solve the first murder in orbit, together.'],
  ['neon-monsoon', 'movie', 'Neon Monsoon', 12608643, ['Thriller', 'Crime', 'Animation'], 2025, '1h 54m', 7.8, 'R', 6, 'It rains harder on the guilty.', 'A courier with one last delivery is trapped in a flooded district as three different buyers close in on the same package.'],
  ['no-face', 'series', 'No Face', 1816868, ['Thriller', 'Crime'], 2021, '3 Seasons', 8.5, 'TV-MA', 6, 'He remembers everyone. No one remembers him.', 'A forensic sketch artist realises the suspect he has drawn for a dozen unrelated cases is always the same man.'],
  ['hollow-pines', 'movie', 'Hollow Pines', 14845826, ['Horror', 'Mystery'], 2023, '1h 42m', 7.1, 'R', 6, "The trail ends. The walking doesn't.", 'Four friends retrace a childhood camping trip and find the forest has kept a careful record of what they did there.'],
  ['the-winter-road', 'series', 'The Winter Road', 18634896, ['Mystery', 'Drama'], 2025, '1 Season', 8.0, 'TV-14', 6, 'One road in. Nobody saw her leave.', 'After the first snowfall closes the pass, a village constable has until the thaw to find out which of her neighbours is lying.'],
  ['keeper-of-the-light', 'movie', 'Keeper of the Light', 3722772, ['Drama', 'Mystery'], 2022, '2h 04m', 7.6, 'PG-13', 6, 'Some signals are for the living.', 'A lighthouse keeper due for retirement refuses to leave after the lamp begins answering a ship lost forty years earlier.'],
  ['two-on-mars', 'movie', 'Two on Mars', 8474466, ['Sci-Fi', 'Adventure'], 2024, '2h 02m', 7.9, 'PG-13', 6, 'Survival is a team sport.', 'Stranded ninety kilometres from their lander with one working suit radio, two rival mission specialists have to walk home.'],
  ['black-forest', 'series', 'Black Forest', 29546721, ['Horror', 'Mystery'], 2023, '2 Seasons', 7.7, 'TV-MA', 6, 'The old stories were warnings.', "A folklore archivist returns to her grandmother's village to catalogue its tales and discovers they are still being written."],
  ['red-hour', 'movie', 'Red Hour', 6695554, ['Thriller', 'Horror'], 2025, '1h 48m', 6.9, 'R', 0, 'Sixty minutes of darkroom light.', "A photographer developing a stranger's film roll watches a crime emerge frame by frame, and then recognises the room."],
  ['bosphorus-run', 'series', 'Bosphorus Run', 9743397, ['Action', 'Crime'], 2022, '2 Seasons', 7.5, 'TV-14', 6, 'Two continents. One tank of fuel.', 'A getaway driver who works both shores of Istanbul takes a job that puts her between her crew and her brother.'],
  ['midnight-lada', 'movie', 'Midnight Lada', 18126316, ['Crime', 'Action'], 2021, '1h 51m', 7.3, 'R', 6, 'It barely starts. It never stops.', 'Two cousins inherit a battered sedan with something sewn into the back seat, and one very long night to return it.'],
  ['temple-of-rain', 'movie', 'Temple of Rain', 13717510, ['Adventure', 'Action', 'Animation'], 2023, '2h 09m', 7.0, 'PG-13', 6, 'The jungle keeps what it is given.', 'A disgraced surveyor guides a film crew to a temple that appears on no map, and is asked not to map the way back.'],
  ['nomads', 'series', 'Nomads', 18131326, ['Documentary', 'Adventure'], 2024, '1 Season', 8.3, 'TV-PG', 6, 'Home is the direction you are walking.', "Six journeys, one quiet portrait of the people who still cross the world's great deserts on foot."],
  ['ridge', 'movie', 'Ridge', 28075918, ['Action', 'Adventure'], 2025, '1h 58m', 7.4, 'PG-13', 6, 'One rope. Two ways down.', 'A mountain guide discovers mid-ascent that her client hired her for the route, not the summit.'],
  ['glass-rain', 'series', 'Glass Rain', 28993172, ['Drama', 'Mystery', 'Animation'], 2025, '1 Season', 7.4, 'TV-14', 0, 'Everything looks softer from inside.', 'Over one wet autumn, three strangers who share a tram stop slowly realise they are part of the same story.'],
  ['the-quiet-door', 'movie', 'The Quiet Door', 19615558, ['Mystery', 'Thriller'], 2024, '1h 47m', 7.5, 'R', 6, 'She only had to not look.', 'A night nurse in a nearly empty care home notices that one door on the third floor is never quite closed.'],
  ['helmet-fire', 'series', 'Helmet Fire', 36772273, ['Sci-Fi', 'Action', 'Animation'], 2025, '1 Season', 7.6, 'TV-14', 6, 'Faster than thought. Barely.', "In an underground league of neural-linked racers, a rookie learns the champion's winning streak isn't hers alone."],
  ['sandline', 'movie', 'Sandline', 28638863, ['Action', 'Thriller'], 2022, '1h 57m', 6.8, 'R', 6, 'Nothing out here is neutral.', 'A border medic escorts a wounded stranger across open dunes while both sides of a ceasefire hunt for him.'],
  ['white-tigers', 'movie', 'White Tigers', 5685222, ['Documentary'], 2023, '1h 28m', 8.2, 'G', 6, 'The rarest family on Earth.', 'An intimate year with a family of white tigers reclaiming an abandoned hill fort, filmed almost entirely from a distance.'],
  ['summit-fever', 'series', 'Summit Fever', 14988129, ['Documentary', 'Adventure'], 2023, '2 Seasons', 7.9, 'TV-14', 6, 'The mountain is the easy part.', 'Inside a commercial expedition company during its most dangerous season, where the real climbing happens at base camp.'],
  ['vantablack', 'movie', 'Vantablack', 16077161, ['Drama', 'Thriller'], 2025, '2h 11m', 8.0, 'R', 6, 'The darkest thing in the room is the truth.', 'A celebrated painter loses her sight and gains an obsessive new assistant in the same week.'],
  ['lost-courtyard', 'series', 'The Lost Courtyard', 19142402, ['Adventure', 'Fantasy', 'Animation'], 2024, '2 Seasons', 7.8, 'TV-PG', 6, 'Some doors only open inward.', "Siblings exploring their late mother's research find a courtyard in the ruins that isn't there in daylight."],
  ['wet-asphalt', 'movie', 'Wet Asphalt', 14556059, ['Crime', 'Drama'], 2020, '2h 06m', 7.7, 'R', 6, 'Everyone owes somebody.', "Over one rainy weekend, a retiring detective calls in every favour he has to keep his partner's name out of a file."],
  ['whiteout-protocol', 'movie', 'Whiteout Protocol', 4638016, ['Thriller', 'Action'], 2024, '1h 44m', 6.7, 'PG-13', 6, 'Visibility: zero. Trust: less.', 'A polar research team loses contact with the outside world just as one of them starts transmitting on a private channel.'],
  ['mist-county', 'series', 'Mist County', 10486451, ['Mystery', 'Horror'], 2022, '3 Seasons', 7.9, 'TV-MA', 6, 'Population: declining.', 'A new sheriff inherits a county where the fog arrives on schedule and the missing-persons board is never empty.'],
  ['far-dunes', 'movie', 'Far Dunes', 34593219, ['Documentary', 'Adventure'], 2023, '2h 14m', 7.6, 'PG', 6, 'He went looking for silence.', "A burnt-out composer walks into the desert with a field recorder and comes back with something he didn't write."],
  ['the-getaway-years', 'movie', 'The Getaway Years', 19355104, ['Crime', 'Action'], 2020, '1h 49m', 7.2, 'R', 6, 'Retirement was the hardest job.', 'Forty years after their last heist, three old friends take the same car out for one final, very slow chase.'],
];

interface RawMeta {
  pexelsId: number;
  seasons: number;
  tagline: string;
}

const RAW_META_MAP = new Map<string, RawMeta>();

const GENRE_NAME_TO_ID: Record<string, number> = {
  Action: 28,
  Adventure: 12,
  Animation: 16,
  Comedy: 35,
  Crime: 80,
  Documentary: 99,
  Drama: 18,
  Fantasy: 14,
  Horror: 27,
  Mystery: 9648,
  Romance: 10749,
  'Sci-Fi': 878,
  Thriller: 53,
};

// Original, locally bundled key art keeps the first sample screen usable
// offline. These remain fictional sample titles, never live/provider claims.
const SAMPLE_ART: Record<string, { poster: string; backdrop?: string }> = {
  'signal-from-kepler': {
    poster: '/images/sample/signal-poster.webp',
    backdrop: '/images/sample/signal-hero.webp',
  },
  'kingdom-of-stone': { poster: '/images/sample/kingdom-poster.webp' },
  'above-the-death-zone': { poster: '/images/sample/death-zone-poster.webp' },
};

export const FALLBACK_TITLES: MediaItem[] = RAW.map((r, i) => {
  const type: MediaType = r[1] === 'series' ? 'tv' : 'movie';
  const seasons = type === 'tv' ? parseInt(r[6], 10) || 1 : 0;
  RAW_META_MAP.set(r[0], { pexelsId: r[3], seasons, tagline: r[10] });
  const srcCount = r[9] > 0 ? THIRD_PARTY_SOURCES.length : 0;
  return {
    id: r[0],
    type,
    title: r[2],
    posterUrl: SAMPLE_ART[r[0]]?.poster || px(r[3], 400, 600),
    backdropUrl: SAMPLE_ART[r[0]]?.backdrop || px(r[3], 1920, 1080),
    backdropThumbUrl: SAMPLE_ART[r[0]]?.backdrop || px(r[3], 640, 360),
    genres: r[4],
    genreIds: r[4].map((g) => GENRE_NAME_TO_ID[g] || 18),
    year: String(r[5]),
    lengthLabel: r[6],
    rating: r[7],
    voteCount: 0, // Sample data does not carry real TMDB votes.
    popularity: 100 - i,
    cert: r[8],
    sourcesCount: srcCount,
    tagline: r[10],
    overview: r[11],
    editorialNote: r[10],
  };
});

const byId = (id: string) => FALLBACK_TITLES.find((t) => t.id === id);

const FEAT_IDS = [
  'signal-from-kepler',
  'kingdom-of-stone',
  'above-the-death-zone',
  'orbital',
  'the-last-caravan',
];

const TODAY_IDS = [
  'signal-from-kepler',
  'kingdom-of-stone',
  'above-the-death-zone',
  'orbital',
  'the-last-caravan',
  'shibuya-after-dark',
  'no-face',
  'neon-monsoon',
  'vantablack',
  'two-on-mars',
];

const WEEK_IDS = [
  'the-winter-road',
  'helmet-fire',
  'ridge',
  'black-forest',
  'keeper-of-the-light',
  'bosphorus-run',
  'hollow-pines',
  'nomads',
  'the-quiet-door',
  'mist-county',
  'temple-of-rain',
  'lost-courtyard',
];

const NAMES = [
  'Idris Okafor',
  'Lena Brandt',
  'Kenji Arai',
  'Sofia Marchetti',
  'Tomás Rey',
  'Anika Rao',
  'Jonas Lindqvist',
  'Amal Haddad',
  'Noor Sayegh',
  'Callum Reyes',
  'Yuki Tanabe',
  'Elif Demir',
];

const ROLES = [
  'The Lead',
  'The Stranger',
  'Dr. Halloran',
  'Inspector Wei',
  'Tavi',
  'The Keeper',
  'Old Sam',
  'Juno',
];

const DIRS = [
  'Elena Vasquez',
  'Haruto Sakamoto',
  'Daniel Achebe',
  'Ingrid Solheim',
  'Rafael Monteiro',
];

const EPS = [
  'Pilot Light',
  'Dead Reckoning',
  'The Long Dark',
  'Signal Loss',
  'Borrowed Time',
  'Crosswinds',
  'What Remains',
  'Zero Hour',
  'Afterglow',
  'The Far Shore',
];

const BLURBS = [
  'An unexpected arrival forces everyone to pick a side.',
  'A small lie told weeks ago starts to cost more than the truth.',
  'With time running short, an old route becomes the only option.',
  'Two rivals compare notes and find the same name in both.',
  'A night that should have been quiet turns into the longest of the season.',
  'The plan works. That turns out to be the problem.',
  'Someone who left comes back with a different story.',
  'Everything set in motion finally arrives at the same door.',
];

export const DEFAULT_CONTINUE_SEED: ContinueItem[] = [
  { id: 'orbital', s: 2, e: 4, pct: 62, left: '18 min left' },
  { id: 'the-last-caravan', pct: 34, left: '1h 39m left' },
  { id: 'no-face', s: 1, e: 7, pct: 81, left: '9 min left' },
  { id: 'shibuya-after-dark', s: 1, e: 2, pct: 12, left: '44 min left' },
  { id: 'two-on-mars', pct: 55, left: '55 min left' },
]
  .map((c, idx) => {
    const item = byId(c.id);
    if (!item) return null;
    return {
      key: `${item.type}:${item.id}`,
      item,
      season: c.s,
      episode: c.e,
      pct: c.pct,
      leftLabel: c.left,
      server: THIRD_PARTY_SOURCES[0].id,
      updatedAt: Date.now() - idx * 1000,
    } as ContinueItem;
  })
  .filter((x): x is ContinueItem => Boolean(x));

export const DEFAULT_WATCHLIST_SEED: MediaItem[] = [
  'orbital',
  'the-last-caravan',
  'no-face',
  'above-the-death-zone',
]
  .map((id) => byId(id))
  .filter((x): x is MediaItem => Boolean(x));

export function getFallbackHomeFeed(): HomeFeedData {
  const worldBackdrops: Record<string, { imageUrl: string; countLabel: string }> = {};
  for (const w of WORLD_GENRES) {
    const count = FALLBACK_TITLES.filter(
      (t) => t.type === 'movie' && t.genres.includes(w.genre)
    ).length;
    worldBackdrops[w.genre] = {
      imageUrl: px(w.fallbackPexelsId, 480, 600),
      countLabel: `${count} movies`,
    };
  }

  return {
    featured: FEAT_IDS.map((id) => byId(id)).filter((x): x is MediaItem => Boolean(x)),
    trendingToday: TODAY_IDS.map((id) => byId(id)).filter((x): x is MediaItem => Boolean(x)),
    trendingWeek: WEEK_IDS.map((id) => byId(id)).filter((x): x is MediaItem => Boolean(x)),
    topRated: [...FALLBACK_TITLES].sort((a, b) => b.rating - a.rating).slice(0, 12),
    popularMovies: FALLBACK_TITLES.filter((t) => t.type === 'movie'),
    popularSeries: FALLBACK_TITLES.filter((t) => t.type === 'tv'),
    readyToPlay: FALLBACK_TITLES.filter(
      (t) => t.sourcesCount >= 2 && !TODAY_IDS.includes(t.id)
    ).slice(0, 12),
    popularNow: curatePopular(
      [
        ...WEEK_IDS.map((id) => byId(id)).filter((x): x is MediaItem => Boolean(x)),
        ...FALLBACK_TITLES.filter((t) => t.type === 'movie'),
        ...FALLBACK_TITLES.filter((t) => t.type === 'tv'),
      ],
      { limit: 14 }
    ),
    // Sample records carry no release dates, so nothing here is "coming soon":
    // the shelf stays hidden rather than inventing a date for a fake title.
    comingSoon: [],
    collectionStacks: [],
    topRatedPick: byId('vantablack') || FALLBACK_TITLES[0],
    worldBackdrops,
    isLive: false,
  };
}

export function getFallbackAnimeFeed(): AnimeFeedData {
  const animItems = FALLBACK_TITLES.filter((t) => t.genres.includes('Animation'));
  const pool = animItems.length >= 4 ? animItems : FALLBACK_TITLES.slice(0, 10);
  return {
    featured: pool.slice(0, 4),
    popularSeries: pool.filter((t) => t.type === 'tv'),
    animeMovies: pool.filter((t) => t.type === 'movie'),
    topRated: [...pool].sort((a, b) => b.rating - a.rating),
    newReleases: [...pool].sort((a, b) => Number(b.year) - Number(a.year)),
    isLive: false,
  };
}

export function getFallbackBrowse(
  mode: 'movie' | 'tv' | 'anime' | 'documentary',
  genre: string,
  sort: string,
  onlyWithSources: boolean
): PaginatedResult {
  const items = FALLBACK_TITLES.filter((t) => {
    const modeOk =
      mode === 'anime'
        ? t.genres.includes('Animation')
        : mode === 'documentary'
          ? t.genres.includes('Documentary')
          : t.type === mode;
    return (
      modeOk &&
      (sort === 'coming_soon' ? isUpcoming(t) : sort === 'popularity' ? isReleased(t) : true) &&
      (!genre || t.genres.includes(genre)) &&
      (!onlyWithSources || t.sourcesCount > 0)
    );
  });

  if (sort === 'popularity' || sort === 'coming_soon') items.sort((a, b) => b.popularity - a.popularity);
  else if (sort === 'top_rated') items.sort((a, b) => b.rating - a.rating);
  else if (sort === 'newest') items.sort((a, b) => Number(b.year) - Number(a.year));
  else if (sort === 'az') items.sort((a, b) => a.title.localeCompare(b.title));

  return {
    items,
    page: 1,
    totalPages: 1,
    totalResults: items.length,
    isLive: false,
  };
}

export function getFallbackDetail(id: string): MediaDetail | null {
  const t = byId(id);
  if (!t) return null;
  const idx = FALLBACK_TITLES.indexOf(t);
  const meta = RAW_META_MAP.get(t.id);
  const seasonsCount = meta?.seasons || (t.type === 'tv' ? 1 : 0);

  const m = /(\d+)h\s*(\d+)m/.exec(t.lengthLabel);
  const runtimeMinutes = m ? Number(m[1]) * 60 + Number(m[2]) : 110;

  const related = FALLBACK_TITLES.filter((x) => x.id !== t.id)
    .map(
      (x) =>
        [
          x,
          x.genres.filter((g) => t.genres.includes(g)).length +
            (x.type === t.type ? 0.5 : 0),
        ] as const
    )
    .filter((r) => r[1] >= 1)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map((r) => r[0]);

  return {
    ...t,
    tagline: t.tagline || '',
    status: t.type === 'tv' ? 'Returning Series' : 'Released',
    releaseDate: t.year,
    runtimeMinutes,
    seasonsCount,
    episodesCount: seasonsCount * 8,
    seasons: Array.from({ length: seasonsCount }, (_, k) => ({
      seasonNumber: k + 1,
      name: `Season ${k + 1}`,
      episodeCount: 8,
    })),
    creatorOrDirector: DIRS[idx % DIRS.length],
    originalLanguage: 'EN',
    networkOrStudio: 'AALAM Studio',
    cast: Array.from({ length: 6 }, (_, k) => ({
      id: `${t.id}-cast-${k}`,
      name: NAMES[(idx * 3 + k) % NAMES.length],
      character: ROLES[(idx + k) % ROLES.length],
      profileUrl: null,
    })),
    videos: [],
    trailerKey: null,
    related,
    imdbId: null,
  };
}

export function getFallbackSeasonEpisodes(
  id: string,
  seasonNumber: number
): EpisodeItem[] {
  const meta = RAW_META_MAP.get(id);
  const pexelsId = meta?.pexelsId || 7662605;
  return Array.from({ length: 8 }, (_, k) => ({
    episodeNumber: k + 1,
    seasonNumber,
    name: EPS[(k + seasonNumber * 3) % EPS.length],
    overview: BLURBS[(k + seasonNumber) % BLURBS.length],
    stillUrl: px(pexelsId, 720, 405),
    runtime: 42 + ((k * 7 + seasonNumber * 5) % 17),
  }));
}

export function getFallbackSearch(
  query: string,
  filterType: 'all' | MediaType
): PaginatedResult {
  const ql = query.trim().toLowerCase();
  const pool = FALLBACK_TITLES.filter(
    (t) => filterType === 'all' || t.type === filterType
  );
  if (!ql) {
    return {
      items: pool.slice(0, 12),
      page: 1,
      totalPages: 1,
      totalResults: pool.length,
      isLive: false,
    };
  }
  const res = pool.filter((t) =>
    `${t.title} ${t.genres.join(' ')} ${t.year} ${
      t.type === 'movie' ? 'movie' : 'series tv'
    }`
      .toLowerCase()
      .includes(ql)
  );
  return {
    items: res,
    page: 1,
    totalPages: 1,
    totalResults: res.length,
    isLive: false,
  };
}
