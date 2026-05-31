// Post-scrape metadata enrichment: movie posters from TMDB, average ratings
// scraped from Letterboxd. Runs only in the scraper (which has a TMDB key and
// network egress); the web app just reads the stored values. Everything is
// best-effort and fault-tolerant — a failure leaves the field null and never
// breaks ingestion. AMC titles are messy ("MET Opera: ... (2026)", "Tekkonkinkreet
// 20th Anniversary"), so normalizeTitle cleans them before matching, and we
// prefer a blank over a wrong match.
import { prisma } from "./db";
import { classify } from "./classify";

function parseAttrs(json: string): string[] {
  try {
    const v = JSON.parse(json);
    return Array.isArray(v) ? v : [];
  } catch {
    return [];
  }
}

const TMDB_BASE = "https://api.themoviedb.org/3";
const TMDB_IMG = "https://image.tmdb.org/t/p/w342";
const LB_BASE = "https://letterboxd.com";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export interface NormalizedTitle {
  query: string; // cleaned title for searching
  year: number | null; // trailing (YYYY) if present — soft tiebreak only (often the re-release year)
  eventLike: boolean; // opera/sports/concert markers — skip when also flagged a special event
}

// Leading "this is a broadcast/series" prefixes that aren't part of the film title.
const LEADING_PREFIXES =
  /^(the\s+)?(met\s+opera|the\s+metropolitan\s+opera|fathom\s+events?|tcm|national\s+theatre\s+live|nt\s+live|rifftrax|bolshoi\s+ballet|royal\s+ballet|royal\s+opera)\s*:?\s*/i;
