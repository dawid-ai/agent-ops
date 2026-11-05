import { randomInt } from 'node:crypto';

// Crockford base32, as in the ULID spec. Lexicographic order equals time order.
const ENC = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const TIME_LEN = 10;
const RAND_LEN = 16;

let lastTime = -1;
let lastRand: number[] = [];

function encodeTime(ms: number): string {
  let out = '';
  for (let i = 0; i < TIME_LEN; i++) {
    out = ENC[ms % 32] + out;
    ms = Math.floor(ms / 32);
  }
  return out;
}

/** Returns a ULID. Ids made in one process are strictly increasing, even within one millisecond. */
export function ulid(now: number = Date.now()): string {
  if (now <= lastTime) {
    now = lastTime;
    let i = RAND_LEN - 1;
    while (i >= 0 && lastRand[i] === 31) {
      lastRand[i] = 0;
      i--;
    }
    if (i < 0) throw new Error('ulid: random part overflowed within one millisecond');
    lastRand[i] = (lastRand[i] ?? 0) + 1;
  } else {
    lastTime = now;
    lastRand = Array.from({ length: RAND_LEN }, () => randomInt(32));
  }
  return encodeTime(now) + lastRand.map((n) => ENC[n]).join('');
}

/**
 * Returns a ULID above `prev` (when given) and no earlier than `now`. Keeps event ids of one task
 * increasing in write order even when the clock is behind an id that came from another machine.
 */
export function ulidAfter(prev: string | undefined, now: number = Date.now()): string {
  if (!prev) return ulid(now);
  const id = ulid(Math.max(now, ulidTime(prev)));
  return id > prev ? id : increment(prev);
}

function increment(id: string): string {
  const chars = id.toUpperCase().split('');
  let i = chars.length - 1;
  while (i >= TIME_LEN && chars[i] === 'Z') {
    chars[i] = '0';
    i--;
  }
  if (i < TIME_LEN) return ulid(ulidTime(id) + 1);
  chars[i] = ENC[ENC.indexOf(chars[i]!) + 1]!;
  return chars.join('');
}

/**
 * The time part of a ULID for `ms`: every ULID made at or after `ms` sorts above it. Unlike
 * `ulid`, it does not move forward to the last id made, so it can name a time in the past.
 */
export function ulidTimePrefix(ms: number): string {
  return encodeTime(ms);
}

/** Returns the millisecond timestamp encoded in a ULID. */
export function ulidTime(id: string): number {
  let ms = 0;
  for (const ch of id.slice(0, TIME_LEN).toUpperCase()) {
    const v = ENC.indexOf(ch);
    if (v < 0) throw new Error(`ulid: bad character in ${id}`);
    ms = ms * 32 + v;
  }
  return ms;
}

export function isUlid(s: string): boolean {
  return /^[0-9A-HJKMNP-TV-Z]{26}$/.test(s);
}
