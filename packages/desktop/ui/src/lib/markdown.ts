import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { attachmentRef, attachmentUrl } from './attachments';
import { markMentions, statusInfo } from './identity';
import { markTaskRefs } from './refs';
import { highlightParts } from './search';

// Links open in the browser: target=_blank goes through the main process's window-open handler,
// which opens http and https links externally and denies everything else.
// Images render only when they are attachments from the data roots: the source becomes the
// `ops-att:` URL the main process serves. Any other source (a remote URL, a local file) is dropped,
// so text from an agent can never make the app fetch something.
DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') showImage(node);
});

/** Points an `<img>` at its attachment, or strips its source when it is not one. */
export function showImage(img: Element): void {
  const name = attachmentRef(img.getAttribute('src') ?? '');
  for (const a of ['src', 'srcset', 'sizes', 'width', 'height']) img.removeAttribute(a);
  if (name) {
    img.setAttribute('src', attachmentUrl(name));
    img.setAttribute('data-attachment', name);
    img.setAttribute('loading', 'lazy');
    img.setAttribute('class', 'attachment');
  } else {
    img.setAttribute('class', 'attachment-blocked');
    img.setAttribute('title', 'Only attached images show here');
  }
}

/**
 * Markdown to sanitized HTML. Task text comes from agents, so it is never trusted as HTML. Mention
 * pills and task links are added after sanitizing; they are built only from the id characters
 * their patterns allow.
 */
export function renderMarkdown(text: string): string {
  return finish(marked.parse(text, { async: false, gfm: true, breaks: true }));
}

/**
 * One line of Markdown (code, emphasis, links) to sanitized HTML without a paragraph around it,
 * for text that sits in a heading or a sentence, such as a decision question.
 */
export function renderInlineMarkdown(text: string): string {
  return finish(marked.parseInline(text, { async: false, gfm: true, breaks: true }));
}

function finish(html: string): string {
  const clean = DOMPurify.sanitize(html, { ADD_ATTR: ['target'] });
  return markTaskRefs(markMentions(clean), statusInfo);
}

/**
 * Rendered HTML with the search words marked in its text, never inside tags or attributes. Runs
 * on sanitized output, and adds only `<mark>` elements around text the page already shows.
 */
export function highlightHtml(html: string, words: string[]): string {
  if (!words.some(Boolean) || !html) return html;
  const box = document.createElement('template');
  box.innerHTML = html;
  const walker = document.createTreeWalker(box.content, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
  for (const t of texts) {
    const parts = highlightParts(t.data, words);
    if (!parts.some((p) => p.hit)) continue;
    const frag = document.createDocumentFragment();
    for (const p of parts) {
      if (!p.hit) {
        frag.append(p.text);
        continue;
      }
      const mark = document.createElement('mark');
      mark.className = 'rounded-sm bg-signal/25 px-0.5 text-fg';
      mark.textContent = p.text;
      frag.append(mark);
    }
    t.replaceWith(frag);
  }
  return box.innerHTML;
}
