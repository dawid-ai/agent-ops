import { describe, expect, it } from 'vitest';
import {
  actorSlug,
  formatTaskId,
  isActorId,
  ownerMatches,
  parseDoc,
  parseTaskId,
  redactSecrets,
  secretKind,
  slugToActor,
  stringifyDoc,
  ulid,
  ulidAfter,
  ulidTime,
} from '../src/index.js';
import { fakeToken } from './helpers.js';

describe('ulid', () => {
  it('increases strictly within one millisecond', () => {
    const ids = Array.from({ length: 1000 }, () => ulid(1_700_000_000_000));
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('encodes the time', () => {
    expect(ulidTime(ulid(1_800_000_000_123))).toBe(1_800_000_000_123);
  });

  it('makes an id above a newer one when the clock is behind', () => {
    const prev = ulid(1_900_000_000_000);
    const next = ulidAfter(prev, 1_800_000_000_000);
    expect(next > prev).toBe(true);
    expect(ulidTime(next)).toBe(1_900_000_000_000);
    expect(ulidAfter('01M6ASAPBKZZZZZZZZZZZZZZZZ', 0) > '01M6ASAPBKZZZZZZZZZZZZZZZZ').toBe(true);
    expect(ulidAfter(undefined)).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
  });
});

describe('ids', () => {
  it('accepts agent and human ids', () => {
    expect(isActorId('claude:engineer')).toBe(true);
    expect(isActorId('human:dawid')).toBe(true);
    expect(isActorId('codex:frontend-dev')).toBe(true);
    expect(isActorId('agent:claude:engineer')).toBe(false);
    expect(isActorId('Claude:engineer')).toBe(false);
  });

  it('maps ids to file slugs and back', () => {
    for (const id of ['claude:engineer', 'codex:frontend-dev', 'human:dawid']) {
      expect(slugToActor(actorSlug(id))).toBe(id);
    }
  });

  it('matches runtime wildcards', () => {
    expect(ownerMatches('claude:*', 'claude:qa')).toBe(true);
    expect(ownerMatches('claude:*', 'codex:qa')).toBe(false);
    expect(ownerMatches('claude:qa', 'claude:qa')).toBe(true);
    expect(ownerMatches(null, 'claude:qa')).toBe(false);
  });

  it('formats and parses task ids', () => {
    expect(formatTaskId('T', 12)).toBe('T-0012');
    expect(formatTaskId('AO', 12345)).toBe('AO-12345');
    expect(parseTaskId('t-12')).toEqual({ prefix: 'T', n: 12 });
    expect(parseTaskId('nope')).toBeNull();
  });
});

describe('frontmatter', () => {
  it('round-trips data and body', () => {
    const text = stringifyDoc({ a: 1, b: ['x'], empty: '', gone: undefined }, 'Hello\n\nWorld');
    expect(text).toBe('---\na: 1\nb:\n  - x\n---\n\nHello\n\nWorld\n');
    expect(parseDoc(text)).toEqual({ data: { a: 1, b: ['x'] }, body: 'Hello\n\nWorld\n' });
  });

  it('reads CRLF files', () => {
    expect(parseDoc('---\r\na: 1\r\n---\r\n\r\nbody\r\n')).toEqual({
      data: { a: 1 },
      body: 'body\n',
    });
  });

  it('treats a file without frontmatter as body', () => {
    expect(parseDoc('just text')).toEqual({ data: {}, body: 'just text' });
  });
});

describe('secrets', () => {
  it('names the kind without echoing the value', () => {
    expect(secretKind(`token ${fakeToken()}`)).toBe('GitHub token');
    expect(secretKind('nothing to see')).toBeNull();
  });

  it('removes the lines and key blocks that look like secrets, and keeps the rest', () => {
    const key = ['-----BEGIN', 'RSA PRIVATE KEY-----'].join(' ');
    const end = ['-----END', 'RSA PRIVATE KEY-----'].join(' ');
    const text = [
      'before',
      `GH_TOKEN=${fakeToken()}`,
      key,
      'MIIEowIBAAKCAQEAbase64body',
      end,
      'after',
    ].join('\n');
    const out = redactSecrets(text);
    expect(out).toBe(
      [
        'before',
        '[line removed: it looks like a GitHub token]',
        '[line removed: it looks like a private key]',
        'after',
      ].join('\n'),
    );
    expect(secretKind(out)).toBeNull();
    expect(out).not.toContain('base64body');
    expect(redactSecrets('nothing to see\n')).toBe('nothing to see\n');
  });
});
