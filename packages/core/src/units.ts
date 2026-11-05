import { OpsError } from './ids.js';

const DURATION_RE = /^(?:(\d+(?:\.\d+)?)d)?(?:(\d+(?:\.\d+)?)h)?(?:(\d+(?:\.\d+)?)m)?$/;

/** Parses `90m`, `2h`, `1h30m`, `1d` or a bare number of minutes into minutes. */
export function parseDuration(text: string): number {
  const s = text.trim().toLowerCase();
  if (/^\d+$/.test(s)) return Number(s);
  const m = DURATION_RE.exec(s);
  if (!s || !m || (!m[1] && !m[2] && !m[3])) {
    throw new OpsError(`bad duration '${text}': use 90m, 2h, 1h30m or 1d`, 2);
  }
  const minutes = Number(m[1] ?? 0) * 1440 + Number(m[2] ?? 0) * 60 + Number(m[3] ?? 0);
  return Math.round(minutes);
}

/** Parses `400k`, `1.5m` or `400000` into a token count. */
export function parseTokens(text: string): number {
  const m = /^(\d+(?:\.\d+)?)([km]?)$/i.exec(text.trim());
  if (!m) throw new OpsError(`bad token count '${text}': use 400k, 1.5m or 400000`, 2);
  const mult = { '': 1, k: 1_000, m: 1_000_000 }[m[2]!.toLowerCase() as '' | 'k' | 'm'];
  return Math.round(Number(m[1]) * mult);
}

/**
 * Parses a point in time: `+2h` (from now), `18:00` (local time, today or tomorrow if passed),
 * a date such as `2026-11-03` (end of that local day), or any ISO timestamp. Returns ISO UTC.
 */
export function parseWhen(text: string, nowMs: number): string {
  const s = text.trim();
  if (s.startsWith('+')) return new Date(nowMs + parseDuration(s.slice(1)) * 60_000).toISOString();
  const hm = /^(\d{1,2}):(\d{2})$/.exec(s);
  if (hm) {
    const d = new Date(nowMs);
    d.setHours(Number(hm[1]), Number(hm[2]), 0, 0);
    if (d.getTime() <= nowMs) d.setDate(d.getDate() + 1);
    return d.toISOString();
  }
  const day = /^(\d{4})-(\d{2})-(\d{2})$/.exec(s);
  if (day) {
    return new Date(Number(day[1]), Number(day[2]) - 1, Number(day[3]), 23, 59, 59).toISOString();
  }
  const ms = Date.parse(s);
  if (Number.isNaN(ms)) {
    throw new OpsError(`bad time '${text}': use +2h, 18:00, 2026-11-03 or an ISO timestamp`, 2);
  }
  return new Date(ms).toISOString();
}

/** Formats minutes as `1h30m`. */
export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  if (h === 0) return `${m}m`;
  return m === 0 ? `${h}h` : `${h}h${m}m`;
}

/** Lowercase, hyphenated, ASCII-only slug of at most `max` characters. */
export function slugify(text: string, max = 60): string {
  const s = text
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return s.slice(0, max).replace(/-+$/, '');
}
