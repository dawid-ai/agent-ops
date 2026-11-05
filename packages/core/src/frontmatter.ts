import YAML from 'yaml';

export interface Doc<T> {
  data: T;
  body: string;
}

/** Splits a Markdown file into YAML frontmatter and body. CRLF input is read as LF. */
export function parseDoc<T = Record<string, unknown>>(text: string): Doc<T> {
  const src = text.replace(/\r\n/g, '\n').replace(/^\uFEFF/, '');
  if (!src.startsWith('---\n')) return { data: {} as T, body: src };
  const end = src.indexOf('\n---', 4);
  if (end < 0) return { data: {} as T, body: src };
  const after = src.indexOf('\n', end + 4);
  const yamlText = src.slice(4, end + 1);
  const body = after < 0 ? '' : src.slice(after + 1).replace(/^\n/, '');
  const data = (YAML.parse(yamlText) ?? {}) as T;
  return { data, body };
}

/** Writes frontmatter and body as one Markdown document with LF line endings. */
export function stringifyDoc(data: object, body = ''): string {
  const clean = Object.fromEntries(
    Object.entries(data).filter(([, v]) => v !== undefined && v !== null && v !== ''),
  );
  const yamlText = YAML.stringify(clean, { lineWidth: 0 });
  const text = body.replace(/\r\n/g, '\n').trim();
  return `---\n${yamlText}---\n${text ? `\n${text}\n` : ''}`;
}
