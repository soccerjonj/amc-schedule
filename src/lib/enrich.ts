// Post-scrape metadata enrichment: movie posters from TMDB, average ratings
// scraped from Letterboxd. Runs only in the ingestion job (which has a TMDB key and
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
  /\s*(\bcelebrates\s+(?:its\s+)?(?:\d{1,3}(?:st|nd|rd|th)\s+)?anniversary\b|\b\d{1,3}(st|nd|rd|th)\s+anniversary\b|\banniversary\b|\bencore\b|\bre-?release\b|\brestored\b|\brestoration\b|\bremastered\b|\bin\s+concert\b|\bsing-?along\b|\bdouble\s+feature\b|\bmarathon\b|\bdirector'?s\s+cut\b|\bextended\s+(edition|cut)\b|\bunrated\b|\bfan\s+first(\s+(?:premiere|screenings?|event))?\b|\bsensory[\s-]?friendly(\s+screening)?\b|\bopen[\s-]?caption(ed)?\b|\bearly\s+access(\s+event)?\b|\bopening\s+night(\s+(fan\s+)?event)?\b|\badvance\s+screening\b|\bspecial\s+(engagement|screening)\b|\bimax(?:\s+3d)?\b|\bdolby(?:\s+(?:cinema|atmos|vision|3d))?\b)\s*$/i;
// Bracketed format tags anywhere in the title.
const BRACKET_TAGS = /\s*[([](imax(\s*3d)?|3d|4k|70mm|dolby|dubbed|subtitled|sub|ov|omu)[)\]]/gi;
// Words that mark a trailing parenthetical as an edition/event annotation (not part
// of the film's real title): "(2026 Event)", "(Director's Cut)", "(Ghibli Fest 2026)".
// AMC's short program codes in a trailing paren: "(re)" re-release, "(RE26)"
// re-release 2026, "(HFS26)" Holiday Fan Series 2026. The digits are the program
// year, not the film's, so they're stripped without becoming the year tiebreak.
const PAREN_PROGRAM_CODE = /^\s*(re|[a-z]{1,4}\d{2})\s*$/i;
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
    if (!ym && !PAREN_ANNOTATION.test(pm[1]) && !PAREN_PROGRAM_CODE.test(pm[1])) break;
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
  year: number | null; // release year of the matched film
  title: string | null; // TMDB's canonical title
  date: string | null; // full release_date (YYYY-MM-DD) — premiere vs re-screening signal
  runtime: number | null; // minutes, from the TMDB movie detail
  cert: string | null; // US MPAA certification, e.g. "PG-13"
}

/**
 * What AMC tells us about the film actually screening — used to verify a TMDB
 * match instead of trusting the title alone (remakes and same-titled films).
 */
export interface MatchContext {
  directors?: string[]; // AMC's director list
  runtime?: number | null; // AMC's runtime, minutes
  amcYear?: number | null; // AMC release year (a re-release year for old films)
  reRelease?: boolean; // AMC labels it an anniversary / re-release / Fan Faves screening
}

export type TmdbMatch =
  | ({ status: "match" } & TmdbResult)
  | { status: "none" } // searched; nothing verifies → prefer blank over wrong
  | { status: "error" }; // network/API failure → keep whatever we had

interface TmdbSearchResult {
  id?: number;
  title?: string;
  poster_path?: string | null;
  release_date?: string;
}

// /movie/{id} with append_to_response=release_dates,credits.
export interface TmdbDetail extends TmdbSearchResult {
  runtime?: number;
  release_dates?: {
    results?: Array<{ iso_3166_1?: string; release_dates?: Array<{ certification?: string }> }>;
  };
  credits?: { crew?: Array<{ job?: string; name?: string }> };
}

// Pull the US MPAA certification (e.g. "PG-13") out of the release_dates payload.
function usCert(d: TmdbDetail | undefined): string | null {
  const us = d?.release_dates?.results?.find((r) => r.iso_3166_1 === "US");
  const cert = us?.release_dates?.map((x) => x.certification).find((c) => !!c && c.trim() !== "");
  return cert ? cert.trim() : null;
}

const compact = (s: string) => s.toLowerCase().replace(/[^a-z0-9]/g, "");

function titleScore(title: string | undefined, norm: NormalizedTitle): number {
  const t = (title ?? "").toLowerCase();
  const q = norm.query.toLowerCase();
  if (t === q) return 8;
  if (compact(t) === compact(norm.query)) return 7;
  if (t && (t.startsWith(q) || q.startsWith(t))) return 3;
  return 0;
}

