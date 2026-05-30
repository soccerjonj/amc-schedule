import type { TheatreRef } from "./providers/types";

export const THEATRE_TIMEZONE = "America/Chicago";

// v1 seed theaters (downtown Chicago). `urlPath` is the path under
// /movie-theatres on amctheatres.com. Slugs are verified during ingestion;
// adding more theaters here (or a whole metro) is the only change needed to
// expand coverage.
export const SEED_THEATRES: TheatreRef[] = [
  {
    id: "amc-river-east-21",
    slug: "amc-river-east-21",
    urlPath: "chicago/amc-river-east-21",
    name: "AMC River East 21",
  },
  {
    id: "amc-600-north-michigan-9",
    slug: "amc-600-north-michigan-9",
    urlPath: "chicago/amc-600-north-michigan-9",
    name: "AMC 600 North Michigan 9",
  },
  {
    id: "amc-newcity-14",
    slug: "amc-newcity-14",
    urlPath: "chicago/amc-newcity-14",
    name: "AMC NEWCITY 14",
  },
  {
    id: "amc-dine-in-block-37",
    slug: "amc-dine-in-block-37",
    urlPath: "chicago/amc-dine-in-block-37",
    name: "AMC DINE-IN Block 37",
  },
  {
    id: "amc-roosevelt-collection-16",
    slug: "amc-roosevelt-collection-16",
    urlPath: "chicago/amc-roosevelt-collection-16",
    name: "AMC Roosevelt Collection 16",
  },
];
