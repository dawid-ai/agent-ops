// @vitest-environment happy-dom
// Attached images: paste and drop in the New task description upload the image and insert its
// Markdown link at the caret; rendered Markdown shows only attachments; a click opens the
// lightbox, and Escape closes the lightbox without closing the dialog under it.
import { act, createElement } from 'react';
import { createRoot } from 'react-dom/client';
import type { Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  attachmentRef,
  fitWithin,
  imageFiles,
  insertAt,
  MAX_BYTES,
  prepareImage,
} from '../ui/src/lib/attachments';
import { renderMarkdown, showImage } from '../ui/src/lib/markdown';
import { Lightbox } from '../ui/src/ui/attach';
import { NewTask } from '../ui/src/views/NewTask';

const NAME = '01M6J3V01Z93MGX79812GGJG33.png';
const calls: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
// While set, uploads wait for it: a slow upload.
let gate: Promise<void> | null = null;

vi.mock(import('../ui/src/api'), async (original) => ({
  ...(await original()),
  useData: <T>() => ({ data: [] as T, error: null, reload: () => {} }),
  api: async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    calls.push({ method, path, body: body as Record<string, unknown> });
    if (path === '/api/attachments' && gate) await gate;
    return { name: NAME, markdown: `![shot](attachments/${NAME})` } as T;
  },
}));

declare global {
  var IS_REACT_ACT_ENVIRONMENT: boolean | undefined;
}

describe('attachment helpers', () => {
  it('accepts only attachment references as image sources', () => {
    expect(attachmentRef(`attachments/${NAME}`)).toBe(NAME);
    expect(attachmentRef(`./attachments/${NAME}`)).toBe(NAME);
    expect(attachmentRef(`ops-att://file/${NAME}`)).toBe(NAME);
    for (const src of [
      `https://example.com/attachments/${NAME}`,
      `file:///C:/attachments/${NAME}`,
      `../attachments/${NAME}`,
      `attachments/${NAME}?x`,
      'attachments/shot.png',
      'data:image/png;base64,AAAA',
    ]) {
      expect(attachmentRef(src), src).toBeNull();
    }
  });

  it('puts an inserted link on its own line', () => {
    expect(insertAt('', 0, 0, '![a](x)')).toEqual({ text: '![a](x)\n', caret: 8 });
    expect(insertAt('see this', 8, 8, '![a](x)')).toEqual({
      text: 'see this\n![a](x)\n',
      caret: 17,
    });
    expect(insertAt('one\ntwo', 4, 4, 'L')).toEqual({ text: 'one\nL\ntwo', caret: 6 });
    // A selection is replaced.
    expect(insertAt('a XX b', 2, 4, 'L').text).toBe('a \nL\n b');
  });

  it('fits big images within the longest side and leaves small ones alone', () => {
    expect(fitWithin(800, 600)).toEqual({ w: 800, h: 600 });
    expect(fitWithin(5120, 2880)).toEqual({ w: 2560, h: 1440 });
    expect(fitWithin(1000, 4000, 2000)).toEqual({ w: 500, h: 2000 });
  });

  it('keeps image files only', () => {
    const png = new File(['x'], 'a.png', { type: 'image/png' });
    const svg = new File(['<svg/>'], 'b.svg', { type: 'image/svg+xml' });
    const txt = new File(['x'], 'c.txt', { type: 'text/plain' });
    expect(imageFiles([png, svg, txt])).toEqual([png]);
    expect(imageFiles(null)).toEqual([]);
  });

  it('uploads small images as they are and refuses a GIF over the cap', async () => {
    const small = new File(['x'], 'a.png', { type: 'image/png' });
    expect(await prepareImage(small)).toBe(small);
    const gif = new File([new Uint8Array(MAX_BYTES + 1)], 'big.gif', { type: 'image/gif' });
    await expect(prepareImage(gif)).rejects.toThrow(/over 5 MB/);
  });
});

// The sanitizer hook calls showImage for every <img>. happy-dom's node iterator stops at <body>,
// so DOMPurify never reaches the hook here; the hook's work is tested on elements directly.
function image(src: string): HTMLImageElement {
  const img = document.createElement('img');
  img.setAttribute('src', src);
  img.setAttribute('srcset', 'https://example.com/big.png 2x');
  return img;
}

describe('rendered Markdown images', () => {
  it('loads an attachment from ops-att', () => {
    const img = image(`attachments/${NAME}`);
    showImage(img);
    expect(img.getAttribute('src')).toBe(`ops-att://file/${NAME}`);
    expect(img.getAttribute('data-attachment')).toBe(NAME);
    expect(img.className).toBe('attachment');
    expect(img.hasAttribute('srcset')).toBe(false);
  });

  it('drops every other source', () => {
    for (const src of ['https://example.com/x.png', 'file:///C:/x.png', 'attachments/x.png']) {
      const img = image(src);
      showImage(img);
      expect(img.hasAttribute('src'), src).toBe(false);
      expect(img.hasAttribute('srcset')).toBe(false);
      expect(img.className).toBe('attachment-blocked');
    }
  });

  it('keeps the attachment link in the Markdown output', () => {
    expect(renderMarkdown(`![shot](attachments/${NAME})`)).toContain(`alt="shot"`);
  });
});