// Surnames, accent-stripped: AMC's "YOSIAKI KAWAJIRI" still matches TMDB's
// "Yoshiaki Kawajiri", and "Joe Russo, Anthony Russo" matches either brother.
function surnames(names: string[]): Set<string> {
  return new Set(
    names
      .map((n) => n.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim().split(/\s+/).pop() ?? "")
      .filter((n) => n.length > 1),
  );
}

const tmdbYear = (d: TmdbSearchResult) => {
  const y = parseInt((d.release_date ?? "").slice(0, 4), 10);
  return Number.isNaN(y) ? null : y;
};

/**
 * Score a TMDB candidate against AMC's facts. `reject` means it's provably a
 * different film (AMC's director isn't among TMDB's directors). Exported for tests.
 */
export function scoreTmdbCandidate(
  d: TmdbDetail,
  norm: NormalizedTitle,
  ctx: MatchContext,
): { score: number; reject: boolean } {
  const ts = titleScore(d.title, norm);
  if (ts === 0) return { score: 0, reject: true };
  let score = ts;
  const year = tmdbYear(d);

  const amcDirs = surnames(ctx.directors ?? []);
  const tmdbDirs = surnames((d.credits?.crew ?? []).filter((c) => c.job === "Director").map((c) => c.name ?? ""));
  if (amcDirs.size && tmdbDirs.size) {
    if ([...amcDirs].some((n) => tmdbDirs.has(n))) score += 12;
    else return { score, reject: true };
  }

  if (ctx.runtime && d.runtime) {
    const diff = Math.abs(ctx.runtime - d.runtime);
    if (diff <= 10) score += 3;
    else if (diff > 25) score -= 4;
  }

  if (norm.year && year === norm.year) score += 4; // "(1993)" in AMC's title
  if (ctx.amcYear && year) {
    if (ctx.reRelease) {
      score += year <= ctx.amcYear - 2 ? 3 : -2; // a re-release is an older film
    } else {
      // A current release: TMDB's date can be a festival premiere a year or two early.
      const gap = ctx.amcYear - year;
      score += gap >= -1 && gap <= 2 ? 5 : -10;
    }
  }

  if (d.poster_path) score += 1;
  return { score, reject: false };
}

const MATCH_THRESHOLD = 8; // an exact title with no contradicting facts
const MAX_CANDIDATES = 5;

async function tmdbFetch(url: string, signal: AbortSignal, retried = false): Promise<Response> {
  const res = await fetch(url, { signal });
  if (res.status === 429 && !retried) {
    const ra = Number(res.headers.get("retry-after")) || 1;
    await sleep(Math.min(ra, 10) * 1000);
    return tmdbFetch(url, signal, true);
  }
  return res;
}

async function tmdbSearch(query: string, apiKey: string, signal: AbortSignal, year?: number): Promise<TmdbSearchResult[]> {
  const res = await tmdbFetch(
    `${TMDB_BASE}/search/movie?api_key=${apiKey}&include_adult=false&query=${encodeURIComponent(query)}` +
      (year ? `&primary_release_year=${year}` : ""),
    signal,
  );
  if (!res.ok) throw new Error(`TMDB search ${res.status}`);
  const data = (await res.json()) as { results?: TmdbSearchResult[] };
  return Array.isArray(data.results) ? data.results : [];
}

async function tmdbGetById(id: number, apiKey: string, signal: AbortSignal): Promise<TmdbDetail | undefined> {
  const res = await tmdbFetch(
    `${TMDB_BASE}/movie/${id}?api_key=${apiKey}&append_to_response=release_dates,credits`,
    signal,
  );
  if (res.status === 404) return undefined; // id no longer exists
  if (!res.ok) throw new Error(`TMDB movie ${res.status}`);
  const m = (await res.json()) as TmdbDetail;
  return typeof m.id === "number" ? m : undefined;
}

function toResult(d: TmdbDetail): TmdbResult {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(d.release_date ?? "") ? d.release_date! : null;
  return {
    posterUrl: d.poster_path ? `${TMDB_IMG}${d.poster_path}` : null,
    tmdbId: typeof d.id === "number" ? d.id : null,
    year: tmdbYear(d),
    title: d.title ?? null,
    date,
    runtime: typeof d.runtime === "number" && d.runtime > 0 ? d.runtime : null,
    cert: usCert(d),
  };
}

/**
 * Find the TMDB film AMC is actually showing. A previously saved id is re-checked
 * against AMC's facts (so old mistakes self-correct); otherwise search — also by
 * AMC's release year for current films, so a little-known 2026 remake isn't buried
 * under the famous original — and keep the best candidate that verifies.
 */
