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
// Words that mark a trailing parenthetical as an edition/event annotation (not part
// of the film's real title): "(2026 Event)", "(Director's Cut)", "(Ghibli Fest 2026)".
const PAREN_ANNOTATION =
  /\b(?:event|re-?release|re-?issue|edition|anniversary|presentation|encore|restored|remastered|in\s+concert|sing-?along|director'?s\s+cut|fan\s+event|special\s+(?:event|engagement|screening)|fest(?:ival)?|ghibli)\b/i;
// Matches a single trailing "(…)" / "[…]" group so it can be inspected and peeled.
const TRAILING_PAREN = /\s*[([]([^)\]]*)[)\]]\s*$/;
// A trailing " - <program>" segment AMC appends after the real title, e.g.
// "Ponyo - Studio Ghibli Fest 2026" or "… - 20th Anniversary". Only strips when
// the segment carries a program keyword (so real subtitles like "Mission:
// Impossible - Dead Reckoning" are left alone), and won't cross another " - ".
const PROGRAM_SUFFIX =
  /\s+[-–—]\s+(?:(?!\s[-–—]\s).)*\b(?:fest(?:ival)?|anniversar(?:y|ies)|presents?|presenta|fathom|in\s+concert|world\s+tour|live\s+viewing|studio\s+ghibli|ghibli\s+fest|sing[-\s]?along|double\s+feature)\b.*$/i;
// Strong "not a catalog film" markers.
const EVENT_MARKERS =
  /\b(wwe|ufc|nxt|aew|wrestlemania|summerslam|royal\s+rumble|met\s+opera|metropolitan\s+opera|opera|ballet|in\s+concert|:\s*live)\b/i;

