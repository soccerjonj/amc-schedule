import { DateTime } from "luxon";
import { THEATRE_TIMEZONE } from "../theatres";
import type { RawShowtime, ShowtimeProvider, TheatreRef } from "./types";

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
  const suffix = movieSlug.match(/-(\d+)$/);
  const attrs = (s.attributes ?? []).map((a) => (a.name ?? a.code ?? "").trim()).filter(Boolean);
  const format = deriveFormat(s.premiumFormat, attrs);
  return {
    showtimeId: String(s.id),
    movieId: suffix ? suffix[1] : String(s.movieId),
    movieSlug,
    movieTitle: s.movieName.trim(),
    startsAt: new Date(s.showDateTimeUtc),
    format,
    // Same direct ticket link the scraper produced (and existing rows use).
    ticketUrl: `${WEB}/showtimes/${s.id}`,
    attributes: attrs,
    mpaaRating: normalizeMpaa(s.mpaaRating),
    runtimeMinutes: s.runTime && s.runTime > 0 ? s.runTime : undefined,
  };
}

export class AmcApiProvider implements ShowtimeProvider {
  name = "amc-api";
  private key = "";
  private lastCall = 0;
  private theatreIds = new Map<string, number>();
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
}
