import { existsSync, mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import YAML from 'yaml';
import { parseDoc, stringifyDoc } from './frontmatter.js';
import { actorSlug, OpsError } from './ids.js';
import type { Root } from './root.js';
import { ulid } from './ulid.js';

export const CHANNEL_RE = /^[a-z0-9][a-z0-9-]{0,39}$/;
// `@claude:qa`, `@claude:*` and `@*:qa`; `@*:*` names nobody in particular and stays text.
const MENTION_RE =
  /(?:^|[^\w@])@((?:[a-z][a-z0-9]*:(?:[a-z][a-z0-9-]*[a-z0-9]|[a-z]|\*))|(?:\*:(?:[a-z][a-z0-9-]*[a-z0-9]|[a-z])))/g;

/** One message file: `channels/<name>/<ulid>-<actor>.md`. */
export interface ChannelMessage {
  id: string;
  channel: string;
  actor: string;
  at: string;
  /** Actor ids or runtime wildcards named with `@` in the text or with `--to`. */
  mentions?: string[];
  /** A task the message is about. */
  task?: string;
  body: string;
}

export interface ChannelInfo {
  name: string;
  messages: number;
  last: string | null;
  /** What the channel is for, from `channel.yml`. */
  description?: string;
}

/** `channels/<name>/channel.yml`: written when a channel is created before its first message. */
export interface ChannelMeta {
  description?: string;
  created_by: string;
  created_at: string;
}

/** Creates a channel with a description; an existing channel keeps its messages and gains it. */
export function createChannel(root: Root, channel: string, meta: ChannelMeta): ChannelInfo {
  const name = assertChannel(channel);
  const dir = join(root.dir, 'channels', name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, 'channel.yml');
  if (!existsSync(file)) {
    const clean = Object.fromEntries(Object.entries(meta).filter(([, v]) => v !== undefined));
    root.writeAtomic(file, YAML.stringify(clean));
  }
  return listChannels(root).find((c) => c.name === name)!;
}

function channelMeta(root: Root, name: string): ChannelMeta | null {
  const file = join(root.dir, 'channels', name, 'channel.yml');
  if (!existsSync(file)) return null;
  try {
    return (YAML.parse(readFileSync(file, 'utf8')) ?? null) as ChannelMeta | null;
  } catch {
    return null;
  }
}

export function assertChannel(name: string): string {
  const n = name.replace(/^#/, '').toLowerCase();
  if (!CHANNEL_RE.test(n)) {
    throw new OpsError(`bad channel name '${name}': use lowercase letters, digits and hyphens`, 2);
  }
  return n;
}

/** Actor ids written as `@claude:qa`, `@human:dawid`, `@codex:*` or `@*:qa` in the text. */
export function findMentions(text: string): string[] {
  const out = new Set<string>();
  for (const m of text.matchAll(MENTION_RE)) out.add(m[1]!);
  return [...out];
}

export function postMessage(
  root: Root,
  channel: string,
  msg: Omit<ChannelMessage, 'id' | 'channel'>,
  atMs: number,
): ChannelMessage {
  const name = assertChannel(channel);
  const dir = join(root.dir, 'channels', name);
  mkdirSync(dir, { recursive: true });
  const id = ulid(atMs);
  const { body, ...front } = msg;
  root.writeAtomic(join(dir, `${id}-${actorSlug(msg.actor)}.md`), stringifyDoc(front, body));
  return { ...msg, id, channel: name };
}

/** Message file names in a channel newer than `after` (a ULID), oldest first. */
export function messageFiles(root: Root, name: string, after = ''): string[] {
  const dir = join(root.dir, 'channels', name);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.md') && f.length > 27 && f.slice(0, 26) > after)
    .sort();
}

/** Reads one message file of a channel. Message files are never edited after they are written. */
export function readMessage(root: Root, name: string, file: string): ChannelMessage {
  const doc = parseDoc<Omit<ChannelMessage, 'id' | 'channel' | 'body'>>(
    readFileSync(join(root.dir, 'channels', name, file), 'utf8'),
  );
  return { ...doc.data, id: file.slice(0, 26), channel: name, body: doc.body.trim() };
}

/** Messages in a channel, oldest first; `after` skips messages up to that ULID. */
export function readChannel(
  root: Root,
  channel: string,
  opts: { after?: string; limit?: number } = {},
): ChannelMessage[] {
  const name = assertChannel(channel);
  let files = messageFiles(root, name, opts.after);
  if (opts.limit !== undefined) files = files.slice(-opts.limit);
  return files.map((f) => readMessage(root, name, f));
}

/** Channel folder names in a root. */
export function channelNames(root: Root): string[] {
  const dir = join(root.dir, 'channels');
  if (!existsSync(dir)) return [];
  return readdirSync(dir, { withFileTypes: true })
    .filter((d) => d.isDirectory() && CHANNEL_RE.test(d.name))
    .map((d) => d.name);
}

export function listChannels(root: Root): ChannelInfo[] {
  return channelNames(root).map((name) => {
    const files = messageFiles(root, name);
    const last = files.at(-1);
    const description = channelMeta(root, name)?.description;
    return {
      name,
      messages: files.length,
      last: last ? last.slice(0, 26) : null,
      ...(description ? { description } : {}),
    };
  });
}

/** Messages in every channel newer than `after`; reads only files whose ULID is newer. */
export function messagesSince(root: Root, after: string): ChannelMessage[] {
  return channelNames(root).flatMap((name) =>
    messageFiles(root, name, after).map((f) => readMessage(root, name, f)),
  );
}
