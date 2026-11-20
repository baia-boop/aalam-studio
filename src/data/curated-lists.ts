import { MediaType } from '@/types/media';

export interface CuratedChoiceItem {
  tmdbId: number;
  mediaType: MediaType;
  note: string;
}

export interface OnboardingSeedItem {
  tmdbId: number;
  mediaType: MediaType;
  title: string;
  genre: string;
  genreIds: number[];
  posterPath: string;
}

export const AUTHORS_CHOICE_MOVIES: readonly CuratedChoiceItem[] = [
  { tmdbId: 238, mediaType: 'movie', note: 'The ultimate crime epic.' },
  { tmdbId: 278, mediaType: 'movie', note: 'Hope can set you free.' },
  { tmdbId: 155, mediaType: 'movie', note: 'A legendary villain.' },
  { tmdbId: 27205, mediaType: 'movie', note: 'Dreams within dreams.' },
  { tmdbId: 157336, mediaType: 'movie', note: 'Love beyond dimensions.' },
  { tmdbId: 496243, mediaType: 'movie', note: 'Class warfare satire.' },
  { tmdbId: 129, mediaType: 'movie', note: 'Studio Ghibli magic.' },
  { tmdbId: 335984, mediaType: 'movie', note: 'Neo-noir sci-fi perfection.' },
  { tmdbId: 438631, mediaType: 'movie', note: 'Arrakis brought to life.' },
  { tmdbId: 872585, mediaType: 'movie', note: 'Prometheus unbound.' },
  { tmdbId: 244786, mediaType: 'movie', note: 'Relentless obsession.' },
  { tmdbId: 680, mediaType: 'movie', note: 'Dialogue-driven brilliance.' },
  { tmdbId: 1124, mediaType: 'movie', note: 'Every great magic trick.' },
  { tmdbId: 603, mediaType: 'movie', note: 'Reality is a construct.' },
  { tmdbId: 76341, mediaType: 'movie', note: 'Pure kinetic cinema.' },
  { tmdbId: 545611, mediaType: 'movie', note: 'Chaos and kindness.' },
  { tmdbId: 329865, mediaType: 'movie', note: 'Language shapes time.' },
  { tmdbId: 807, mediaType: 'movie', note: 'Rain-soaked dread.' },
];

export const AUTHORS_CHOICE_TV: readonly CuratedChoiceItem[] = [
  { tmdbId: 1396, mediaType: 'tv', note: 'Chemistry and consequences.' },
  { tmdbId: 95396, mediaType: 'tv', note: 'Workplace dystopia.' },
  { tmdbId: 87108, mediaType: 'tv', note: 'The cost of lies.' },
  { tmdbId: 94605, mediaType: 'tv', note: 'Animation elevated to art.' },
  { tmdbId: 70523, mediaType: 'tv', note: 'Everything is connected.' },
  { tmdbId: 1399, mediaType: 'tv', note: 'Fantasy redefined.' },
  { tmdbId: 46648, mediaType: 'tv', note: 'Time is a flat circle.' },
  { tmdbId: 100088, mediaType: 'tv', note: 'Endure and survive.' },
  { tmdbId: 83867, mediaType: 'tv', note: 'Rebellion from the ground up.' },
  { tmdbId: 42009, mediaType: 'tv', note: 'Tech paranoia.' },
  { tmdbId: 19885, mediaType: 'tv', note: 'Modern detective mastery.' },
  { tmdbId: 67070, mediaType: 'tv', note: 'Razor-sharp wit and grief.' },
  { tmdbId: 124364, mediaType: 'tv', note: 'No road leads out.' },
  { tmdbId: 82856, mediaType: 'tv', note: 'This is the way.' },
];

export const AUTHORS_CHOICE_ANIME: readonly CuratedChoiceItem[] = [
  { tmdbId: 209867, mediaType: 'tv', note: 'What comes after the quest.' },
  { tmdbId: 1429, mediaType: 'tv', note: 'Humanity behind the walls.' },
  { tmdbId: 31911, mediaType: 'tv', note: 'Equivalent exchange.' },
  { tmdbId: 372058, mediaType: 'movie', note: 'Two lives, one comet.' },
  { tmdbId: 129, mediaType: 'movie', note: 'Ghibli at its peak.' },
  { tmdbId: 13916, mediaType: 'tv', note: 'A notebook that kills.' },
  { tmdbId: 30991, mediaType: 'tv', note: 'See you, space cowboy.' },
  { tmdbId: 42509, mediaType: 'tv', note: 'Time travel done right.' },
  { tmdbId: 88803, mediaType: 'tv', note: 'You have no enemies.' },
  { tmdbId: 95479, mediaType: 'tv', note: 'Curses and sorcerers.' },
  { tmdbId: 85937, mediaType: 'tv', note: 'Breathtaking animation.' },
  { tmdbId: 128, mediaType: 'movie', note: 'Nature fights back.' },
  { tmdbId: 149, mediaType: 'movie', note: 'Neo-Tokyo is about to explode.' },
  { tmdbId: 378064, mediaType: 'movie', note: 'Redemption in silence.' },
];

