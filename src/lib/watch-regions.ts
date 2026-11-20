// ISO 3166-1 alpha-2 assignments. A content market is an explicit preference,
// not the viewer's location or nationality. TMDB may have no data for a market.
const COUNTRY_CODES = 'AD AE AF AG AI AL AM AO AQ AR AS AT AU AW AX AZ BA BB BD BE BF BG BH BI BJ BL BM BN BO BQ BR BS BT BV BW BY BZ CA CC CD CF CG CH CI CK CL CM CN CO CR CU CV CW CX CY CZ DE DJ DK DM DO DZ EC EE EG EH ER ES ET FI FJ FK FM FO FR GA GB GD GE GF GG GH GI GL GM GN GP GQ GR GS GT GU GW GY HK HM HN HR HT HU ID IE IL IM IN IO IQ IR IS IT JE JM JO JP KE KG KH KI KM KN KP KR KW KY KZ LA LB LC LI LK LR LS LT LU LV LY MA MC MD ME MF MG MH MK ML MM MN MO MP MQ MR MS MT MU MV MW MX MY MZ NA NC NE NF NG NI NL NO NP NR NU NZ OM PA PE PF PG PH PK PL PM PN PR PS PT PW PY QA RE RO RS RU RW SA SB SC SD SE SG SH SI SJ SK SL SM SN SO SR SS ST SV SX SY SZ TC TD TF TG TH TJ TK TL TM TN TO TR TT TV TW TZ UA UG UM US UY UZ VA VC VE VG VI VN VU WF WS YE YT ZA ZM ZW' as const;
// Split() at runtime; infer the two-letter shape without a 249-level TS recursion.
type Letter = 'A' | 'B' | 'C' | 'D' | 'E' | 'F' | 'G' | 'H' | 'I' | 'J' | 'K' | 'L' | 'M' | 'N' | 'O' | 'P' | 'Q' | 'R' | 'S' | 'T' | 'U' | 'V' | 'W' | 'X' | 'Y' | 'Z';
export type WatchRegion = `${Letter}${Letter}`;
export const DEFAULT_WATCH_REGION: WatchRegion = 'US';

const names = new Intl.DisplayNames('en', { type: 'region' });
export const WATCH_REGIONS: Readonly<Partial<Record<WatchRegion, string>>> = Object.freeze(
  Object.fromEntries(COUNTRY_CODES.split(' ').map((code) => [code, names.of(code) ?? code]))
);

export function isWatchRegion(value: unknown): value is WatchRegion {
  return typeof value === 'string' && Object.hasOwn(WATCH_REGIONS, value);
}

export function normalizeWatchRegion(value: string): WatchRegion {
  const upper = (value || '').trim().toUpperCase();
  return isWatchRegion(upper) ? upper : DEFAULT_WATCH_REGION;
}

export function watchRegionName(region: WatchRegion): string {
  return WATCH_REGIONS[region] ?? region;
}

/** Grammatical form for headings such as “Popular in …” and “From …”. */
export function marketName(region: WatchRegion): string {
  const name = watchRegionName(region);
  return ['US', 'GB', 'AE', 'NL', 'PH', 'MV'].includes(region) ? `the ${name}` : name;
}

// The keys remain compatible with manual choices saved by previous releases.
export const WATCH_REGION_KEY = 'aalam.watch-region';
export const WATCH_REGION_MANUAL_KEY = 'aalam.watch-region.manual';
export const ACCOUNT_REGION_FIELD = 'aalam_content_region';

export function readManualWatchRegion(storage: Pick<Storage, 'getItem'>, userId?: string): WatchRegion | null {
  const suffix = userId ? `.user.${userId}` : '';
  try {
    const region = storage.getItem(`${WATCH_REGION_KEY}${suffix}`);
    return storage.getItem(`${WATCH_REGION_MANUAL_KEY}${suffix}`) === 'true' && isWatchRegion(region) ? region : null;
  } catch {
    return null;
  }
}

export function resolveWatchRegion(account: unknown, legacyAccount: unknown, guest: unknown) {
  if (isWatchRegion(account)) return { region: account, source: 'account' } as const;
  if (isWatchRegion(legacyAccount)) return { region: legacyAccount, source: 'account' } as const;
  if (isWatchRegion(guest)) return { region: guest, source: 'guest' } as const;
  return { region: DEFAULT_WATCH_REGION, source: 'default' } as const;
}

// Legacy playback detector helpers. Discovery never uses these to choose a market.
const TIMEZONE_TO_REGION: Record<string, WatchRegion> = {
  'Asia/Karachi': 'PK',
  'Asia/Kolkata': 'IN',
  'Asia/Calcutta': 'IN',
  'Europe/London': 'GB',
  'Asia/Dubai': 'AE',
  'Asia/Riyadh': 'SA',
  'Europe/Berlin': 'DE',
  'Europe/Munich': 'DE',
  'Europe/Paris': 'FR',
  'Europe/Madrid': 'ES',
  'Europe/Rome': 'IT',
  'Europe/Amsterdam': 'NL',
  'Europe/Istanbul': 'TR',
  'Asia/Istanbul': 'TR',
  'Asia/Tokyo': 'JP',
  'Asia/Seoul': 'KR',
  'Asia/Singapore': 'SG',
  'Asia/Kuala_Lumpur': 'MY',
  'Asia/Jakarta': 'ID',
  'America/Sao_Paulo': 'BR',
  'Australia/Sydney': 'AU',
  'Australia/Melbourne': 'AU',
  'Australia/Brisbane': 'AU',
  'Australia/Perth': 'AU',
  'America/Toronto': 'CA',
  'America/Vancouver': 'CA',
  'America/Montreal': 'CA',
  'America/Edmonton': 'CA',
  'America/Winnipeg': 'CA',
  'America/Halifax': 'CA',
};

export function regionFromTimezone(timeZone?: string | null): WatchRegion | null {
  if (!timeZone) return null;
  const trimmed = timeZone.trim();
  if (TIMEZONE_TO_REGION[trimmed]) return TIMEZONE_TO_REGION[trimmed];
  if (trimmed.startsWith('America/')) return 'US';
  if (trimmed.startsWith('Australia/')) return 'AU';
  return null;
}

export function regionFromAcceptLanguage(header?: string | null): WatchRegion | null {
  if (!header) return null;
  const tags = header.split(',').map((part) => part.split(';')[0]?.trim() || '');
  for (const tag of tags) {
    const match = /^[a-z]{2,3}[-_]([A-Za-z]{2})\b/.exec(tag);
    if (match) {
      const code = match[1].toUpperCase();
      if (isWatchRegion(code)) return code;
    }
  }
  return null;
}

export const REGION_SETTINGS_HREF = '/profile#content-region';
