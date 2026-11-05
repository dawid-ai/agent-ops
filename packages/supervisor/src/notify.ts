// Notifications outside the app: inbox items for the human and failed runs, posted to a webhook
// (Discord or Slack incoming webhooks, or anything that takes the same JSON). The URL is a secret:
// it lives only in the user config, settings never return it, and no message or log line holds it.
import { join } from 'node:path';
import { OpsError } from '@agent-ops/core';
import type { RunStore } from './runs.js';

export const NOTIFY_KINDS = [
  'ask',
  'review',
  'triage',
  'decide',
  'mention',
  'message',
  'run-failed',
] as const;

export interface NotifyConfig {
  webhook?: string;
  /** Which items to send; all when left out. */
  kinds?: string[];
}

/** Checks a webhook URL: https, or http only to this machine (local relays and tests). */
export function checkWebhook(raw: unknown): string {
  if (typeof raw !== 'string' || !raw.trim()) throw new OpsError('notify.webhook: use a URL', 2);
  let url: URL;
  try {
    url = new URL(raw.trim());
  } catch {
    throw new OpsError('notify.webhook: not a URL', 2);
  }
  const local = url.hostname === '127.0.0.1' || url.hostname === 'localhost';
  if (url.protocol !== 'https:' && !(url.protocol === 'http:' && local)) {
    throw new OpsError('notify.webhook: use an https URL', 2);
  }
  if (url.username || url.password)
    throw new OpsError('notify.webhook: no user or password in the URL', 2);
  return url.toString();
}

export function checkNotify(raw: unknown): NotifyConfig {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object' || Array.isArray(raw))
    throw new OpsError('opsd.notify: use a mapping', 2);
  const r = raw as Record<string, unknown>;
  for (const k of Object.keys(r)) {
    if (k !== 'webhook' && k !== 'kinds') throw new OpsError(`opsd.notify.${k}: not a setting`, 2);
  }
  const out: NotifyConfig = {};
  if (r.webhook !== undefined && r.webhook !== null) out.webhook = checkWebhook(r.webhook);
  if (r.kinds !== undefined && r.kinds !== null) {
    if (
      !Array.isArray(r.kinds) ||
      r.kinds.some((k) => !(NOTIFY_KINDS as readonly string[]).includes(String(k)))
    ) {
      throw new OpsError(`opsd.notify.kinds: use any of ${NOTIFY_KINDS.join(', ')}`, 2);
    }
    out.kinds = r.kinds.map(String);
  }
  return out;
}

/** The JSON a webhook takes: Discord reads `content`, Slack reads `text`; others get both. */
export function webhookBody(url: string, text: string): Record<string, string> {
  const host = new URL(url).hostname;
  if (/(^|\.)discord(app)?\.com$/.test(host)) return { content: text.slice(0, 1990) };
  if (host === 'hooks.slack.com') return { text };
  return { text, content: text };
}

export interface NotifyItem {
  /** Stable per item, so each is sent once. */
  key: string;
  kind: string;
  line: string;
}

interface NotifyState {
  sent: string[];
  /** The first look only records what is already waiting: old items are not news. */
  seeded: boolean;
  posts: number[];
  retryAt?: number;
}

/** Posts at most this many messages per window; the rest wait. */
const MAX_POSTS = 6;
const WINDOW_MS = 10 * 60_000;
const RETRY_MS = 5 * 60_000;
const MAX_LINES = 10;
const MAX_CHARS = 1900;
const MAX_SENT = 2000;

export class Notifier {
  private queue: NotifyItem[] = [];
  private busy = false;

  constructor(
    private readonly store: RunStore,
    private readonly warn: (msg: string) => void,
    private readonly post: typeof fetch = fetch,
  ) {}

  private state(): NotifyState {
    return this.store.readJson<NotifyState>('notify.json', { sent: [], seeded: false, posts: [] });
  }

  private save(s: NotifyState): void {
    s.sent = s.sent.slice(-MAX_SENT);
    this.store.writeJson('notify.json', s);
  }

  /** Queues items not sent before; the first call only records them. */
  offer(items: NotifyItem[], cfg: NotifyConfig): void {
    const s = this.state();
    const kinds = cfg.kinds ?? [...NOTIFY_KINDS];
    const fresh = items.filter(
      (i) =>
        kinds.includes(i.kind) &&
        !s.sent.includes(i.key) &&
        !this.queue.some((q) => q.key === i.key),
    );
    if (!s.seeded) {
      s.sent.push(...items.map((i) => i.key));
      s.seeded = true;
      this.save(s);
      return;
    }
    this.queue.push(...fresh);
  }

  /** Sends what is queued as one message, within the rate limit. Never throws. */
  async flush(cfg: NotifyConfig, now = Date.now()): Promise<void> {
    if (this.busy || !cfg.webhook || this.queue.length === 0) return;
    this.busy = true;
    try {
      await this.flushOnce(cfg.webhook, now);
    } catch {
      // State I/O failed: say so without details (they could name paths), and keep the queue.
      this.warn('notify: could not read or write its state; will try again');
    } finally {
      this.busy = false;
    }
  }

  private async flushOnce(webhook: string, now: number): Promise<void> {
    const s = this.state();
    s.posts = s.posts.filter((t) => now - t < WINDOW_MS);
    if (s.posts.length >= MAX_POSTS || (s.retryAt && now < s.retryAt)) return;
    // Lines are added while the message stays under every webhook's size limit (Discord takes
    // 2000 characters); only the lines that went out are marked sent.
    const lines: string[] = [];
    const batch: NotifyItem[] = [];
    let size = 'Agent Ops:\n'.length + 60;
    for (const i of this.queue) {
      const line = `- ${i.line.length > 300 ? `${i.line.slice(0, 299)}…` : i.line}`;
      if (batch.length >= MAX_LINES || size + line.length + 1 > MAX_CHARS) break;
      lines.push(line);
      batch.push(i);
      size += line.length + 1;
    }
    const more = this.queue.length - batch.length;
    if (more > 0) lines.push(`- and ${more} more in the Agent Ops inbox`);
    {
      const ok = await this.send(webhook, `Agent Ops:\n${lines.join('\n')}`);
      if (ok) {
        this.queue = this.queue.slice(batch.length);
        s.sent.push(...batch.map((i) => i.key));
        s.posts.push(now);
        s.retryAt = undefined;
      } else {
        s.retryAt = now + RETRY_MS;
      }
      this.save(s);
    }
  }

  /** Posts one message; reports failures without the URL. */
  async send(webhook: string, text: string): Promise<boolean> {
    try {
      const res = await this.post(webhook, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(webhookBody(webhook, text)),
        signal: AbortSignal.timeout(10_000),
      });
      if (res.ok) return true;
      this.warn(`notify: the webhook answered HTTP ${res.status}`);
      return false;
    } catch {
      this.warn('notify: the webhook could not be reached');
      return false;
    }
  }

  /** For tests and the state folder listing. */
  static file(dir: string): string {
    return join(dir, 'notify.json');
  }
}
