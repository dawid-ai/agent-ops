import {
  closeSync,
  existsSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
} from 'node:fs';
import { join } from 'node:path';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { OpsError } from './ids.js';
import type { Root } from './root.js';
import { slugify } from './units.js';

/** Frontmatter of `kb/<topic>/<slug>.md`. */
export interface KbMeta {
  title: string;
  topic: string;
  author: string;
  created_at: string;
  /** The task the lesson came from. */
  task?: string;
  tags?: string[];
}

export interface KbNote extends KbMeta {
  root: string;
  slug: string;
  /** `<topic>/<slug>`, the note's id. */
  ref: string;
  file: string;
  body: string;
}

export interface KbHit {
  note: KbNote;
  score: number;
}

/** Checks a topic name and returns its canonical form. */
export function kbTopic(topic: string): string {
  const t = slugify(topic, 40);
  if (!t) throw new OpsError(`bad topic '${topic}': use letters, digits and hyphens`, 2);
  return t;
}

/** Writes a new learn note. A title that is taken gets a numbered slug. */
export function writeNote(root: Root, meta: KbMeta, body: string): KbNote {
  const topic = kbTopic(meta.topic);
  const base = slugify(meta.title) || 'note';
  const kb = join(root.dir, 'kb');
  const dir = join(kb, topic);
  // Check each level before creating anything in it, so nothing lands behind a link.
  const ensure = (path: string, name: string): void => {
    if (!existsSync(path)) mkdirSync(path);
    if (!plain(path, 'dir')) {
      throw new OpsError(`${name} is a link; learn notes go in a real folder`, 2);
    }
  };
  ensure(kb, 'kb');
  ensure(dir, `kb/${topic}`);
  for (let i = 1; ; i++) {
    const slug = i === 1 ? base : `${base}-${i}`;
    const file = join(dir, `${slug}.md`);
    try {
      // Reserve the name first, so two writers never pick the same slug.
      closeSync(openSync(file, 'wx'));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'EEXIST') continue;
      throw err;
    }
    const full: KbMeta = { ...meta, topic };
    root.writeAtomic(file, stringifyDoc(full, body));
    return { ...full, root: root.name, slug, ref: `${topic}/${slug}`, file, body: body.trim() };
  }
}

/** True for a real folder or file, never a link: links in a synced repo could point anywhere. */
function plain(path: string, kind: 'dir' | 'file'): boolean {
  try {
    const s = lstatSync(path);
    return kind === 'dir' ? s.isDirectory() : s.isFile();
  } catch {
    return false;
  }
}

/** One note file found by `noteFiles`. */
export interface NoteFile {
  topic: string;
  slug: string;
  file: string;
}

/** Note files in the root's `kb/` folder, or in one topic. Symlinks and junctions are skipped. */
export function noteFiles(root: Root, topic?: string): NoteFile[] {
  const kb = join(root.dir, 'kb');
  if (!plain(kb, 'dir')) return [];
  const topics = topic
    ? [kbTopic(topic)]
    : readdirSync(kb, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name);
  const out: NoteFile[] = [];
  for (const t of topics) {
    const dir = join(kb, t);
    if (!plain(dir, 'dir')) continue;
    for (const name of readdirSync(dir)) {
      if (!name.endsWith('.md')) continue;
      const file = join(dir, name);
      if (plain(file, 'file')) out.push({ topic: t, slug: name.slice(0, -3), file });
    }
  }
  return out;
}

/** Reads one note file found by `noteFiles`. */
export function readNote(root: Root, f: NoteFile): KbNote {
  const doc = parseDoc<Partial<KbMeta>>(readFileSync(f.file, 'utf8'));
  return {
    title: doc.data.title ?? f.slug,
    topic: f.topic,
    author: doc.data.author ?? '',
    created_at: doc.data.created_at ?? '',
    task: doc.data.task,
    tags: doc.data.tags,
    root: root.name,
    slug: f.slug,
    ref: `${f.topic}/${f.slug}`,
    file: f.file,
    body: doc.body.trim(),
  };
}

/** Every note in the root's `kb/` folder, or in one topic. Symlinks and junctions are skipped. */
export function readNotes(root: Root, topic?: string): KbNote[] {
  return noteFiles(root, topic).map((f) => readNote(root, f));
}

/**
 * Ranks notes that contain every word (case-insensitive) in the title, tags, topic or body. A hit
 * in the title or tags counts more than one in the body. No words lists every note, newest first.
 */
export function searchNotes(notes: KbNote[], words: string[]): KbHit[] {
  const terms = words.map((w) => w.toLowerCase()).filter(Boolean);
  const hits: KbHit[] = [];
  for (const note of notes) {
    const head = `${note.title} ${(note.tags ?? []).join(' ')} ${note.topic}`.toLowerCase();
    const body = note.body.toLowerCase();
    let score = 0;
    let all = true;
    for (const t of terms) {
      const inHead = head.includes(t);
      const bodyCount = body.split(t).length - 1;
      if (!inHead && bodyCount === 0) {
        all = false;
        break;
      }
      score += (inHead ? 5 : 0) + Math.min(bodyCount, 5);
    }
    if (all) hits.push({ note, score });
  }
  return hits.sort((a, b) => b.score - a.score || (a.note.created_at < b.note.created_at ? 1 : -1));
}
