import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { isHiddenTitle } from "@/lib/classify";
import { THEATRE_TIMEZONE } from "@/lib/theatres";
import snapshot from "@/data/snapshot.json";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RARE_THRESHOLD = 2;

// Shape shared by both the live-DB query and the bundled snapshot, so the
// enrichment/filtering below is identical regardless of source.
interface Row {
  id: string;
  startsAt: Date;
  movieId: string;
  format: string | null;
  ticketUrl: string;
  movie: {
    id: string;
    title: string;
    slug: string;
    isClassic: boolean;
    isSpecialEvent: boolean;
    isIndie: boolean;
    isForeign: boolean;
    posterUrl: string | null;
    letterboxdRating: number | null;
    letterboxdUrl: string | null;
  };
  theatre: { slug: string; name: string };
}

interface LoadParams {
  start: Date;
  end: Date;
  theatreSlugs: string[];
  q: string;
}

// When DATABASE_URL is set we read from the live DB; otherwise we serve the
// snapshot bundled at build time. This is what lets the app deploy to Vercel
// before any database is provisioned — set DATABASE_URL later to go live.
async function loadData(p: LoadParams): Promise<{ rows: Row[]; theatres: { slug: string; name: string }[] }> {
  if (process.env.DATABASE_URL) {
    // Postgres `contains` is case-sensitive and needs an explicit mode that
    // SQLite rejects, so only set it on Postgres.
    const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL);
    const titleFilter = isPg ? { contains: p.q, mode: "insensitive" as const } : { contains: p.q };
    const rows = await prisma.showtime.findMany({
      where: {
        startsAt: { gte: p.start, lt: p.end },
        theatre: { active: true, ...(p.theatreSlugs.length ? { slug: { in: p.theatreSlugs } } : {}) },
        ...(p.q ? { movie: { title: titleFilter } } : {}),
      },
      include: { movie: true, theatre: true },
      orderBy: { startsAt: "asc" },
    });
    const theatres = await prisma.theatre.findMany({
      where: { active: true },
      select: { slug: true, name: true },
      orderBy: { name: "asc" },
    });
    return { rows, theatres };
  }

  const ql = p.q.toLowerCase();
  const rows: Row[] = snapshot.showtimes
    .map((s) => ({ ...s, startsAt: new Date(s.startsAt) }))
    .filter((s) => s.startsAt >= p.start && s.startsAt < p.end)
    .filter((s) => s.theatre.active && (!p.theatreSlugs.length || p.theatreSlugs.includes(s.theatre.slug)))
    .filter((s) => !ql || s.movie.title.toLowerCase().includes(ql))
    .sort((a, b) => a.startsAt.getTime() - b.startsAt.getTime())
    .map((s) => ({
      id: s.id,
      startsAt: s.startsAt,
      movieId: s.movieId,
      format: s.format,
      ticketUrl: s.ticketUrl,
      movie: s.movie,
      theatre: { slug: s.theatre.slug, name: s.theatre.name },
    }));
  const theatres = snapshot.theatres
    .filter((t) => t.active)
    .map((t) => ({ slug: t.slug, name: t.name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { rows, theatres };
}

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const startParam = sp.get("start");
  const start = startParam
    ? DateTime.fromISO(startParam, { zone: THEATRE_TIMEZONE })
    : DateTime.now().setZone(THEATRE_TIMEZONE).startOf("day");
  const days = Math.min(Math.max(parseInt(sp.get("days") ?? "7", 10) || 7, 1), 42);
  const end = start.plus({ days });

  const theatreSlugs = (sp.get("theatres") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const q = (sp.get("q") ?? "").trim();
  const category = (sp.get("category") ?? "all").toLowerCase();

  const loaded = await loadData({
    start: start.toJSDate(),
    end: end.toJSDate(),
    theatreSlugs,
    q,
  });
  const theatres = loaded.theatres;
  // Drop non-public listings (e.g. private theatre rentals) before anything else,
  // so they're excluded from rareness counts and never rendered.
  const rows = loaded.rows.filter((r) => !isHiddenTitle(r.movie.title));

  // rareness: count showtimes per movie within the visible window. The threshold
  // scales with the window so "rare" always means ≤ RARE_THRESHOLD per week —
  // a week (7d) stays ≤2, a month (28d) becomes ≤8 — consistent across views.
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.movieId, (counts.get(r.movieId) ?? 0) + 1);
  const rareThreshold = RARE_THRESHOLD * (days / 7);

  const enriched = rows.map((r) => {
    const isRare = (counts.get(r.movieId) ?? 0) <= rareThreshold;
    return {
      id: r.id,
      startsAt: r.startsAt.toISOString(),
      dateKey: DateTime.fromJSDate(r.startsAt, { zone: THEATRE_TIMEZONE }).toISODate(),
      time: DateTime.fromJSDate(r.startsAt, { zone: THEATRE_TIMEZONE }).toFormat("h:mm a"),
      format: r.format,
      ticketUrl: r.ticketUrl,
      movie: {
        id: r.movie.id,
        title: r.movie.title,
        slug: r.movie.slug,
        isClassic: r.movie.isClassic,
        isSpecialEvent: r.movie.isSpecialEvent,
        isIndie: r.movie.isIndie,
        isForeign: r.movie.isForeign,
        isRare,
        posterUrl: r.movie.posterUrl,
        letterboxdRating: r.movie.letterboxdRating,
        letterboxdUrl: r.movie.letterboxdUrl,
      },
      theatre: { slug: r.theatre.slug, name: r.theatre.name },
      isGem:
        r.movie.isClassic || r.movie.isSpecialEvent || r.movie.isIndie || r.movie.isForeign || isRare,
    };
  });

  const filtered = enriched.filter((r) => {
    if (category === "classic") return r.movie.isClassic;
    if (category === "special") return r.movie.isSpecialEvent;
    if (category === "gems") return r.isGem;
    return true;
  });

  const dayKeys: string[] = [];
  for (let i = 0; i < days; i++) dayKeys.push(start.plus({ days: i }).toISODate()!);

  return NextResponse.json({
    start: start.toISODate(),
    days,
    dayKeys,
    theatres,
    showtimes: filtered,
    total: filtered.length,
  });
}
