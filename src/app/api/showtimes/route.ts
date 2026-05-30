import { NextRequest, NextResponse } from "next/server";
import { DateTime } from "luxon";
import { prisma } from "@/lib/db";
import { THEATRE_TIMEZONE } from "@/lib/theatres";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const RARE_THRESHOLD = 2;

export async function GET(req: NextRequest) {
  const sp = req.nextUrl.searchParams;
  const startParam = sp.get("start");
  const start = startParam
    ? DateTime.fromISO(startParam, { zone: THEATRE_TIMEZONE })
    : DateTime.now().setZone(THEATRE_TIMEZONE).startOf("day");
  const days = Math.min(Math.max(parseInt(sp.get("days") ?? "7", 10) || 7, 1), 21);
  const end = start.plus({ days });

  const theatreSlugs = (sp.get("theatres") ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  const q = (sp.get("q") ?? "").trim();
  const category = (sp.get("category") ?? "all").toLowerCase();

  // SQLite's `contains` is already case-insensitive; Postgres needs an explicit
  // mode, which SQLite rejects — so only set it when running on Postgres.
  const isPg = /^postgres(ql)?:\/\//.test(process.env.DATABASE_URL ?? "");
  const titleFilter = isPg ? { contains: q, mode: "insensitive" as const } : { contains: q };

  const rows = await prisma.showtime.findMany({
    where: {
      startsAt: { gte: start.toJSDate(), lt: end.toJSDate() },
      theatre: { active: true, ...(theatreSlugs.length ? { slug: { in: theatreSlugs } } : {}) },
      ...(q ? { movie: { title: titleFilter } } : {}),
    },
    include: { movie: true, theatre: true },
    orderBy: { startsAt: "asc" },
  });

  // rareness: count showtimes per movie within the visible window
  const counts = new Map<string, number>();
  for (const r of rows) counts.set(r.movieId, (counts.get(r.movieId) ?? 0) + 1);

  const enriched = rows.map((r) => {
    const isRare = (counts.get(r.movieId) ?? 0) <= RARE_THRESHOLD;
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
        isRare,
      },
      theatre: { slug: r.theatre.slug, name: r.theatre.name },
      isGem: r.movie.isClassic || r.movie.isSpecialEvent || isRare,
    };
  });

  const filtered = enriched.filter((r) => {
    if (category === "classic") return r.movie.isClassic;
    if (category === "special") return r.movie.isSpecialEvent;
    if (category === "gems") return r.isGem;
    return true;
  });

  const theatres = await prisma.theatre.findMany({
    where: { active: true },
    select: { slug: true, name: true },
    orderBy: { name: "asc" },
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
