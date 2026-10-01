export interface TheatreRef {
  /** stable id we use as the DB key (we use the slug) */
  id: string;
  slug: string;
  /** path under /movie-theatres, e.g. "chicago/amc-river-east-21" */
  urlPath: string;
  name: string;
}

export interface RawShowtime {
  showtimeId: string;
  movieId: string;
  movieSlug: string;
  movieTitle: string;
  /** absolute instant of the screening */
  startsAt: Date;
  /** screen format, e.g. "Dolby Cinema at AMC", "Laser at AMC", or "Standard" */
  format: string;
  ticketUrl: string;
  /** raw AMC attribute labels, e.g. ["AMC Artisan Films", "Reserved Seating"] */
  attributes: string[];
  /** MPAA rating from the source, e.g. "PG-13" (API only; scraper leaves unset) */
  mpaaRating?: string;
  /** runtime in minutes from the source (API only) */
  runtimeMinutes?: number;
}

export interface ShowtimeProvider {
  name: string;
  open(): Promise<void>;
  close(): Promise<void>;
  /** date is an ISO calendar date "YYYY-MM-DD" in the theatre's local timezone */
  getShowtimes(theatre: TheatreRef, date: string): Promise<RawShowtime[]>;
}
