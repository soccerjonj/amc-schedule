import { AmcApiProvider } from "./amcApi";
import { AmcScraperProvider } from "./amcScraper";
import type { ShowtimeProvider } from "./types";

// Single place that decides the active data source. SHOWTIME_PROVIDER=api uses
// AMC's official API (needs AMC_VENDOR_KEY); anything else falls back to the
// Playwright scraper of amctheatres.com.
export function getProvider(): ShowtimeProvider {
  return process.env.SHOWTIME_PROVIDER === "api" ? new AmcApiProvider() : new AmcScraperProvider();
}

export type { ShowtimeProvider, RawShowtime, TheatreRef } from "./types";
