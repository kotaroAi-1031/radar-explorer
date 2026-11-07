// Shared data types for pool articles (kept dependency-free so pure
// modules and tests can import them without pulling in the DB client).

export interface Article {
  url: string;
  title: string | null;
  domain: string | null;
  language: string | null;
  sourceCountry: string | null;
  seendate: string | null;
  tone: number | null;
}

export interface ToneTrendPoint {
  day: string; // YYYYMMDD
  count: number;
  avgTone: number | null;
}
