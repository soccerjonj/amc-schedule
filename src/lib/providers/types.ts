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
  /** availability + pricing (API only) */
  soldOut?: boolean;
  almostSoldOut?: boolean;
  /** adult ticket price before tax/fees */
  price?: number;
  /** discount label on discounted matinees, e.g. "20% OFF" */
  discount?: string;
}

/** Rich movie info a provider can supply (AMC API movie resource). */
export interface MovieDetails {
  synopsis?: string;
  advisory?: string;
  cast?: string;
  directors?: string;
  genre?: string;
  trailerUrl?: string;
  posterUrl?: string;
}

/** A film announced as coming soon with no showtimes posted anywhere yet. */
export interface AnnouncedMovie extends MovieDetails {
  id: string;
  slug: string;
  title: string;
  releaseDate: Date;
  mpaaRating?: string;
  runtimeMinutes?: number;
}

export interface ShowtimeProvider {
  name: string;
  open(): Promise<void>;
  close(): Promise<void>;
  /** date is an ISO calendar date "YYYY-MM-DD" in the theatre's local timezone */
  getShowtimes(theatre: TheatreRef, date: string): Promise<RawShowtime[]>;
  /** Optional: rich details for movies seen this run, keyed by our movie id. */
  getMovieDetails?(movieIds: string[]): Promise<Map<string, MovieDetails>>;
  /** Optional: films announced (coming soon) with no showtimes yet, releasing within `days`. */
  getAnnounced?(days: number): Promise<AnnouncedMovie[]>;
}