export const AUTHORS_CHOICE_DOCUMENTARIES: readonly CuratedChoiceItem[] = [
  { tmdbId: 1044, mediaType: 'tv', note: 'Our living planet.' },
  { tmdbId: 58474, mediaType: 'tv', note: 'Across space and time.' },
  { tmdbId: 74313, mediaType: 'tv', note: 'Depths of the ocean.' },
  { tmdbId: 79525, mediaType: 'tv', note: 'Six rings, one dynasty.' },
  { tmdbId: 515042, mediaType: 'movie', note: '3,000 feet without a rope.' },
  { tmdbId: 549559, mediaType: 'movie', note: 'Moon landing, 70mm restored.' },
  { tmdbId: 87083, mediaType: 'tv', note: 'Milliseconds decide everything.' },
  { tmdbId: 682110, mediaType: 'movie', note: 'An unlikely kelp-forest bond.' },
  { tmdbId: 62391, mediaType: 'tv', note: 'Craft on a plate.' },
  { tmdbId: 95171, mediaType: 'tv', note: 'Earth 66 million years ago.' },
  { tmdbId: 318279, mediaType: 'movie', note: 'The Shark’s Fin ascent.' },
  { tmdbId: 46434, mediaType: 'tv', note: 'History told firsthand.' },
];

export const CINEMATCH_MIN_SELECTIONS = 1;