export async function matchTmdb(
  norm: NormalizedTitle,
  ctx: MatchContext,
  opts: { apiKey?: string; signal?: AbortSignal; tmdbId?: number | null } = {},
): Promise<TmdbMatch> {
  const apiKey = opts.apiKey ?? process.env.TMDB_API_KEY;
  if (!apiKey) return { status: "error" };
  try {
    const signal = opts.signal ?? AbortSignal.timeout(15000);
    if (opts.tmdbId) {
      const cached = await tmdbGetById(opts.tmdbId, apiKey, signal);
      if (cached) {
        const v = scoreTmdbCandidate(cached, norm, ctx);
        if (!v.reject && v.score >= MATCH_THRESHOLD) return { status: "match", ...toResult(cached) };
      }
    }

    const byYear =
      ctx.amcYear && !ctx.reRelease ? await tmdbSearch(norm.query, apiKey, signal, ctx.amcYear) : [];
    const plain = await tmdbSearch(norm.query, apiKey, signal);
    const seen = new Set<number>();
    const candidates = [...byYear, ...plain]
      .filter((r) => typeof r.id === "number" && !seen.has(r.id) && seen.add(r.id) && titleScore(r.title, norm) > 0)
      .slice(0, MAX_CANDIDATES);

    let best: { d: TmdbDetail; score: number } | null = null;
    for (const c of candidates) {
      const d = await tmdbGetById(c.id!, apiKey, signal);
      if (!d) continue;
      const v = scoreTmdbCandidate(d, norm, ctx);
      if (!v.reject && v.score >= MATCH_THRESHOLD && (!best || v.score > best.score)) best = { d, score: v.score };
    }
    return best ? { status: "match", ...toResult(best.d) } : { status: "none" };
  } catch {
    return { status: "error" };
  }
}

