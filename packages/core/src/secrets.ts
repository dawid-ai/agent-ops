import { readFileSync, statSync } from 'node:fs';
import { sniffImage } from './attachments.js';

/** Secret patterns shared by the write path (events, tasks) and the leak check (files). */
export const SECRET_PATTERNS: ReadonlyArray<{ kind: string; re: RegExp }> = [
  { kind: 'GitHub token', re: /gh[pousr]_[A-Za-z0-9]{30,}/ },
  { kind: 'GitHub fine-grained token', re: /github_pat_[A-Za-z0-9_]{30,}/ },
  { kind: 'API key (sk-...)', re: /(^|[^A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/ },
  { kind: 'Slack token', re: /xox[abprs]-[A-Za-z0-9-]{10,}/ },
  { kind: 'AWS access key', re: /AKIA[0-9A-Z]{16}/ },
  { kind: 'private key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { kind: 'Slack webhook URL', re: /hooks\.slack\.com\/services\/[A-Za-z0-9/]{20,}/ },
  {
    kind: 'Discord webhook URL',
    re: /discord(?:app)?\.com\/api\/webhooks\/\d+\/[A-Za-z0-9_-]{20,}/,
  },
  { kind: 'bearer token', re: /Authorization:\s*(?:Bearer|token)\s+[A-Za-z0-9._~+/=-]{20,}/i },
];

const KEY_FILE_RE = /(\.pem|\.p12|\.pfx|\.key|id_rsa[^/\\]*|id_ed25519[^/\\]*)$/i;

/** Whether a file's name says it holds a key: `.pem`, `.key`, `id_rsa` and the like. */
export function isKeyFile(path: string): boolean {
  return KEY_FILE_RE.test(path);
}

/** Returns the kind of the first secret found in `text`, or null. Never returns the secret. */
export function secretKind(text: string): string | null {
  for (const p of SECRET_PATTERNS) if (p.re.test(text)) return p.kind;
  return null;
}

/**
 * Removes from `text` every line that looks like it holds a secret, and private key blocks whole,
 * leaving a marker that names the kind. For output opsd keeps (logs, events), which may print what
 * a command read from its environment. The result passes `secretKind`.
 */
export function redactSecrets(text: string): string {
  if (!secretKind(text)) return text;
  const out: string[] = [];
  let inKey = false;
  for (const line of text.split('\n')) {
    if (inKey) {
      if (/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = false;
      continue;
    }
    const kind = secretKind(line);
    if (!kind) {
      out.push(line);
      continue;
    }
    out.push(`[line removed: it looks like a ${kind}]`);
    if (kind === 'private key' && !/-----END [A-Z ]*PRIVATE KEY-----/.test(line)) inKey = true;
  }
  const result = out.join('\n');
  // A pattern that only matches across lines: keep nothing.
  return secretKind(result) ? '[output removed: it looks like it holds a secret]' : result;
}

export interface LeakHit {
  file: string;
  line?: number;
  kind: string;
}

export interface LeakOptions {
  /** Terms that must not appear (case-insensitive), such as org names or machine names. */
  deny?: string[];
  /** Files larger than this are skipped. */
  maxBytes?: number;
}

/** Scans files for key files, secret-looking strings and denied terms. */
export function scanFiles(files: string[], opts: LeakOptions = {}): LeakHit[] {
  const hits: LeakHit[] = [];
  const deny = (opts.deny ?? []).map((t) => t.trim().toLowerCase()).filter(Boolean);
  const maxBytes = opts.maxBytes ?? 2_000_000;
  for (const file of files) {
    if (isKeyFile(file)) hits.push({ file, kind: 'key file' });
    let text: string;
    try {
      if (statSync(file).size > maxBytes) continue;
      const buf = readFileSync(file);
      // Binary files, such as attached images, have no lines to match; random bytes in them
      // could match a pattern by chance. An image needs no NUL byte, so it is checked by type.
      if (buf.includes(0) || sniffImage(buf)) continue;
      text = buf.toString('utf8');
    } catch {
      continue;
    }
    const lines = text.split('\n');
    lines.forEach((line, i) => {
      const kind = secretKind(line);
      if (kind) hits.push({ file, line: i + 1, kind });
      const lower = line.toLowerCase();
      for (const term of deny) {
        if (lower.includes(term)) hits.push({ file, line: i + 1, kind: `denied term '${term}'` });
      }
    });
  }
  return hits;
}

/** Reads a deny file: one term per line, `#` starts a comment. */
export function readDenyFile(path: string): string[] {
  return readFileSync(path, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'));
}
