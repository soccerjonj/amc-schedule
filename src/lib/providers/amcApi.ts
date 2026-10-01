import { DateTime } from "luxon";
import { THEATRE_TIMEZONE } from "../theatres";
import type { AnnouncedMovie, MovieDetails, RawShowtime, ShowtimeProvider, TheatreRef } from "./types";

// AMC's official catalog API (https://developers.amctheatres.com). Replaces the
// Playwright scraper now that amctheatres.com sits behind a Cloudflare bot check.
// Auth is a vendor key sent on every request; responses are HAL JSON.
const API = "https://api.amctheatres.com";
const WEB = "https://www.amctheatres.com";
const PAGE_SIZE = 100; // documented maximum
const MAX_PAGES = 60; // safety cap per theatre (~6,000 showtimes)
const REQUEST_GAP_MS = 150; // be polite between calls
const MAX_RETRIES = 3;

// Our theatre ids are website slugs. A few have had different slugs on AMC's side
// over time; try these alternatives in order if the first lookup 404s.
const SLUG_ALTERNATES: Record<string, string[]> = {
  "amc-600-north-michigan-9": ["amc-dine-in-600-north-michigan-9"],
};

/** The subset of AMC's v2 showtime resource we use. */
export interface ApiShowtime {
  id: number;
  movieId: number;
  movieName: string;
  movieUrl?: string;
  showDateTimeUtc: string;
  showDateTimeLocal?: string;
  premiumFormat?: string | null;
  attributes?: { code?: string; name?: string; description?: string }[];
  purchaseUrl?: string | null;
  runTime?: number | null;
  mpaaRating?: string | null;
  isCanceled?: boolean;
  isSoldOut?: boolean;
  isAlmostSoldOut?: boolean;
  isDiscountMatineePriced?: boolean;
  discountMatineeMessage?: string | null;
  ticketPrices?: { price?: number; type?: string }[];
}

/** The subset of AMC's v2 movie resource we use. */
export interface ApiMovie {
  id: number;
  name: string;
  slug?: string;
  synopsis?: string | null;
  starringActors?: string | null;
  directors?: string | null;
  genre?: string | null;
  mpaaRating?: string | null;
  runTime?: number | null;
  releaseDateUtc?: string | null;
  hasScheduledShowtimes?: boolean;
  media?: {
    posterDynamic?: string | null;
    primaryTrailerExternalVideoId?: string | null;
    trailerMp4?: string | null;
    trailerHd?: string | null;
  };
}

interface ApiPage {
  count?: number;
  pageNumber?: number;
  pageSize?: number;
  _embedded?: { showtimes?: ApiShowtime[] };
  _links?: { next?: { href?: string } };
}

