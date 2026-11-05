// Attached images: `![alt](attachments/<name>)` in task text, comments and channel posts. The page
// loads them from `ops-att://file/<name>`, which the main process serves from the data roots
// through opsd. No other image source renders (see renderMarkdown and the page's CSP).

/** The largest image opsd stores (MAX_ATTACHMENT_BYTES in core). */
export const MAX_BYTES = 5 * 1024 * 1024;
/** Bigger images are downscaled before upload, so a large screenshot fits well under the cap. */
export const UPLOAD_TARGET_BYTES = 2 * 1024 * 1024;
/** The longest side a downscaled image keeps. */
export const MAX_SIDE = 2560;
export const ACCEPT = 'image/png,image/jpeg,image/webp,image/gif';

const NAME = '[0-9A-HJKMNP-TV-Z]{26}\\.(?:png|jpg|webp|gif)';
const REF_RE = new RegExp(`^(?:\\./)?attachments/(${NAME})$`);
const URL_RE = new RegExp(`^ops-att://file/(${NAME})$`);

/** The attachment name an image `src` in Markdown refers to, or null for any other source. */
export function attachmentRef(src: string): string | null {
  return REF_RE.exec(src.trim())?.[1] ?? URL_RE.exec(src.trim())?.[1] ?? null;
}

/** The URL the page loads an attachment from. */
export function attachmentUrl(name: string): string {
  return `ops-att://file/${name}`;
}

/** Image files among pasted or dropped items, in order. */
export function imageFiles(list: FileList | File[] | null | undefined): File[] {
  return Array.from(list ?? []).filter((f) => ACCEPT.split(',').includes(f.type));
}

/**
 * The size to draw an image at so its longest side is at most `max`; unchanged when it already
 * fits.
 */
export function fitWithin(w: number, h: number, max = MAX_SIDE): { w: number; h: number } {
  const side = Math.max(w, h);
  if (side <= max) return { w, h };
  const k = max / side;
  return { w: Math.max(1, Math.round(w * k)), h: Math.max(1, Math.round(h * k)) };
}

/**
 * Text with `insert` placed at `[start, end)`, on its own line when the caret sits inside a line,
 * and the caret position after it.
 */
export function insertAt(
  text: string,
  start: number,
  end: number,
  insert: string,
): { text: string; caret: number } {
  const before = text.slice(0, start);
  const after = text.slice(end);
  const lead = before && !before.endsWith('\n') ? '\n' : '';
  const tail = after.startsWith('\n') ? '' : '\n';
  const piece = `${lead}${insert}${tail}`;
  return { text: before + piece + after, caret: before.length + piece.length };
}

/**
 * The bytes to upload: the file itself when it is small enough, else a downscaled WebP (PNG
 * screenshots shrink most this way; text stays readable at 2560 px). GIFs are never redrawn, so
 * they keep their animation; a GIF over the cap is refused.
 */
export async function prepareImage(file: File): Promise<Blob> {
  if (file.type === 'image/gif' || file.size <= UPLOAD_TARGET_BYTES) {
    if (file.size > MAX_BYTES) throw new Error(`${file.name || 'The image'} is over 5 MB`);
    return file;
  }
  const bitmap = await createImageBitmap(file);
  try {
    let quality = 0.9;
    let size = fitWithin(bitmap.width, bitmap.height);
    for (let attempt = 0; attempt < 5; attempt++) {
      const canvas = document.createElement('canvas');
      canvas.width = size.w;
      canvas.height = size.h;
      canvas.getContext('2d')!.drawImage(bitmap, 0, 0, size.w, size.h);
      const blob = await new Promise<Blob | null>((done) =>
        canvas.toBlob(done, 'image/webp', quality),
      );
      if (!blob) break;
      if (blob.size <= MAX_BYTES && (blob.size <= UPLOAD_TARGET_BYTES || attempt === 4)) {
        return blob;
      }
      quality = Math.max(0.6, quality - 0.1);
      size = fitWithin(size.w, size.h, Math.round(Math.max(size.w, size.h) * 0.8));
    }
  } finally {
    bitmap.close();
  }
  if (file.size <= MAX_BYTES) return file;
  throw new Error(`${file.name || 'The image'} is over 5 MB and could not be made smaller`);
}

/** Base64 of a blob, without the `data:` prefix. */
export async function toBase64(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(bin);
}

/** The alt text for a file: its name without the extension, or `image` for a pasted one. */
export function altFor(file: File): string {
  const base = file.name.replace(/\.[^.]+$/, '').trim();
  // Pasted screenshots arrive as `image.png`.
  return base && base !== 'image' ? base : 'image';
}
