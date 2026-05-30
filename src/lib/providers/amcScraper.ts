import { chromium, type Browser, type BrowserContext } from "playwright";
import { DateTime } from "luxon";
import { THEATRE_TIMEZONE } from "../theatres";
import type { RawShowtime, ShowtimeProvider, TheatreRef } from "./types";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36";
const BASE = "https://www.amctheatres.com";

// Raw record shape returned from the page DOM (before timezone math).
interface DomShowtime {
  showtimeId: string;
  timeRaw: string;
  movieSlug: string;
  title: string | null;
  formatRaw: string | null;
  attributes: string[];
}

/**
 * Scrapes AMC's public showtimes pages with a real headless browser. The site
 * sits behind Cloudflare + a waiting room, which a genuine browser clears; the
 * showtimes are server-rendered into the DOM (no JSON API), so we parse them.
 * Each showtime anchor's `aria-describedby` encodes the movie slug and points
 * to that screening's attributes list; a page <select> maps slug -> title.
 */
export class AmcScraperProvider implements ShowtimeProvider {
  name = "amc-website-scraper";
  private browser: Browser | null = null;
  private ctx: BrowserContext | null = null;

  async open() {
    this.browser = await chromium.launch({
      headless: true,
      args: ["--disable-blink-features=AutomationControlled", "--no-sandbox"],
    });
    this.ctx = await this.browser.newContext({
      userAgent: UA,
      viewport: { width: 1280, height: 900 },
      locale: "en-US",
      timezoneId: THEATRE_TIMEZONE,
    });
    await this.ctx.addInitScript(() => {
      Object.defineProperty(navigator, "webdriver", { get: () => undefined });
      Object.defineProperty(navigator, "languages", { get: () => ["en-US", "en"] });
      Object.defineProperty(navigator, "plugins", { get: () => [1, 2, 3] });
    });
  }

  async close() {
    await this.ctx?.close();
    await this.browser?.close();
    this.ctx = null;
    this.browser = null;
  }

  async getShowtimes(theatre: TheatreRef, date: string): Promise<RawShowtime[]> {
    if (!this.ctx) throw new Error("provider not opened");
    const url = `${BASE}/movie-theatres/${theatre.urlPath}/showtimes?date=${date}`;
    const page = await this.ctx.newPage();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 60000 });
      // allow Cloudflare / waiting room to clear and SSR content to settle
      await page.waitForSelector('a[href^="/showtimes/"]', { timeout: 25000 }).catch(() => {});
      await page.waitForTimeout(1500);

      const dom: DomShowtime[] = await page.evaluate(() => {
        const movieMap: Record<string, string> = {};
        document.querySelectorAll("select option[value]").forEach((o) => {
          const v = o.getAttribute("value");
          if (v && /-\d+$/.test(v)) movieMap[v] = (o.textContent || "").trim();
        });

        const out: DomShowtime[] = [];
        document.querySelectorAll('a[href^="/showtimes/"][id]').forEach((a) => {
          const showtimeId = (a as HTMLElement).id;
          if (!/^\d+$/.test(showtimeId)) return;
          const timeRaw = (a.textContent || "").trim();
          const desc = (a.getAttribute("aria-describedby") || "").split(/\s+/).filter(Boolean);
          const movieSlug = desc[0] || "";
          if (!movieSlug) return;
          const attrId = desc.find((d) => d.endsWith("-attributes"));
          let attributes: string[] = [];
          let formatRaw: string | null = null;
          if (attrId) {
            const ul = document.getElementById(attrId);
            if (ul) {
              attributes = Array.from(ul.querySelectorAll("li")).map((li) =>
                (li.textContent || "").trim(),
              );
              let el: Element | null = ul;
              for (let i = 0; i < 6 && el; i++) {
                el = el.previousElementSibling || el.parentElement;
                if (!el) break;
                const h = el.matches?.("h1,h2,h3,h4")
                  ? el
                  : el.querySelector?.("h1,h2,h3,h4");
                if (h && h.textContent?.trim()) {
                  formatRaw = h.textContent.replace(/\s+/g, " ").trim();
                  break;
                }
              }
            }
          }
          out.push({ showtimeId, timeRaw, movieSlug, title: movieMap[movieSlug] || null, formatRaw, attributes });
        });
        return out;
      });

      const results: RawShowtime[] = [];
      for (const d of dom) {
        const startsAt = parseStartsAt(date, d.timeRaw);
        if (!startsAt) continue;
        const title = d.title ?? slugToTitle(d.movieSlug);
        results.push({
          showtimeId: d.showtimeId,
          movieId: movieIdFromSlug(d.movieSlug),
          movieSlug: d.movieSlug,
          movieTitle: title,
          startsAt,
          format: normalizeFormat(d.formatRaw, title),
          ticketUrl: `${BASE}/showtimes/${d.showtimeId}`,
          attributes: d.attributes,
        });
      }
      return results;
    } finally {
      await page.close();
    }
  }
}

function parseStartsAt(date: string, timeRaw: string): Date | null {
  const m = timeRaw.match(/(\d{1,2}):(\d{2})\s*([ap])m/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const minute = parseInt(m[2], 10);
  const pm = m[3].toLowerCase() === "p";
  if (pm && hour !== 12) hour += 12;
  if (!pm && hour === 12) hour = 0;
  const dt = DateTime.fromISO(`${date}T00:00`, { zone: THEATRE_TIMEZONE }).set({
    hour,
    minute,
  });
  return dt.isValid ? dt.toJSDate() : null;
}

function movieIdFromSlug(slug: string): string {
  const m = slug.match(/-(\d+)$/);
  return m ? m[1] : slug;
}

function slugToTitle(slug: string): string {
  return slug
    .replace(/-\d+$/, "")
    .split("-")
    .map((w) => (w ? w[0].toUpperCase() + w.slice(1) : w))
    .join(" ");
}

function normalizeFormat(formatRaw: string | null, title: string): string {
  if (!formatRaw) return "Standard";
  // headings look like "Laser at AMC: PICTURE A BETTER WORLD" -> keep "Laser at AMC"
  const head = formatRaw.split(":")[0].trim();
  if (!head || head.toLowerCase() === title.toLowerCase()) return "Standard";
  return head;
}
