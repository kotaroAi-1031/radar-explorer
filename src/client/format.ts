/** Format a GDELT seendate ("20260815T120000Z") for display. */
export function formatSeendate(s: string | null): string {
  if (!s) return "—";
  const m = s.match(/^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})/);
  if (!m) return s;
  return `${m[1]}-${m[2]}-${m[3]} ${m[4]}:${m[5]} UTC`;
}

/** Format an ISO timestamp as a UTC calendar day ("2026-08-15"). */
export function formatIsoDay(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}`;
}
