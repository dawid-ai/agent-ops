// @vitest-environment jsdom
// AO-0143: agent text rendered as Markdown is sanitized. Under jsdom, because DOMPurify checks only
// the first element under happy-dom (see markdown-text.test.ts); Chromium behaves as jsdom does.
import { describe, expect, it } from 'vitest';
import { highlightHtml, renderInlineMarkdown, renderMarkdown } from '../ui/src/lib/markdown';

function dom(html: string): HTMLDivElement {
  const el = document.createElement('div');
  el.innerHTML = html;
  return el;
}

describe('rendered Markdown', () => {
  it('keeps headings, lists and code, with task references as chips', () => {
    const el = dom(renderMarkdown('## Done\n\n- parser in `core/fold.ts`\n- see AO-0014'));
    expect(el.querySelector('h2')?.textContent).toBe('Done');
    expect(el.querySelectorAll('li')).toHaveLength(2);
    expect(el.querySelector('code')?.textContent).toBe('core/fold.ts');
    expect(el.querySelector('a[data-task-ref="AO-0014"]')).not.toBeNull();
  });

  it('drops scripts, event handlers and script links from agent text', () => {
    const html = renderMarkdown(
      '# Hi\n\n<script>alert(1)</script><img src=x onerror="alert(2)">\n\n' +
        '[x](javascript:alert(3)) <b onclick="alert(4)">b</b> <iframe src="https://e.com"></iframe>',
    );
    expect(html).toContain('<h1>Hi</h1>');
    expect(html).not.toMatch(/<script|onerror|onclick|javascript:|<iframe/i);
    // A link keeps working, and opens outside the app.
    const link = dom(renderMarkdown('[docs](https://e.com/docs)')).querySelector('a')!;
    expect(link.getAttribute('href')).toBe('https://e.com/docs');
    expect(link.getAttribute('target')).toBe('_blank');
  });

  it('sanitizes inline Markdown the same way, without a paragraph around it', () => {
    const html = renderInlineMarkdown('Use `ops sync` for AO-0014? <img src=x onerror="alert(1)">');
    expect(html).not.toContain('<p>');
    expect(html).toContain('<code>ops sync</code>');
    expect(html).toContain('data-task-ref="AO-0014"');
    expect(html).not.toMatch(/onerror/i);
  });

  it('marks search words in text only, never in tags or attributes', () => {
    const html = highlightHtml(renderMarkdown('A [code link](https://e.com/code) and `code`'), [
      'code',
    ]);
    const el = dom(html);
    expect(el.querySelector('a')!.getAttribute('href')).toBe('https://e.com/code');
    expect([...el.querySelectorAll('mark')].map((m) => m.textContent)).toEqual(['code', 'code']);
    expect(highlightHtml('<p>x</p>', [])).toBe('<p>x</p>');
  });

  it('marks words without turning marked text into markup', () => {
    const html = highlightHtml(renderMarkdown('a &lt;b&gt; tag'), ['b']);
    expect(html).not.toContain('<b>');
    expect(dom(html).querySelector('mark')?.textContent).toBe('b');
  });
});