export const CINEMATCH_ONBOARDING_TITLES: readonly OnboardingSeedItem[] = [
  { tmdbId: 129, mediaType: 'movie', title: 'Spirited Away', genre: 'Animation', genreIds: [16, 10751, 14], posterPath: '/39wmItIWsg5sZMyRUHLkWBcuVCM.jpg' },
  { tmdbId: 2316, mediaType: 'tv', title: 'The Office', genre: 'Comedy', genreIds: [35], posterPath: '/qWnJzyZhyy74gjpSjIXWmuk0ifX.jpg' },
  { tmdbId: 155, mediaType: 'movie', title: 'The Dark Knight', genre: 'Action', genreIds: [28, 80, 18], posterPath: '/qJ2tW6WMUDux911r6m7haRef0WH.jpg' },
  { tmdbId: 313369, mediaType: 'movie', title: 'La La Land', genre: 'Romance', genreIds: [35, 18, 10749], posterPath: '/uDO8zWDhfWwoFdKS4fzkUJt0Rf0.jpg' },
  { tmdbId: 157336, mediaType: 'movie', title: 'Interstellar', genre: 'Sci-Fi', genreIds: [12, 18, 878], posterPath: '/gEU2QniE6E77NI6lCU6MxlNBvIx.jpg' },
  { tmdbId: 1396, mediaType: 'tv', title: 'Breaking Bad', genre: 'Crime', genreIds: [18, 80], posterPath: '/ztkUQFLlC19CCMYHW9o1zWhJRNq.jpg' },
  { tmdbId: 87108, mediaType: 'tv', title: 'Chernobyl', genre: 'Drama', genreIds: [18], posterPath: '/hlLXt2tOPT6RRnjiUmoxyG1LTFi.jpg' },
  { tmdbId: 419430, mediaType: 'movie', title: 'Get Out', genre: 'Horror', genreIds: [9648, 53, 27], posterPath: '/tFXcEccSQMf3lfhfXKSU9iRBpa3.jpg' },
  { tmdbId: 1399, mediaType: 'tv', title: 'Game of Thrones', genre: 'Fantasy', genreIds: [10765, 18, 10759], posterPath: '/1XS1oqL89opfnbLl8WnZY1O1uJx.jpg' },
  { tmdbId: 1429, mediaType: 'tv', title: 'Attack on Titan', genre: 'Anime', genreIds: [16, 10765, 10759], posterPath: '/hTP1DtLGFamjfu8WqjnuQdP1n4i.jpg' },
  { tmdbId: 95396, mediaType: 'tv', title: 'Severance', genre: 'Mystery', genreIds: [18, 9648, 10765], posterPath: '/pPHpeI2X1qEd1CS1SeyrdhZ4qnT.jpg' },
  { tmdbId: 27205, mediaType: 'movie', title: 'Inception', genre: 'Sci-Fi', genreIds: [28, 878, 12], posterPath: '/ljsZTbVsrQSqZgWeep2B1QiDKuh.jpg' },
  { tmdbId: 76341, mediaType: 'movie', title: 'Mad Max: Fury Road', genre: 'Action', genreIds: [28, 12, 878], posterPath: '/8tZYtuWezp8JbcsvHYO0O46tFbo.jpg' },
  { tmdbId: 245891, mediaType: 'movie', title: 'John Wick', genre: 'Action', genreIds: [28, 53], posterPath: '/fZPSd91yGE9fCcCe6OoQr6E3Bev.jpg' },
  { tmdbId: 299534, mediaType: 'movie', title: 'Avengers: Endgame', genre: 'Action', genreIds: [12, 878, 28], posterPath: '/or06FN3Dka5tukK1e9sl16pB3iy.jpg' },
  { tmdbId: 438631, mediaType: 'movie', title: 'Dune', genre: 'Sci-Fi', genreIds: [878, 12], posterPath: '/d5NXSklXo0qyIYkgV94XAgMIckC.jpg' },
  { tmdbId: 603, mediaType: 'movie', title: 'The Matrix', genre: 'Sci-Fi', genreIds: [28, 878], posterPath: '/f89U3ADr1oiB1s9GkdPOEpXUk5H.jpg' },
  { tmdbId: 335984, mediaType: 'movie', title: 'Blade Runner 2049', genre: 'Sci-Fi', genreIds: [878, 18], posterPath: '/gajva2L0rPYkEWjzgFlBXCAVBE5.jpg' },
  { tmdbId: 238, mediaType: 'movie', title: 'The Godfather', genre: 'Drama', genreIds: [18, 80], posterPath: '/3bhkrj58Vtu7enYsRolD1fZdja1.jpg' },
  { tmdbId: 278, mediaType: 'movie', title: 'Shawshank Redemption', genre: 'Drama', genreIds: [18, 80], posterPath: '/9cqNxx0GxF0bflZmeSMuL5tnGzr.jpg' },
  { tmdbId: 496243, mediaType: 'movie', title: 'Parasite', genre: 'Drama', genreIds: [35, 53, 18], posterPath: '/7IiTTgloJzvGI1TAYymCfbfl3vT.jpg' },
  { tmdbId: 11324, mediaType: 'movie', title: 'Shutter Island', genre: 'Thriller', genreIds: [18, 53, 9648], posterPath: '/4GDy0PHYX3VRXUtwK5ysFbg3kEx.jpg' },
  { tmdbId: 680, mediaType: 'movie', title: 'Pulp Fiction', genre: 'Thriller', genreIds: [53, 80], posterPath: '/d5iIlFn5s0ImszYzBPb8JPIfbXD.jpg' },
  { tmdbId: 324857, mediaType: 'movie', title: 'Into the Spider-Verse', genre: 'Animation', genreIds: [28, 12, 16], posterPath: '/iiZZdoQBEYBv6id8su7ImL0oCbD.jpg' },
  { tmdbId: 94605, mediaType: 'tv', title: 'Arcane', genre: 'Animation', genreIds: [16, 10765, 10759], posterPath: '/fqldf2t8ztc9aiwn3k6mlX3tvRT.jpg' },
  { tmdbId: 60574, mediaType: 'tv', title: 'Peaky Blinders', genre: 'Crime', genreIds: [18, 80], posterPath: '/vUUqzWa2LnHIVqkaKVlVGkVcZIW.jpg' },
  { tmdbId: 66732, mediaType: 'tv', title: 'Stranger Things', genre: 'Sci-Fi', genreIds: [18, 10765, 9648], posterPath: '/49WJfeN0moxb9IPfGn8AIqMGskD.jpg' },
  { tmdbId: 372058, mediaType: 'movie', title: 'Your Name.', genre: 'Anime', genreIds: [16, 10749, 18], posterPath: '/q719jXXEzOoYaps6babgKnONONX.jpg' },
];
