import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { initRoot, MAX_ATTACHMENT_BYTES } from '@agent-ops/core';
import { startApi, Supervisor } from '../src/index.js';

const dirs: string[] = [];
const sups: Supervisor[] = [];

afterEach(async () => {
  for (const s of sups.splice(0)) {
    s.stop({ killRuns: true });
    await s.close();
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true, maxRetries: 5 });
});

function temp(): string {
  const d = mkdtempSync(join(tmpdir(), 'opsd-attach-'));
  dirs.push(d);
  return d;
}

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);

async function setup() {
  const repo = temp();
  execFileSync('git', ['init', '-q'], { cwd: repo, windowsHide: true });
  const rootDir = initRoot(repo, { name: 'test', human: 'human:dawid' });
  const config = join(temp(), 'config.yml');
  writeFileSync(config, 'me: human:dawid\nopsd:\n  sync: false\n');
  const env = { ...process.env, OPS_CONFIG: config, OPS_STATE_DIR: temp() } as NodeJS.ProcessEnv;
  delete env.OPS_AGENT;
  delete env.OPS_ROOTS;
  const sup = new Supervisor({ env, cwd: repo, freeMem: () => 64 * 2 ** 30 });
  sups.push(sup);
  const api = await startApi(sup, { port: 0, token: 'att-token', version: 't', build: '1' });
  const url = (path: string): string => `http://127.0.0.1:${api.port}${path}`;
  const auth = { authorization: 'Bearer att-token' };
  const post = async (body: unknown) => {
    const res = await fetch(url('/api/attachments'), {
      method: 'POST',
      headers: { ...auth, 'content-type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  };
  const get = (name: string, headers: Record<string, string> = auth) =>
    fetch(url(`/api/attachments/${name}`), { headers });
  return { sup, rootDir, post, get };
}

describe('attachments API', () => {
  it('stores an upload and serves it back by name', async () => {
    const { post, get, rootDir } = await setup();
    const up = await post({ data: PNG.toString('base64'), alt: 'board' });
    expect(up.status).toBe(201);
    const name = up.data.name as string;
    expect(up.data.markdown).toBe(`![board](attachments/${name})`);
    // The local path stays on this machine.
    expect(up.data.file).toBeUndefined();
    expect(existsSync(join(rootDir, 'attachments', name))).toBe(true);

    const res = await get(name);
    expect(res.status).toBe(200);
    expect(res.headers.get('content-type')).toBe('image/png');
    expect(res.headers.get('x-content-type-options')).toBe('nosniff');
    expect(Buffer.from(await res.arrayBuffer())).toEqual(PNG);
  });

  it('puts a comment image in the task root', async () => {
    const { sup, post } = await setup();
    const t = sup.ws('human:dawid').newTask({ title: 'Screen' });
    const up = await post({ data: PNG.toString('base64'), task: t.id });
    expect(up.status).toBe(201);
    expect(up.data.root).toBe('test');
  });

  it('refuses what is not an image, bad base64 and bodies over the cap', async () => {
    const { post } = await setup();
    const svg = await post({ data: Buffer.from('<svg/>').toString('base64') });
    expect(svg.status).toBe(400);
    expect(svg.data.error).toMatch(/not a PNG/);
    expect((await post({ data: 'not base64!' })).status).toBe(400);
    expect((await post({})).status).toBe(400);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]).toString('base64');
    const tooBig = await post({ data: big });
    expect(tooBig.status).toBe(400);
    expect(tooBig.data.error).toMatch(/5\.0 MB at most/);
  });

  it('serves only attachment names, and needs the token', async () => {
    const { post, get } = await setup();
    const up = await post({ data: PNG.toString('base64') });
    const name = up.data.name as string;
    expect((await get(name, {})).status).toBe(401);
    expect((await get('..%2Fconfig.yml')).status).toBe(404);
    expect((await get('..%2F..%2F.git%2Fconfig')).status).toBe(404);
    expect((await get('01M6J3V01Z93MGX79812GGJG33.png')).status).toBe(404);
    expect((await get(`${name.slice(0, -4)}.svg`)).status).toBe(404);
  });

  it('does not serve a file a linked attachments folder points to', async () => {
    const { get, rootDir } = await setup();
    const outside = temp();
    const name = '01M6J3V01Z93MGX79812GGJG33.png';
    writeFileSync(join(outside, name), PNG);
    symlinkSync(outside, join(rootDir, 'attachments'), 'junction');
    expect((await get(name)).status).toBe(404);
  });
});
