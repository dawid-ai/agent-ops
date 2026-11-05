import { mkdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  attachmentRefs,
  findAttachment,
  initRoot,
  MAX_ATTACHMENT_BYTES,
  scanFiles,
  sniffImage,
  Workspace,
} from '../src/index.js';
import { fakeToken, gitRepo, setup, tempDir } from './helpers.js';

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/** A file that starts like a PNG, with `rest` after the signature. */
function png(rest = 'pixels'): Buffer {
  return Buffer.concat([PNG, Buffer.from(rest)]);
}

describe('attachments', () => {
  it('tells image types by their first bytes, never by name', () => {
    expect(sniffImage(png())).toBe('png');
    expect(sniffImage(Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 0]))).toBe('jpg');
    expect(sniffImage(Buffer.from('GIF89a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('GIF87a....'))).toBe('gif');
    expect(sniffImage(Buffer.from('RIFF\x10\x00\x00\x00WEBPVP8 '))).toBe('webp');
    expect(sniffImage(Buffer.from('RIFF\x10\x00\x00\x00WAVEfmt '))).toBeNull();
    expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull();
    expect(sniffImage(Buffer.from('plain text'))).toBeNull();
    expect(sniffImage(Buffer.alloc(0))).toBeNull();
  });

  it('stores an image under attachments/ with a ULID name and a Markdown link', () => {
    const { as, rootDir } = setup();
    const a = as('human:dawid').attach(png(), { alt: 'login [page]' });
    expect(a.name).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}\.png$/);
    expect(a.ref).toBe(`attachments/${a.name}`);
    expect(a.file).toBe(join(rootDir, 'attachments', a.name));
    expect(a.markdown).toBe(`![login page](attachments/${a.name})`);
    expect(a.type).toBe('image/png');
    expect(readFileSync(a.file)).toEqual(png());
  });

  it('refuses other types, empty files and files over the cap', () => {
    const ws = setup().as('human:dawid');
    expect(() => ws.attach(Buffer.from('<svg/>'))).toThrow(/not a PNG, JPEG, WebP or GIF/);
    expect(() => ws.attach(Buffer.alloc(0))).toThrow(/empty/);
    const big = Buffer.concat([PNG, Buffer.alloc(MAX_ATTACHMENT_BYTES)]);
    expect(() => ws.attach(big)).toThrow(/5\.0 MB at most/);
  });

  it("stores a comment's image in the task's root", () => {
    const { repo, env, rootDir } = setup();
    const betaDir = gitRepo();
    initRoot(betaDir, { name: 'beta', human: 'human:dawid' });
    const ws = new Workspace({
      cwd: repo,
      env: { ...env, OPS_ROOTS: betaDir } as NodeJS.ProcessEnv,
      actor: 'human:dawid',
    });
    const beta = ws.roots.find((r) => r.name === 'beta')!;
    const task = ws.newTask({ title: 'Screen' }, beta);
    const a = ws.attach(png(), { task: `beta/${task.id}` });
    expect(a.root).toBe('beta');
    expect(a.file).toBe(join(beta.dir, 'attachments', a.name));
    // Without a task, the default root: where new tasks and channel posts go.
    expect(ws.attach(png()).file.startsWith(rootDir)).toBe(true);
  });

  it('finds attachments by name only, never by a path', () => {
    const { as, rootDir } = setup();
    const ws = as('human:dawid');
    const a = ws.attach(png());
    expect(findAttachment(ws.roots, a.name)?.file).toBe(a.file);
    expect(ws.attachment(a.name).ref).toBe(a.ref);
    writeFileSync(join(rootDir, 'config.yml.png'), png());
    for (const bad of [
      '../config.yml',
      `../attachments/${a.name}`,
      a.name.toLowerCase(),
      `${a.name.slice(0, -4)}.svg`,
      'config.yml.png',
    ]) {
      expect(findAttachment(ws.roots, bad)).toBeNull();
    }
    expect(() => ws.attachment('../task.md')).toThrow(/no attachment/);
  });

  it('never follows a linked attachments folder out of the root', () => {
    const { as, rootDir } = setup();
    const ws = as('human:dawid');
    const outside = tempDir();
    const name = '01M6J3V01Z93MGX79812GGJG33.png';
    writeFileSync(join(outside, name), png('secret'));
    // A junction on Windows needs no extra rights; elsewhere it is a plain directory link.
    symlinkSync(outside, join(rootDir, 'attachments'), 'junction');
    expect(findAttachment(ws.roots, name)).toBeNull();
    expect(() => ws.attach(png())).toThrow(/leads outside the root/);
  });

  it('never follows a linked attachment file out of the root', (ctx) => {
    const { as, rootDir } = setup();
    const ws = as('human:dawid');
    const outside = join(tempDir(), 'secret.png');
    writeFileSync(outside, png('secret'));
    const name = '01M6J3V01Z93MGX79812GGJG33.png';
    mkdirSync(join(rootDir, 'attachments'), { recursive: true });
    try {
      symlinkSync(outside, join(rootDir, 'attachments', name), 'file');
    } catch (err) {
      // Windows without Developer Mode refuses file links.
      if ((err as NodeJS.ErrnoException).code === 'EPERM') return ctx.skip();
      throw err;
    }
    expect(findAttachment(ws.roots, name)).toBeNull();
  });

  it('lists the attachments that text refers to', () => {
    const n1 = '01M6J3V01Z93MGX79812GGJG33.png';
    const n2 = '01M6J3V01Z93MGX79812GGJG34.webp';
    const text = `See ![a](attachments/${n1}) and ![b](./attachments/${n2}).\n![again](attachments/${n1})`;
    expect(attachmentRefs(text)).toEqual([n1, n2]);
    expect(attachmentRefs('no images; attachments/notaulid.png; xattachments/' + n1)).toEqual([]);
  });

  it('resolves only attachments a visible root holds', () => {
    const ws = setup().as('human:dawid');
    const a = ws.attach(png());
    const missing = '01M6J3V01Z93MGX79812GGJG33.png';
    const found = ws.attachmentsIn(`![x](attachments/${a.name})`, `![y](attachments/${missing})`);
    expect(found.map((f) => f.name)).toEqual([a.name]);
  });

  it('leak check skips image files but still scans text', () => {
    const dir = tempDir();
    const image = join(dir, 'shot.png');
    const text = join(dir, 'note.md');
    // No NUL byte: before, a PNG like this was scanned as text.
    writeFileSync(image, png(` ${fakeToken()} `));
    writeFileSync(text, `token ${fakeToken()}\n`);
    const hits = scanFiles([image, text]);
    expect(hits.map((h) => h.file)).toEqual([text]);
  });
});
