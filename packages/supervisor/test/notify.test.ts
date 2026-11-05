import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { checkWebhook, Notifier, RunStore, webhookBody } from '../src/index.js';

const dirs: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const s of servers.splice(0)) await new Promise((r) => s.close(r));
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

/** A webhook on this machine that records what it gets and answers `status`. */
async function hook(status = 204): Promise<{ url: string; got: Array<Record<string, string>> }> {
  const got: Array<Record<string, string>> = [];
  const server = createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      got.push(JSON.parse(body) as Record<string, string>);
      res.statusCode = status;
      res.end();
    });
  });
  servers.push(server);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hook/secret-part`,
    got,
  };
}

function store(): RunStore {
  const d = mkdtempSync(join(tmpdir(), 'opsd-notify-'));
  dirs.push(d);
  return new RunStore(d);
}

const item = (n: number) => ({
  key: `ask:T-${n}:e${n}`,
  kind: 'ask',
  line: `T-${n} ask: question ${n}`,
});

describe('webhook notifications', () => {
  it('takes https webhooks, and http only on this machine', () => {
    expect(checkWebhook('https://discord.com/api/webhooks/1/abc')).toBe(
      'https://discord.com/api/webhooks/1/abc',
    );
    expect(checkWebhook('http://127.0.0.1:9999/x')).toBe('http://127.0.0.1:9999/x');
    expect(() => checkWebhook('http://example.com/hook')).toThrow(/https/);
    expect(() => checkWebhook('https://user:pw@example.com/hook')).toThrow(/user or password/);
    expect(() => checkWebhook('not a url')).toThrow(/not a URL/);
    expect(() => checkWebhook(5)).toThrow(/use a URL/);
  });

  it('shapes the message for Discord, Slack and anything else', () => {
    expect(webhookBody('https://discord.com/api/webhooks/1/a', 'hi')).toEqual({ content: 'hi' });
    expect(webhookBody('https://hooks.slack.com/services/a', 'hi')).toEqual({ text: 'hi' });
    expect(webhookBody('https://example.com/h', 'hi')).toEqual({ text: 'hi', content: 'hi' });
  });

  it('skips what already waited, sends each new item once, and keeps to the rate limit', async () => {
    const h = await hook();
    const warnings: string[] = [];
    const n = new Notifier(store(), (m) => warnings.push(m));
    const cfg = { webhook: h.url };
    n.offer([item(1)], cfg);
    await n.flush(cfg, 1_000);
    expect(h.got).toEqual([]);
    n.offer([item(1), item(2)], cfg);
    await n.flush(cfg, 2_000);
    expect(h.got).toHaveLength(1);
    expect(h.got[0]!.text).toContain('T-2 ask: question 2');
    expect(h.got[0]!.text).not.toContain('question 1');
    n.offer([item(1), item(2)], cfg);
    await n.flush(cfg, 3_000);
    expect(h.got).toHaveLength(1);
    // Six posts per ten minutes; the seventh waits.
    for (let i = 3; i < 10; i++) {
      n.offer([item(i)], cfg);
      await n.flush(cfg, 4_000 + i);
    }
    expect(h.got).toHaveLength(6);
    expect(warnings).toEqual([]);
  });

  it('sends long batches in parts and marks only what went out', async () => {
    const h = await hook();
    const n = new Notifier(store(), () => {});
    const cfg = { webhook: h.url };
    n.offer([], cfg);
    const long = (i: number) => ({
      key: `ask:T-${i}:e`,
      kind: 'ask',
      line: `T-${i} ${'x'.repeat(280)}`,
    });
    n.offer(
      Array.from({ length: 10 }, (_, i) => long(i)),
      cfg,
    );
    await n.flush(cfg, 1_000);
    await n.flush(cfg, 2_000);
    await n.flush(cfg, 3_000);
    const all = h.got.map((b) => b.text ?? '').join('\n');
    for (let i = 0; i < 10; i++) expect(all).toContain(`T-${i} `);
    for (const b of h.got) expect((b.text ?? '').length).toBeLessThan(2000);
    expect(h.got.length).toBeGreaterThan(1);
  });

  it('never throws when its state cannot be read or written', async () => {
    const warnings: string[] = [];
    const broken = {
      readJson: () => {
        throw new Error('disk gone at C:\\\\secret\\\\path');
      },
      writeJson: () => {
        throw new Error('disk gone');
      },
    } as unknown as RunStore;
    const n = new Notifier(broken, (m) => warnings.push(m));
    (n as unknown as { queue: unknown[] }).queue.push(item(1));
    await expect(n.flush({ webhook: 'https://example.com/x' }, 1)).resolves.toBeUndefined();
    expect(warnings).toEqual(['notify: could not read or write its state; will try again']);
  });

  it('reports a failing webhook without its URL and waits before trying again', async () => {
    const h = await hook(500);
    const warnings: string[] = [];
    const n = new Notifier(store(), (m) => warnings.push(m));
    const cfg = { webhook: h.url };
    n.offer([], cfg);
    n.offer([item(1)], cfg);
    await n.flush(cfg, 10_000);
    expect(warnings).toEqual(['notify: the webhook answered HTTP 500']);
    await n.flush(cfg, 20_000);
    expect(h.got).toHaveLength(1);
    const unreachable = new Notifier(store(), (m) => warnings.push(m));
    expect(await unreachable.send('http://127.0.0.1:9/secret-part', 'x')).toBe(false);
    expect(warnings.join('\n')).not.toMatch(/secret-part|127\.0\.0\.1/);
  });
});
