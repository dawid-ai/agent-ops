// Kept apart from main.ts so it can be tested without Electron.

const SEG = '[^/?#]+';
const QUERY = '(\\?[^#]*)?';
/** The calls the page makes, and nothing else: no shutdown, no unknown routes. */
const ALLOWED: Record<'GET' | 'POST', RegExp[]> = {
  GET: [
    'health',
    'inbox',
    'tasks',
    `tasks/${SEG}`,
    'agents',
    'directory',
    `roles/${SEG}`,
    'runs',
    `runs/${SEG}`,
    `runs/${SEG}/log`,
    `runs/${SEG}/procs`,
    'waits',
    'settings',
    'schedules',
    'repeats',
    'standup',
    'kb',
    'search',
    'activity',
    'report',
    'machines',
    'doctor',
    `kb/${SEG}/${SEG}`,
    'decisions',
    `decisions/${SEG}`,
    'channels',
    `channels/${SEG}`,
    'chat',
  ].map((p) => new RegExp(`^/api/${p}${QUERY}$`)),
  POST: [
    'tasks',
    `tasks/${SEG}/(comment|answer|unblock|done|release|reopen|park|priority|verdict|delegate|start|block|review|assign|retype)`,
    'runs',
    `runs/${SEG}/kill`,
    `runs/${SEG}/procs`,
    `decisions/${SEG}/(vote|decide)`,
    'channels',
    `channels/${SEG}`,
    'settings',
    'schedules',
    `schedules/${SEG}/(run|delete)`,
    'repeats',
    `repeats/${SEG}/(run|pause|resume|delete)`,
    `roots/${SEG}/mirror`,
    'notify/test',
    'roles',
    'attachments',
    'chat',
    'chat/(stop|reset)',
  ].map((p) => new RegExp(`^/api/${p}$`)),
};

/**
 * True when fetch sends the path as written. The URL parser resolves '.' and '..' segments (also
 * as '%2e'), reads '\' as '/' and drops tabs and newlines, so '/api/kb/../usage' would pass the
 * list and reach '/api/usage'.
 */
function sentAsWritten(path: string): boolean {
  const route = path.split('?', 1)[0]!;
  try {
    return new URL(`http://127.0.0.1${path}`).pathname === route && !/[\t\n\r]/.test(path);
  } catch {
    return false;
  }
}

export function allowedCall(method: unknown, path: unknown): boolean {
  if (method !== 'GET' && method !== 'POST') return false;
  if (typeof path !== 'string' || !sentAsWritten(path)) return false;
  return ALLOWED[method].some((re) => re.test(path));
}

/** The scheme the page loads attached images from: `ops-att://file/<name>`. */
export const ATTACHMENT_SCHEME = 'ops-att';

/** Same as ATTACHMENT_NAME_RE in core: a ULID and an image extension, nothing else. */
const NAME_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.(png|jpg|webp|gif)$/;

/** The attachment name in an `ops-att://file/<name>` URL, or null for any other URL. */
export function attachmentName(url: string): string | null {
  let u: URL;
  try {
    u = new URL(url);
  } catch {
    return null;
  }
  if (u.protocol !== `${ATTACHMENT_SCHEME}:` || u.host !== 'file' || u.search || u.hash) {
    return null;
  }
  const name = u.pathname.replace(/^\//, '');
  return NAME_RE.test(name) ? name : null;
}
