import { lstatSync, mkdirSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { OpsError } from './ids.js';
import type { Root } from './root.js';
import { ulid } from './ulid.js';

// Images that tasks, comments and channel posts refer to. Each is one immutable file,
// `<root>/attachments/<ULID>.<ext>`, committed and synced with the root like an event file. Text
// refers to it with a relative Markdown image link, `![alt](attachments/<name>)`, so the same text
// works in the desktop app, in `ops show` and in a git host's Markdown view.

/** The largest image a root stores. The desktop app downscales big screenshots below it. */
export const MAX_ATTACHMENT_BYTES = 5 * 1024 * 1024;

/** File extension to MIME type, for the image types attachments accept. */
export const ATTACHMENT_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  gif: 'image/gif',
};

/** An attachment file name: a ULID and one of the accepted extensions. */
export const ATTACHMENT_NAME_RE = /^[0-9A-HJKMNP-TV-Z]{26}\.(png|jpg|webp|gif)$/;

/** `attachments/<name>` in Markdown text, with or without a leading `./`. */
const REF_RE =
  /(?:^|[\s("'<[])(?:\.\/)?attachments\/([0-9A-HJKMNP-TV-Z]{26}\.(?:png|jpg|webp|gif))\b/g;

export interface Attachment {
  /** `<ULID>.<ext>`. */
  name: string;
  /** The root that holds it. */
  root: string;
  /** Absolute path of the file. */
  file: string;
  /** The path relative to the root, as text refers to it: `attachments/<name>`. */
  ref: string;
  /** A Markdown image link to paste into text. */
  markdown: string;
  type: string;
  bytes: number;
}

/**
 * The image type of `buf` from its first bytes, as a file extension, or null when it is none of
 * the accepted types. The content decides, never a file name or a type the sender claims.
 */
export function sniffImage(buf: Uint8Array): string | null {
  const at = (i: number, bytes: number[]): boolean => bytes.every((b, j) => buf[i + j] === b);
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'png';
  if (at(0, [0xff, 0xd8, 0xff])) return 'jpg';
  if (at(0, [0x47, 0x49, 0x46, 0x38]) && (buf[4] === 0x37 || buf[4] === 0x39) && buf[5] === 0x61)
    return 'gif';
  if (at(0, [0x52, 0x49, 0x46, 0x46]) && at(8, [0x57, 0x45, 0x42, 0x50])) return 'webp';
  return null;
}

/** The folder of a root's attachments. */
export function attachmentsDir(root: Root): string {
  return join(root.dir, 'attachments');
}

/** Checks and stores an image in `root`; refuses other types and files over the size cap. */
export function saveAttachment(
  root: Root,
  data: Uint8Array,
  opts: { alt?: string; now?: number } = {},
): Attachment {
  if (data.length === 0) throw new OpsError('the attachment is empty', 2);
  if (data.length > MAX_ATTACHMENT_BYTES) {
    throw new OpsError(
      `the image is ${mb(data.length)}; attachments may be ${mb(MAX_ATTACHMENT_BYTES)} at most`,
      2,
    );
  }
  const ext = sniffImage(data);
  if (!ext) throw new OpsError('not a PNG, JPEG, WebP or GIF image', 2);
  const name = `${ulid(opts.now)}.${ext}`;
  const dir = attachmentsDir(root);
  mkdirSync(dir, { recursive: true });
  // A linked `attachments` folder would write the image outside the root.
  if (!insideRoot(root, dir)) {
    throw new OpsError(`${dir} leads outside the root; attachments must live inside it`, 1);
  }
  const file = join(dir, name);
  root.writeAtomic(file, data);
  return describe(root, name, file, data.length, opts.alt);
}

/**
 * Finds an attachment by name in any of `roots`, or null. Never resolves other paths: the file
 * must be a regular file, not a link, and its real path must stay inside the root, so a linked
 * `attachments` folder or file never serves something from elsewhere on the machine.
 */
export function findAttachment(roots: Root[], name: string): Attachment | null {
  if (!ATTACHMENT_NAME_RE.test(name)) return null;
  for (const root of roots) {
    const file = join(attachmentsDir(root), name);
    const st = lstatSync(file, { throwIfNoEntry: false });
    if (st?.isFile() && insideRoot(root, file)) return describe(root, name, file, st.size);
  }
  return null;
}

/** Whether the real path of `path` (after every link) is inside the real path of the root. */
function insideRoot(root: Root, path: string): boolean {
  try {
    const rel = relative(realpathSync(root.dir), realpathSync(path));
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel);
  } catch {
    return false;
  }
}

/** Attachment names that `text` refers to, in order of first mention, without repeats. */
export function attachmentRefs(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(REF_RE)) names.add(m[1]!);
  return [...names];
}

function describe(root: Root, name: string, file: string, bytes: number, alt?: string): Attachment {
  const ext = name.slice(name.lastIndexOf('.') + 1);
  const ref = `attachments/${name}`;
  const label =
    (alt ?? 'image')
      .replace(/[[\]\\]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 80) || 'image';
  return {
    name,
    root: root.name,
    file,
    ref,
    markdown: `![${label}](${ref})`,
    type: ATTACHMENT_TYPES[ext]!,
    bytes,
  };
}

function mb(n: number): string {
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}