export class AmcApiError extends Error {
  constructor(
    message: string,
    public status: number,
    public code?: number,
  ) {
    super(message);
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// A showing carries several attributes at once (e.g. Laser + Closed Caption +
// recliners), but we store one presentation "format" — like the sections on AMC's
// website. Pick by priority: caption/language versions first (kept grouped apart
// and muted in the UI), then premium formats, then plain laser projection.
// "Closed Caption" (caption devices, on nearly every show) is not a format.
const FORMAT_PRIORITY: RegExp[] = [
  /open caption/i,
  /spoken with|dubbed/i,
  /imax/i,
  /70mm/i,
  /dolby/i,
  /infinity vision/i,
  /prime/i,
  /\bxl\b/i,
  /3d/i,
  /laser/i,
];

/** Single display format for a showing from premiumFormat + attribute names. */
export function deriveFormat(premiumFormat: string | null | undefined, attrs: string[]): string {
  const candidates = [premiumFormat?.trim() ?? "", ...attrs].filter(Boolean);
  for (const re of FORMAT_PRIORITY) {
    const hit = candidates.find((c) => re.test(c));
    if (hit) return hit;
  }
  return "Standard";
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

// AMC sends "PG13", "NC17", "R", "NR"… — normalise to the familiar display form.
export function normalizeMpaa(r: string | null | undefined): string | undefined {
  if (!r) return undefined;
  const v = r.trim().toUpperCase().replace(/\s+/g, "");
  if (!v) return undefined;
  if (v === "PG13") return "PG-13";
  if (v === "NC17") return "NC-17";
  if (v === "UNRATED" || v === "NOTRATED") return "NR";
  return v;
}

// Our movie id is the numeric suffix of AMC's website slug ("dune-part-three-80123"
// → "80123"), matching what the scraper stored, so ids stay stable across sources.
function movieIdFromSlug(slug: string | undefined, fallback: number): string {
  const m = slug?.match(/-(\d+)$/);
  return m ? m[1] : String(fallback);
}

// AMC prepends viewer advisories to some synopses ("AMC has been advised that this
// film contains sequences with flashing lights…"). Peel them off into their own
// field so the synopsis reads as a synopsis.
const ADVISORY_LEAD = /^\s*((?:AMC has been advised|Please note|Viewer (?:advisory|discretion))[^.!?]*[.!?])\s*/i;
export function splitAdvisory(text: string | null | undefined): { synopsis?: string; advisory?: string } {
  let rest = (text ?? "").trim();
  const advisories: string[] = [];
  for (let m = rest.match(ADVISORY_LEAD); m; m = rest.match(ADVISORY_LEAD)) {
    advisories.push(m[1].trim());
    rest = rest.slice(m[0].length).trim();
  }
  return { synopsis: rest || undefined, advisory: advisories.join(" ") || undefined };
}

// AMC mixes "JOHN CENA, LANA CONDOR, Will Forte". Title-case the shouty names,
// keeping initials/stage names with periods ("H.E.R.") as given.
function titleCaseWord(w: string): string {
  if (w.includes(".") || !/[A-Z]/.test(w) || w !== w.toUpperCase()) return w;
  const lower = w.toLowerCase();
  return lower
    .replace(/(^|[-'’])([a-z])/g, (_m, p: string, c: string) => p + c.toUpperCase())
    .replace(/^Mc([a-z])/, (_m, c: string) => "Mc" + c.toUpperCase());
}
export function tidyNames(list: string | null | undefined): string | undefined {
  const names = (list ?? "")
    .split(",")
    .map((n) => n.trim().split(/\s+/).map(titleCaseWord).join(" "))
    .filter(Boolean);
  return names.length ? names.join(", ") : undefined;
}
export function tidyGenre(g: string | null | undefined): string | undefined {
  const v = (g ?? "").trim();
  return v ? v.charAt(0).toUpperCase() + v.slice(1).toLowerCase() : undefined;
}

// Announced-list filters: placeholder listings ("Untitled A24 (11/6/2026)",
// "UFC 335: TBD vs. TBD", "Secret Variance Event") and imminent unscheduled titles.
const PLACEHOLDER_TITLE = /^untitled\b|\btbd\b|\bsecret\b.*\bevent\b|private\s+theat(re|er)\s+rental/i;
const ANNOUNCED_MIN_LEAD_DAYS = 7;

// AMC trailers play through its Brightcove player (the raw .mp4 links 403).
const BRIGHTCOVE_ACCOUNT = "1655482053001";
function trailerEmbedUrl(media: ApiMovie["media"]): string | undefined {
  const id = media?.primaryTrailerExternalVideoId?.trim();
  if (!id || !/^\d+$/.test(id)) return undefined;
  const acct = (media?.trailerMp4 ?? media?.trailerHd ?? "").match(/\/(\d{10,})\/\d+\.mp4/)?.[1] ?? BRIGHTCOVE_ACCOUNT;
  return `https://players.brightcove.net/${acct}/default_default/index.html?videoId=${id}`;
}

/** Map an AMC movie resource to our MovieDetails. */
export function mapApiMovieDetails(m: ApiMovie): MovieDetails {
  return {
    ...splitAdvisory(m.synopsis),
    cast: tidyNames(m.starringActors),
    directors: tidyNames(m.directors),
    genre: tidyGenre(m.genre),
    trailerUrl: trailerEmbedUrl(m.media),
    posterUrl: m.media?.posterDynamic?.trim() || undefined,
    releaseDate: m.releaseDateUtc && !m.releaseDateUtc.startsWith("1900") ? new Date(m.releaseDateUtc) : undefined,
  };
}

/** Theatre-local calendar date (YYYY-MM-DD) a showtime belongs to. */
export function localDateOf(s: ApiShowtime): string {
  if (s.showDateTimeLocal && /^\d{4}-\d{2}-\d{2}/.test(s.showDateTimeLocal)) {
    return s.showDateTimeLocal.slice(0, 10);
  }
  return DateTime.fromISO(s.showDateTimeUtc, { zone: "utc" }).setZone(THEATRE_TIMEZONE).toISODate()!;
}

/**
 * Map one API showtime to our provider-neutral shape. Returns null for rows we
 * don't store (cancelled). Movie identity mirrors the scraper — the numeric
 * suffix of the website slug — so existing Movie rows and /movie/[id] URLs keep
 * working across the switch.
 */
export function mapApiShowtime(s: ApiShowtime): RawShowtime | null {
  if (s.isCanceled) return null;
  const urlSlug = s.movieUrl?.split("?")[0].replace(/\/+$/, "").split("/").pop();
  const movieSlug = urlSlug || `${slugify(s.movieName)}-${s.movieId}`;

  const attrs = (s.attributes ?? []).map((a) => (a.name ?? a.code ?? "").trim()).filter(Boolean);
  const format = deriveFormat(s.premiumFormat, attrs);
  return {
    showtimeId: String(s.id),
    movieId: movieIdFromSlug(movieSlug, s.movieId),
    movieSlug,
    movieTitle: s.movieName.trim(),
    startsAt: new Date(s.showDateTimeUtc),
    format,
    // Same direct ticket link the scraper produced (and existing rows use).
    ticketUrl: `${WEB}/showtimes/${s.id}`,
    attributes: attrs,
    mpaaRating: normalizeMpaa(s.mpaaRating),
    runtimeMinutes: s.runTime && s.runTime > 0 ? s.runTime : undefined,
    soldOut: !!s.isSoldOut,
    almostSoldOut: !s.isSoldOut && !!s.isAlmostSoldOut,
    price: (s.ticketPrices?.find((t) => t.type === "ADULT") ?? s.ticketPrices?.[0])?.price ?? undefined,
    discount: (s.isDiscountMatineePriced && s.discountMatineeMessage?.trim()) || undefined,
  };
}

export class AmcApiProvider implements ShowtimeProvider {
  name = "amc-api";
  private key = "";
  private lastCall = 0;
  private theatreIds = new Map<string, number>();
  // Our movie id → AMC's numeric movie id, recorded as showtimes are mapped.
  private apiMovieIds = new Map<string, number>();
  // Per-theatre showtimes grouped by local date, fetched once per run.
  private byTheatre = new Map<string, Promise<Map<string, RawShowtime[]>>>();

  async open() {
    this.key = process.env.AMC_VENDOR_KEY ?? "";
    if (!this.key) throw new Error("AMC_VENDOR_KEY is not set");
    // Probe auth up front so a bad/inactive key fails the run before any DB write.
    await this.resolveTheatreId({ slug: "amc-river-east-21" } as TheatreRef);
  }

  async close() {
    this.byTheatre.clear();
  }

  /** Low-level GET with the vendor key, pacing, and retries on 429/5xx. */
  async get<T>(pathOrUrl: string): Promise<T> {
    const url = pathOrUrl.startsWith("http") ? pathOrUrl : `${API}${pathOrUrl}`;
    for (let attempt = 0; ; attempt++) {
      const wait = this.lastCall + REQUEST_GAP_MS - Date.now();
      if (wait > 0) await sleep(wait);
      this.lastCall = Date.now();
      const res = await fetch(url, {
        headers: { "X-AMC-Vendor-Key": this.key, Accept: "application/json" },
        signal: AbortSignal.timeout(20_000),
      });
      if (res.ok) return (await res.json()) as T;

      const body = (await res.json().catch(() => null)) as
        | { errors?: { code?: number; message?: string; exceptionMessage?: string }[] }
        | null;
      const err = body?.errors?.[0];
      const detail = err?.exceptionMessage || err?.message || res.statusText;
      if ((res.status === 429 || res.status >= 500) && attempt < MAX_RETRIES) {
        const ra = Number(res.headers.get("retry-after"));
        await sleep(Number.isFinite(ra) && ra > 0 ? Math.min(ra, 30) * 1000 : 1000 * 2 ** attempt);
        continue;
      }
      if (res.status === 401 || res.status === 403) {
        throw new AmcApiError(`AMC API key not authorized (not activated yet?): ${detail}`, res.status, err?.code);
      }
      throw new AmcApiError(`AMC API ${res.status} for ${url.replace(API, "")}: ${detail}`, res.status, err?.code);
    }
  }

  /** Numeric AMC theatre id for one of our (slug-keyed) theatres. */
  async resolveTheatreId(theatre: Pick<TheatreRef, "slug">): Promise<number> {
    const cached = this.theatreIds.get(theatre.slug);
    if (cached) return cached;
    const candidates = [theatre.slug, ...(SLUG_ALTERNATES[theatre.slug] ?? [])];
    for (const slug of candidates) {
      try {
        const t = await this.get<{ id: number }>(`/v2/theatres/${slug}`);
        this.theatreIds.set(theatre.slug, t.id);
        return t.id;
      } catch (e) {
        if (e instanceof AmcApiError && e.status === 404) continue; // try the next slug
        throw e;
      }
    }
    throw new Error(`AMC API: no theatre found for ${candidates.join(" / ")}`);
  }

  /** All future showtimes for a theatre, mapped and grouped by local date. */
  async fetchTheatre(theatre: TheatreRef): Promise<{ byDate: Map<string, RawShowtime[]>; pages: number; raw: ApiShowtime[] }> {
    const id = await this.resolveTheatreId(theatre);
    const raw: ApiShowtime[] = [];
    let pages = 0;
    for (let page = 1; page <= MAX_PAGES; page++) {
      const data = await this.get<ApiPage>(`/v2/theatres/${id}/showtimes?page-size=${PAGE_SIZE}&page-number=${page}`);
      pages++;
      const rows = data._embedded?.showtimes ?? [];
      raw.push(...rows);
      const total = data.count ?? 0;
      if (rows.length === 0 || !data._links?.next || (total > 0 && raw.length >= total)) break;
    }
    const byDate = new Map<string, RawShowtime[]>();
    for (const s of raw) {
      const mapped = mapApiShowtime(s);
      if (!mapped) continue;
      this.apiMovieIds.set(mapped.movieId, s.movieId);
      const day = localDateOf(s);
      (byDate.get(day) ?? byDate.set(day, []).get(day)!).push(mapped);
    }
    return { byDate, pages, raw };
  }

  async getShowtimes(theatre: TheatreRef, date: string): Promise<RawShowtime[]> {
    let p = this.byTheatre.get(theatre.slug);
    if (!p) {
      p = this.fetchTheatre(theatre).then((r) => r.byDate);
      // Don't cache a failure — a later date can retry the theatre fetch.
      p.catch(() => this.byTheatre.delete(theatre.slug));
      this.byTheatre.set(theatre.slug, p);
    }
    const byDate = await p; // throws on fetch failure → ingest skips the day (no wipe)
    return byDate.get(date) ?? [];
  }

  /** Synopsis, cast, trailer, poster… for movies seen this run (batched). */
  async getMovieDetails(movieIds: string[]): Promise<Map<string, MovieDetails>> {
    const apiIds = [...new Set(movieIds.map((id) => this.apiMovieIds.get(id)).filter((n): n is number => !!n))];
    const out = new Map<string, MovieDetails>();
    for (let i = 0; i < apiIds.length; i += 50) {
      const batch = apiIds.slice(i, i + 50);
      const data = await this.get<{ _embedded?: { movies?: ApiMovie[] } }>(
        `/v2/movies?ids=${batch.join(",")}&page-size=100`,
      );
      for (const m of data._embedded?.movies ?? []) out.set(movieIdFromSlug(m.slug, m.id), mapApiMovieDetails(m));
    }
    return out;
  }

  /** AMC "coming soon" films with no showtimes posted anywhere yet. */
  async getAnnounced(days: number): Promise<AnnouncedMovie[]> {
    const today = DateTime.now().setZone(THEATRE_TIMEZONE).startOf("day");
    // A film due within the week that still has no showtimes anywhere almost never
    // gets them (limited/regional releases), so only look further out.
    const from = today.plus({ days: ANNOUNCED_MIN_LEAD_DAYS });
    const until = today.plus({ days });
    const out: AnnouncedMovie[] = [];
    for (let page = 1; page <= 20; page++) {
      const data = await this.get<{ count?: number; _embedded?: { movies?: ApiMovie[] }; _links?: { next?: unknown } }>(
        `/v2/movies/views/coming-soon?page-size=100&page-number=${page}`,
      );
      for (const m of data._embedded?.movies ?? []) {
        if (m.hasScheduledShowtimes || !m.releaseDateUtc || PLACEHOLDER_TITLE.test(m.name)) continue;
        const rel = DateTime.fromISO(m.releaseDateUtc, { zone: "utc" }).setZone(THEATRE_TIMEZONE);
        if (!rel.isValid || rel < from || rel >= until) continue;
        out.push({
          id: movieIdFromSlug(m.slug, m.id),
          slug: m.slug || `${slugify(m.name)}-${m.id}`,
          title: m.name.trim(),
          releaseDate: rel.toJSDate(),
          mpaaRating: normalizeMpaa(m.mpaaRating),
          runtimeMinutes: m.runTime && m.runTime > 0 ? m.runTime : undefined,
          ...mapApiMovieDetails(m),
        });
      }
      // Movie views don't always send _links.next — page by the total count.
      const got = (data._embedded?.movies ?? []).length;
      if (got === 0 || page * 100 >= (data.count ?? 0)) break;
    }
    return out;
  }
}