export interface LetterboxdResult {
  rating: number | null; // 0–5
  url: string | null;
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

/**
 * Letterboxd's page for an exact TMDB id: letterboxd.com/tmdb/<id>/ redirects to
 * the film itself, so the link is right whenever the TMDB match is — no guessing
 * from titles. Returns nulls if Letterboxd doesn't have the film; throws on
 * network trouble (the caller keeps what it had).
 */
export async function fetchLetterboxdForTmdb(tmdbId: number, signal?: AbortSignal): Promise<LetterboxdResult> {
  const res = await fetch(`${LB_BASE}/tmdb/${tmdbId}/`, {
    headers: { "User-Agent": UA, Accept: "text/html" },
    signal: signal ?? AbortSignal.timeout(10000),
  });
  if (res.status === 404) return { rating: null, url: null };
  if (!res.ok) throw new Error(`Letterboxd ${res.status}`);
  const html = await res.text();
  // A real Cloudflare interstitial has this title (the normal page merely references
  // /cdn-cgi/challenge-platform/, so don't match on that).
  if (/<title>\s*just a moment/i.test(html)) throw new Error("Letterboxd challenge");
  const url = res.url.split("?")[0];
  if (!/^https:\/\/letterboxd\.com\/film\/[^/]+\/$/.test(url)) return { rating: null, url: null };
  return { rating: parseFilmLd(html).rating, url };
}

// AMC's own re-release signals: anniversary/remaster/encore wording, "(re)"/"(RE26)"
// codes, an explicit "(1993)" year, or the Fan Faves / AMC Classics programs.
const RE_RELEASE_TITLE = /anniversar|remaster|restor|re-?release|\bencore\b|\(re\)|\((?:re|[a-z]{1,4})\d{2}\)|\(\d{4}\)/i;
const RE_RELEASE_ATTR = /fan fave|amc classics|flashback|throwback/i;
export function looksReRelease(title: string, attributes: string[]): boolean {
  return RE_RELEASE_TITLE.test(title) || attributes.some((a) => RE_RELEASE_ATTR.test(a));
}

export interface EnrichStats {
  considered: number;
  tmdbHits: number;
  lbHits: number;
  misses: number;
  errors: number;
  corrected: number; // saved TMDB match replaced by a verified one
  cleared: number; // saved match removed because nothing verifies
}

const DAY_MS = 86_400_000;

export async function enrichMovies(
  opts: {
    staleAfterDays?: number;
    missRetryDays?: number;
    maxMovies?: number;
    tmdbApiKey?: string;
    force?: boolean; // re-check every movie, ignoring the staleness gate
    dryRun?: boolean; // compute and log changes, but write nothing
  } = {},
): Promise<EnrichStats> {
  const staleAfterDays = opts.staleAfterDays ?? 7;
  const missRetryDays = opts.missRetryDays ?? 30;
  const force = opts.force ?? false;
  const dryRun = opts.dryRun ?? false;
  // Every write goes through here so a dry run can preview without saving.
  const save = (id: string, data: Parameters<typeof prisma.movie.update>[0]["data"]) =>
    dryRun ? Promise.resolve() : prisma.movie.update({ where: { id }, data }).then(() => undefined);
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

  const stats: EnrichStats = {
    considered: movies.length,
    tmdbHits: 0,
    lbHits: 0,
    misses: 0,
    errors: 0,
    corrected: 0,
    cleared: 0,
  };

  for (const m of movies) {
    const norm = normalizeTitle(m.title);
    // Skip structural events (opera/sports/concert) so we never mis-match them.
    if ((m.isSpecialEvent && norm.eventLike) || !norm.query) {
      await save(m.id, { metadataCheckedAt: new Date() }).catch(() => {});
      stats.misses++;
      continue;
    }

    try {
      // Verify against what AMC says is screening (director, runtime, release year)
      // rather than trusting the title — and re-check any saved match the same way.
      const attrs = parseAttrs(m.attributes);
      const ctx: MatchContext = {
        directors: m.directors?.split(",").map((d) => d.trim()).filter(Boolean),
        runtime: m.runtimeMinutes,
        amcYear: m.amcReleaseDate ? m.amcReleaseDate.getUTCFullYear() : null,
        reRelease: looksReRelease(m.title, attrs),
      };
      const tmdb = await matchTmdb(norm, ctx, { apiKey, tmdbId: m.tmdbId });
      if (tmdb.status === "error") {
        stats.errors++; // transient — keep existing data, retry next run
        continue;
      }

      if (tmdb.status === "none") {
        // Nothing verifies: clear any earlier (possibly wrong) match. AMC's own poster
        // still shows; blank beats a wrong film's rating and year.
        const cls = classify({ title: m.title, attributes: attrs, releaseYear: null });
        if (m.tmdbId || m.letterboxdUrl) console.log(`    ✗ cleared  ${m.title}  (was ${m.letterboxdUrl ?? `tmdb ${m.tmdbId}`})`);
        await save(m.id, {
          tmdbId: null,
          posterUrl: null,
          letterboxdRating: null,
          letterboxdUrl: null,
          releaseYear: null,
          releaseDate: null,
          isClassic: cls.isClassic,
          isSpecialEvent: cls.isSpecialEvent,
          isIndie: cls.isIndie,
          isForeign: cls.isForeign,
          metadataCheckedAt: new Date(),
        });
        if (m.tmdbId || m.letterboxdUrl) stats.cleared++;
        stats.misses++;
        continue;
      }

      // Letterboxd straight from the TMDB id — exact, no title guessing.
      let lb: LetterboxdResult | null = null;
      try {
        lb = tmdb.tmdbId ? await fetchLetterboxdForTmdb(tmdb.tmdbId) : { rating: null, url: null };
      } catch {
        lb = null; // network trouble — keep the existing rating/link
      }

      if (tmdb.posterUrl) stats.tmdbHits++;
      if (lb?.rating != null) stats.lbHits++;
      if (m.tmdbId && tmdb.tmdbId !== m.tmdbId) stats.corrected++;
      const newUrl = lb ? lb.url : m.letterboxdUrl;
      if (newUrl !== m.letterboxdUrl || (m.tmdbId && tmdb.tmdbId !== m.tmdbId)) {
        console.log(`    ↻ ${m.title}  ${m.letterboxdUrl ?? "(none)"} → ${newUrl ?? "(none)"}  [${tmdb.year ?? "?"}]`);
      }

      // Re-run classification with the verified release year, so the
      // old-film => Throwback heuristic is right.
      const year = tmdb.year;
      const cls = classify({ title: m.title, attributes: attrs, releaseYear: year });

      await save(m.id, {
        tmdbId: tmdb.tmdbId,
        posterUrl: tmdb.posterUrl,
        letterboxdRating: lb ? lb.rating : m.letterboxdRating,
        letterboxdUrl: lb ? lb.url : m.letterboxdUrl,
        releaseYear: year,
        releaseDate: tmdb.date ? new Date(tmdb.date) : null,
        // AMC's own rating/runtime (set at ingest) win; TMDB only fills gaps.
        runtimeMinutes: m.runtimeMinutes ?? tmdb.runtime,
        rating: m.rating ?? tmdb.cert,
        isClassic: cls.isClassic,
        isSpecialEvent: cls.isSpecialEvent,
        isIndie: cls.isIndie,
        isForeign: cls.isForeign,
        metadataCheckedAt: new Date(),
      });
    } catch {
      stats.errors++;
    }

    await sleep(400); // be gentle on Letterboxd
  }

  return stats;
}