let root: Root | undefined;
let box: HTMLDivElement;
let onClose: ReturnType<typeof vi.fn>;

beforeEach(() => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  calls.length = 0;
  onClose = vi.fn();
  box = document.createElement('div');
  document.body.append(box);
  root = createRoot(box);
  act(() =>
    root!.render(
      createElement('div', null, [
        createElement(NewTask, { key: 'n', me: 'human:dawid', onClose, onCreated: vi.fn() }),
        createElement(Lightbox, { key: 'l' }),
      ]),
    ),
  );
});

afterEach(() => {
  act(() => root?.unmount());
  root = undefined;
  box.remove();
});

function area(): HTMLTextAreaElement {
  return box.querySelector('textarea')!;
}

/** Waits until pending uploads (promises and the next frame) have settled. */
async function settle(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await act(async () => {
      await new Promise((r) => setTimeout(r, 20));
    });
  }
}

function transfer(kind: 'paste' | 'drop', files: File[]): Event {
  const e = new Event(kind, { bubbles: true, cancelable: true });
  const data = { files, types: ['Files'], items: [], getData: () => '' };
  Object.defineProperty(e, kind === 'paste' ? 'clipboardData' : 'dataTransfer', { value: data });
  return e;
}

describe('New task: images', () => {
  it('uploads a pasted image and inserts its link', async () => {
    const shot = new File([new Uint8Array([137, 80, 78, 71])], 'image.png', { type: 'image/png' });
    const e = transfer('paste', [shot]);
    act(() => {
      area().dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(true);
    await settle();
    expect(calls).toHaveLength(1);
    expect(calls[0]!.method).toBe('POST');
    expect(calls[0]!.path).toBe('/api/attachments');
    expect(calls[0]!.body.data).toBe(btoa(String.fromCharCode(137, 80, 78, 71)));
    expect(calls[0]!.body.alt).toBe('image');
    expect(area().value).toBe(`![shot](attachments/${NAME})\n`);
  });

  it('leaves a text paste alone', async () => {
    const e = transfer('paste', []);
    act(() => {
      area().dispatchEvent(e);
    });
    expect(e.defaultPrevented).toBe(false);
    await settle();
    expect(calls).toHaveLength(0);
  });

  it('uploads a dropped image', async () => {
    const shot = new File(['x'], 'header bug.png', { type: 'image/png' });
    act(() => {
      area().dispatchEvent(transfer('drop', [shot]));
    });
    await settle();
    expect(calls[0]!.body.alt).toBe('header bug');
    expect(area().value).toContain(`attachments/${NAME}`);
  });

  it('holds Create task until a pending upload is in the text', async () => {
    let release = (): void => {};
    gate = new Promise((r) => (release = r));
    try {
      const title = box.querySelector<HTMLInputElement>('input[placeholder="Task title"]')!;
      act(() => {
        Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(
          title,
          'Header bug',
        );
        title.dispatchEvent(new Event('input', { bubbles: true }));
      });
      const shot = new File(['x'], 'image.png', { type: 'image/png' });
      act(() => {
        area().dispatchEvent(transfer('paste', [shot]));
      });
      await settle();
      const create = (): HTMLButtonElement =>
        [...box.querySelectorAll('button')].find((b) => b.textContent === 'Create task')!;
      expect(create().disabled).toBe(true);
      act(() => {
        area().dispatchEvent(
          new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }),
        );
        title.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      });
      await settle();
      expect(calls.filter((c) => c.path === '/api/tasks')).toHaveLength(0);

      release();
      await settle();
      expect(create().disabled).toBe(false);
      act(() => create().click());
      await settle();
      const posted = calls.filter((c) => c.path === '/api/tasks');
      expect(posted).toHaveLength(1);
      expect(posted[0]!.body.body).toContain(`attachments/${NAME}`);
    } finally {
      release();
      gate = null;
    }
  });

  it('has an attach button', () => {
    expect(box.querySelector('button[aria-label="Attach an image"]')).not.toBeNull();
    expect(box.querySelector('input[type="file"]')?.getAttribute('accept')).toBe(
      'image/png,image/jpeg,image/webp,image/gif',
    );
  });
});

describe('lightbox', () => {
  it('opens on a click on an attachment; Escape closes it and keeps the dialog', () => {
    const md = document.createElement('div');
    md.className = 'md';
    const thumb = image(`attachments/${NAME}`);
    showImage(thumb);
    md.append(thumb);
    box.append(md);
    act(() => {
      thumb.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const dialog = box.querySelector('[role="dialog"][aria-label="Image"]');
    expect(dialog?.querySelector('img')?.getAttribute('src')).toBe(`ops-att://file/${NAME}`);
    act(() => {
      area().dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true }),
      );
    });
    expect(box.querySelector('[aria-label="Image"]')).toBeNull();
    expect(onClose).not.toHaveBeenCalled();
    // The New task dialog is still open.
    expect(box.querySelector('input[placeholder="Task title"]')).not.toBeNull();
  });
});