// Trailing re-release / edition / event suffixes, applied repeatedly (they stack).
const TRAILING_SUFFIXES =
  /\s*(\b\d{1,3}(st|nd|rd|th)\s+anniversary\b|\banniversary\b|\bencore\b|\bre-?release\b|\brestored\b|\brestoration\b|\bremastered\b|\bin\s+concert\b|\bsing-?along\b|\bdouble\s+feature\b|\bmarathon\b|\bdirector'?s\s+cut\b|\bextended\s+(edition|cut)\b|\bunrated\b|\bfan\s+first\s+premiere\b|\bsensory[\s-]?friendly(\s+screening)?\b|\bopen[\s-]?caption(ed)?\b|\bearly\s+access(\s+event)?\b|\bopening\s+night(\s+event)?\b|\badvance\s+screening\b|\bspecial\s+(engagement|screening)\b)\s*$/i;
// Bracketed format tags anywhere in the title.
const BRACKET_TAGS = /\s*[([](imax(\s*3d)?|3d|4k|70mm|dolby|dubbed|subtitled|sub|ov|omu)[)\]]/gi;
// Strong "not a catalog film" markers.
const EVENT_MARKERS =
  /\b(wwe|ufc|nxt|aew|wrestlemania|summerslam|royal\s+rumble|met\s+opera|metropolitan\s+opera|opera|ballet|in\s+concert|:\s*live)\b/i;

export function normalizeTitle(raw: string): NormalizedTitle {
  const original = raw.trim();
  let s = original;

  let year: number | null = null;
  const ym = s.match(/\s*\((\d{4})\)\s*$/);
  if (ym) {
    year = parseInt(ym[1], 10);
    s = s.slice(0, ym.index).trim();
  }

  s = s.replace(LEADING_PREFIXES, "").trim();
  s = s.replace(BRACKET_TAGS, "").trim();

  let prev: string;
  do {
    prev = s;
    s = s.replace(TRAILING_SUFFIXES, "").trim();
  } while (s !== prev);

  s = s
    .replace(/\s+/g, " ")
    .replace(/^[\s:–-]+|[\s:–-]+$/g, "")
    .trim();

  return {
    query: s || original,
    year,
    eventLike: EVENT_MARKERS.test(original),
  };
}

export interface TmdbResult {
  posterUrl: string | null;
  tmdbId: number | null;
  year: number | null; // release year of the matched film — used to disambiguate Letterboxd
}

interface TmdbSearchResult {
  id?: number;
  title?: string;
  poster_path?: string | null;
  release_date?: string;
}

// TMDB search is popularity-ranked, so for a low-popularity (often unreleased)
// title like "Toy Story 5" the first hit is frequently a poster-less stub or a
// more-popular wrong match. Score instead: exact/near title match, then year,
// then break ties toward a result that actually has poster art — falling back to
// TMDB's own order.
export function pickTmdbResult(
  results: TmdbSearchResult[],
  norm: NormalizedTitle,
): TmdbSearchResult | undefined {
  if (!results.length) return undefined;
  const norm0 = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");
  const q = norm.query.toLowerCase();
  const qc = norm0(norm.query);
  const score = (r: TmdbSearchResult) => {
    let s = 0;
    const t = (r.title ?? "").toLowerCase();
    if (t === q) s += 8;
    else if (norm0(t) === qc) s += 7;
    else if (t.startsWith(q) || q.startsWith(t)) s += 3;
    if (norm.year && (r.release_date ?? "").slice(0, 4) === String(norm.year)) s += 4;
    if (r.poster_path) s += 1; // tiebreak toward art
    return s;
  };
  return results
    .map((r, i) => ({ r, s: score(r), i }))
    .sort((a, b) => b.s - a.s || a.i - b.i)[0].r;
}

async function tmdbSearch(
  query: string,
  apiKey: string,
  signal: AbortSignal,
  retried = false,
): Promise<TmdbSearchResult[]> {
  const url = `${TMDB_BASE}/search/movie?api_key=${apiKey}&include_adult=false&query=${encodeURIComponent(query)}`;
  const res = await fetch(url, { signal });
  if (res.status === 429 && !retried) {
    const ra = Number(res.headers.get("retry-after")) || 1;
    await sleep(Math.min(ra, 10) * 1000);
    return tmdbSearch(query, apiKey, signal, true);
  }
  if (!res.ok) return [];
  const data = (await res.json()) as { results?: TmdbSearchResult[] };
  return Array.isArray(data.results) ? data.results : [];
}

export async function fetchTmdbPoster(
  norm: NormalizedTitle,
  opts: { apiKey?: string; signal?: AbortSignal } = {},
): Promise<TmdbResult> {
  const apiKey = opts.apiKey ?? process.env.TMDB_API_KEY;
  if (!apiKey) return { posterUrl: null, tmdbId: null, year: null };
  try {
    const signal = opts.signal ?? AbortSignal.timeout(8000);
    const results = await tmdbSearch(norm.query, apiKey, signal);
    const pick = pickTmdbResult(results, norm);
    if (!pick) return { posterUrl: null, tmdbId: null, year: null };
    const y = pick.release_date ? parseInt(pick.release_date.slice(0, 4), 10) : NaN;
    return {
      posterUrl: pick.poster_path ? `${TMDB_IMG}${pick.poster_path}` : null,
      tmdbId: typeof pick.id === "number" ? pick.id : null,
      year: Number.isNaN(y) ? null : y,
    };
  } catch {
    return { posterUrl: null, tmdbId: null, year: null };
  }
}

export interface LetterboxdResult {
  rating: number | null; // 0–5
  url: string | null;
}

function slugify(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/['’.]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

interface FilmLd {
  rating: number | null; // aggregateRating.ratingValue, 0–5
  year: number | null; // releasedEvent[0].startDate
}

// Letterboxd embeds film metadata as JSON-LD wrapped in a CDATA comment:
//   /* <![CDATA[ */ { "@type":"Movie", "aggregateRating": {...}, "releasedEvent": [...] } /* ]]> */
function parseFilmLd(html: string): FilmLd {
  const blocks = html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/gi);
  for (const b of blocks) {
    const body = b[1]
      .trim()
      .replace(/^\/\*\s*<!\[CDATA\[\s*\*\//, "")
      .replace(/\/\*\s*\]\]>\s*\*\/\s*$/, "")
      .trim();
    try {
      const json = JSON.parse(body) as {
        "@type"?: string;
        aggregateRating?: { ratingValue?: unknown };
        releasedEvent?: Array<{ startDate?: string }>;
      };
      if (json["@type"] !== "Movie" && json.aggregateRating === undefined) continue;
      let rating: number | null = null;
      const rv = json.aggregateRating?.ratingValue;
      if (rv !== undefined && rv !== null) {
        const v = Number(rv);
        if (!Number.isNaN(v)) rating = Math.round(v * 10) / 10;
      }
      let year: number | null = null;
      const sd = json.releasedEvent?.[0]?.startDate;
      if (sd) {
        const y = parseInt(String(sd).slice(0, 4), 10);
        if (!Number.isNaN(y)) year = y;
      }
      return { rating, year };
    } catch {
      // malformed block — try the next one
    }
  }
  return { rating: null, year: null };
}

async function fetchFilmPage(
  url: string,
  signal: AbortSignal,
): Promise<{ status: number } & FilmLd> {
  const res = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" }, signal });
  if (res.status === 404) return { status: 404, rating: null, year: null };
  if (!res.ok) return { status: res.status, rating: null, year: null };
  const html = await res.text();
  // A real Cloudflare interstitial has this title; the site also references
  // /cdn-cgi/challenge-platform/ on *every* normal page, so don't match on that.
  if (/<title>\s*just a moment/i.test(html)) return { status: 503, rating: null, year: null };
  return { status: 200, ...parseFilmLd(html) };
}

// Resolves the correct Letterboxd film and returns its average rating. The bare
// slug ("/film/passenger/") points at the canonical/oldest film of that title, so
// for a new release ("Passenger" -> 1963) we use the target year (from the TMDB
// match) to pick the year-suffixed slug Letterboxd uses to disambiguate. Network
// errors propagate (the caller keeps any existing value); a definitive "no
// right-year film" returns null so a wrong rating gets cleared rather than kept.
export async function fetchLetterboxdRating(
  norm: NormalizedTitle,
  opts: { signal?: AbortSignal; year?: number | null } = {},
): Promise<LetterboxdResult> {
  const slug = slugify(norm.query);
  if (!slug) return { rating: null, url: null };
  const sig = () => opts.signal ?? AbortSignal.timeout(8000);
  const target = opts.year ?? norm.year ?? null;
  const yearClose = (y: number | null) => target == null || y == null || Math.abs(y - target) <= 1;

  const bareUrl = `${LB_BASE}/film/${slug}/`;
  const bare = await fetchFilmPage(bareUrl, sig());

  // The bare slug is the right film when its year matches (or we have no year to check).
  if (bare.status === 200 && yearClose(bare.year)) {
    return { rating: bare.rating, url: bare.rating != null ? bareUrl : null };
  }

  // Otherwise the bare slug is a different-year film. Try the year-suffixed slugs
  // around the target (Letterboxd's slug year can be off by one from the US release).
  // Take the first that's a rated year-match — don't let an unrated same-title page
  // short-circuit the search before the rated one.
  if (target != null) {
    for (const y of [target, target - 1, target + 1]) {
      const altUrl = `${LB_BASE}/film/${slug}-${y}/`;
      const alt = await fetchFilmPage(altUrl, sig());
      if (alt.status === 200 && alt.rating != null && yearClose(alt.year)) {
        return { rating: alt.rating, url: altUrl };
      }
    }
    // No rated right-year film found — prefer no rating over a wrong one.
    return { rating: null, url: null };
  }

  // No year signal at all: fall back to the bare film if it exists.
  if (bare.status === 200) {
    return { rating: bare.rating, url: bare.rating != null ? bareUrl : null };
  }
  return { rating: null, url: null };
}

export interface EnrichStats {
  considered: number;
  tmdbHits: number;
  lbHits: number;
  misses: number;
  errors: number;
}

const DAY_MS = 86_400_000;

export async function enrichMovies(
  opts: {
    staleAfterDays?: number;
    missRetryDays?: number;
    maxMovies?: number;
    tmdbApiKey?: string;
    force?: boolean; // re-check every movie, ignoring the staleness gate
  } = {},
): Promise<EnrichStats> {
  const staleAfterDays = opts.staleAfterDays ?? 7;
  const missRetryDays = opts.missRetryDays ?? 30;
  const force = opts.force ?? false;
  const maxMovies = opts.maxMovies ?? (force ? 2000 : 300);
  const apiKey = opts.tmdbApiKey ?? process.env.TMDB_API_KEY;

  const now = Date.now();
  const staleDate = new Date(now - staleAfterDays * DAY_MS);
  const missDate = new Date(now - missRetryDays * DAY_MS);

  const where = force
    ? {}
    : {
        OR: [
          { metadataCheckedAt: null }, // never checked
          {
            // has data → refresh weekly (ratings drift slowly)
            metadataCheckedAt: { lt: staleDate },
            OR: [{ posterUrl: { not: null } }, { letterboxdRating: { not: null } }],
          },
          {
            // confident miss → retry monthly
            metadataCheckedAt: { lt: missDate },
            posterUrl: null,
            letterboxdRating: null,
          },
        ],
      };

  const movies = await prisma.movie.findMany({
    where,
    orderBy: { metadataCheckedAt: { sort: "asc", nulls: "first" } },
    take: maxMovies,
  });

  const stats: EnrichStats = { considered: movies.length, tmdbHits: 0, lbHits: 0, misses: 0, errors: 0 };

  for (const m of movies) {
    const norm = normalizeTitle(m.title);
    // Skip structural events (opera/sports/concert) so we never mis-match them.
    if ((m.isSpecialEvent && norm.eventLike) || !norm.query) {
      await prisma.movie
        .update({ where: { id: m.id }, data: { metadataCheckedAt: new Date() } })
        .catch(() => {});
      stats.misses++;
      continue;
    }

    try {
      // TMDB first so its matched release year can disambiguate the Letterboxd film.
      const tmdb = await fetchTmdbPoster(norm, { apiKey });
      let lb: LetterboxdResult | null = null;
      try {
        lb = await fetchLetterboxdRating(norm, { year: tmdb.year ?? norm.year });
      } catch {
        lb = null; // network failure — keep any existing rating
      }

      if (tmdb.posterUrl) stats.tmdbHits++;
      if (lb?.rating != null) stats.lbHits++;
      if (!tmdb.posterUrl && lb?.rating == null) stats.misses++;

      // Re-run classification now that we know the release year, so the
      // old-film => Classic/Fan Fave heuristic takes effect immediately.
      const year = tmdb.year ?? m.releaseYear ?? null;
      const cls = classify({ title: m.title, attributes: parseAttrs(m.attributes), releaseYear: year });

      await prisma.movie.update({
        where: { id: m.id },
        data: {
          // Posters: coalesce (never clear a good poster on a transient TMDB null).
          tmdbId: tmdb.tmdbId ?? m.tmdbId,
          posterUrl: tmdb.posterUrl ?? m.posterUrl,
          // Letterboxd: if the lookup actually ran (lb != null), trust its result even
          // when null — that's how a wrong match (e.g. 1963 "Passenger") gets corrected.
          letterboxdRating: lb ? lb.rating : m.letterboxdRating,
          letterboxdUrl: lb ? lb.url : m.letterboxdUrl,
          releaseYear: year,
          isClassic: cls.isClassic,
          isSpecialEvent: cls.isSpecialEvent,
          isIndie: cls.isIndie,
          isForeign: cls.isForeign,
          metadataCheckedAt: new Date(),
        },
      });
    } catch {
      stats.errors++;
    }

    await sleep(400); // be gentle on Letterboxd
  }

  return stats;
}
