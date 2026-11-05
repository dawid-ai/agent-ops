import DOMPurify from 'dompurify';
import { marked } from 'marked';
import { attachmentRef, attachmentUrl } from './attachments';
import { markMentions, statusInfo } from './identity';
import { markTaskRefs } from './refs';

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
  const clean = DOMPurify.sanitize(marked.parse(text, { async: false, gfm: true, breaks: true }), {
    ADD_ATTR: ['target'],
  });
  return markTaskRefs(markMentions(clean), statusInfo);
}
