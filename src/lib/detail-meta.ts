// Server-only metadata lookup for the movie/series detail routes' generateMetadata.
// Reads the bundled snapshot so shared links unfurl with a title + poster without a
// DB round-trip. NOTE: imports snapshot.json — only import this from server
// components (never from a "use client" module, or the snapshot bloats the bundle).

import snapshot from "@/data/snapshot.json";
import { displayTitle, seriesByKey, seriesOf } from "./showtimes";

interface MetaInfo {
  title: string;
  description: string;
  image: string | null;
}

const SITE = "AMC Showtimes Chicago";

export function movieMeta(id: string): MetaInfo {
  const m = snapshot.showtimes.find((s) => s.movieId === id)?.movie;
  if (!m) return { title: SITE, description: "Easy-to-miss movie screenings across downtown Chicago AMC theatres.", image: null };
  const t = displayTitle(m.title);
  return {
    title: `${t} — ${SITE}`,
    description: `Showtimes for ${t} across downtown Chicago AMC theatres.`,
    image: m.posterUrl ?? null,
  };
}

export function seriesMeta(key: string): MetaInfo {
  const label = seriesByKey(key)?.label ?? "Series";
  const member = snapshot.showtimes.find((x) => seriesOf(x.movie.title)?.key === key && x.movie.posterUrl);
  return {
    title: `${label} — ${SITE}`,
    description: `All ${label} showtimes across downtown Chicago AMC theatres.`,
    image: member?.movie.posterUrl ?? null,
  };
}
