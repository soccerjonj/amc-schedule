import { AmcScraperProvider } from "./amcScraper";
import type { ShowtimeProvider } from "./types";

// Single place that decides the active data source. Swapping to an official-API
// or third-party provider later means returning a different implementation here.
export function getProvider(): ShowtimeProvider {
  return new AmcScraperProvider();
}

export type { ShowtimeProvider, RawShowtime, TheatreRef } from "./types";