export function normalizeTitle(raw: string): NormalizedTitle {
  const original = raw.trim();
  let s = original;

  // Strip bracketed format tags first so a trailing edition/event paren sitting
  // *before* a format tag (e.g. "… (2026 Event) (IMAX)") becomes the trailing group.
  s = s.replace(BRACKET_TAGS, "").trim();

  let year: number | null = null;
  // Peel trailing parentheticals that are edition/event annotations — a bare
  // "(YYYY)" or anything carrying a year or an annotation word like "(2026 Event)".
  // Capture the year (often the re-release/event year) as a soft tiebreak. Stop at a
  // paren that's part of the real title (e.g. "Birdman or (The Unexpected Virtue…)").
  for (;;) {
    const pm = s.match(TRAILING_PAREN);
    if (!pm) break;
    const ym = pm[1].match(/\b(\d{4})\b/);
    if (!ym && !PAREN_ANNOTATION.test(pm[1])) break;
    if (ym && year == null) year = parseInt(ym[1], 10);
    s = s.slice(0, pm.index).trim();
  }

  s = s.replace(LEADING_PREFIXES, "").trim();
  s = s.replace(PROGRAM_SUFFIX, "").trim();

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
  title: string | null; // canonical title — used to build the Letterboxd slug
  date: string | null; // full release_date (YYYY-MM-DD) — premiere vs re-screening signal
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

async function tmdbGetById(
  id: number,
  apiKey: string,
  signal: AbortSignal,
): Promise<TmdbSearchResult | undefined> {
  const res = await fetch(`${TMDB_BASE}/movie/${id}?api_key=${apiKey}`, { signal });
  if (!res.ok) return undefined;
  const m = (await res.json()) as TmdbSearchResult;
  return typeof m.id === "number" ? m : undefined;
}

export async function fetchTmdbPoster(
  norm: NormalizedTitle,
  opts: { apiKey?: string; signal?: AbortSignal; tmdbId?: number | null } = {},
): Promise<TmdbResult> {
  const apiKey = opts.apiKey ?? process.env.TMDB_API_KEY;
  const empty: TmdbResult = { posterUrl: null, tmdbId: null, year: null, title: null, date: null };
  if (!apiKey) return empty;
  try {
    const signal = opts.signal ?? AbortSignal.timeout(8000);
    // Already-resolved movies: fetch by id (1 request, no re-matching). Fall back
    // to a fresh text search if there's no id yet or the id lookup fails.
    let pick = opts.tmdbId ? await tmdbGetById(opts.tmdbId, apiKey, signal) : undefined;
    if (!pick) pick = pickTmdbResult(await tmdbSearch(norm.query, apiKey, signal), norm);
    if (!pick) return empty;
    const y = pick.release_date ? parseInt(pick.release_date.slice(0, 4), 10) : NaN;
    // Keep the full date only when it's a well-formed YYYY-MM-DD (TMDB can return "").
    const date = /^\d{4}-\d{2}-\d{2}$/.test(pick.release_date ?? "") ? pick.release_date! : null;
    return {
      posterUrl: pick.poster_path ? `${TMDB_IMG}${pick.poster_path}` : null,
      tmdbId: typeof pick.id === "number" ? pick.id : null,
      year: Number.isNaN(y) ? null : y,
      title: pick.title ?? null,
      date,
    };
  } catch {
    return empty;
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
// for a new release ("Passenger" -> 1963) the target year (from the TMDB match)
// selects the year-suffixed slug Letterboxd uses to disambiguate. We also try a
// slug built from TMDB's *canonical* title, since AMC's wording often differs
// ("Ballad of Ricky Bobby" vs Letterboxd's "The Ballad of Ricky Bobby"). The
// Letterboxd search endpoint is Cloudflare-gated, so slug guessing is all we have.
// Network errors propagate (the caller keeps any existing value); a definitive
// "no right-year film" returns null so a wrong rating is cleared rather than kept.
export async function fetchLetterboxdRating(
  norm: NormalizedTitle,
  opts: {
    signal?: AbortSignal;
    year?: number | null;
    altTitle?: string | null;
    knownUrl?: string | null;
  } = {},
): Promise<LetterboxdResult> {
  const sig = () => opts.signal ?? AbortSignal.timeout(8000);
  // Already-resolved movies: refresh the rating straight from the known film page
  // (1 request) instead of re-running slug guessing. Fall through if it's gone.
  if (opts.knownUrl) {
    const page = await fetchFilmPage(opts.knownUrl, sig());
    if (page.status === 200) return { rating: page.rating, url: opts.knownUrl };
  }
  const target = opts.year ?? norm.year ?? null;
  const yearClose = (y: number | null) => target == null || y == null || Math.abs(y - target) <= 1;

  // Candidate base slugs: AMC's wording first, then TMDB's canonical title.
  const bases = [...new Set([slugify(norm.query), opts.altTitle ? slugify(opts.altTitle) : ""])].filter(
    Boolean,
  );
  if (!bases.length) return { rating: null, url: null };

  let fallbackUrl: string | null = null; // a year-matching page that just has no rating yet
  for (const base of bases) {
    const candidates = [`${LB_BASE}/film/${base}/`];
    if (target != null) {
      for (const y of [target, target - 1, target + 1]) candidates.push(`${LB_BASE}/film/${base}-${y}/`);
    }
    for (const url of candidates) {
      const page = await fetchFilmPage(url, sig());
      if (page.status === 200 && yearClose(page.year)) {
        if (page.rating != null) return { rating: page.rating, url };
        fallbackUrl ??= url;
      }
    }
  }

  return { rating: null, url: fallbackUrl };
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
      // Reuse cached ids (tmdbId / letterboxdUrl) so re-checks skip search + slug
      // guessing — just refresh by id/url.
      const tmdb = await fetchTmdbPoster(norm, { apiKey, tmdbId: m.tmdbId });
      let lb: LetterboxdResult | null = null;
      try {
        lb = await fetchLetterboxdRating(norm, {
          year: tmdb.year ?? norm.year,
          altTitle: tmdb.title,
          knownUrl: m.letterboxdUrl,
        });
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
          // Full theatrical date: coalesce so a transient TMDB null never clears it.
          releaseDate: tmdb.date ? new Date(tmdb.date) : m.releaseDate,
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
