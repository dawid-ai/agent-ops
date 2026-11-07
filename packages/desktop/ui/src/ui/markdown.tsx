import type { CSSProperties, MouseEvent } from 'react';
import { useLayoutEffect, useRef, useState } from 'react';
import { cx } from '../components';
import { highlightHtml, renderInlineMarkdown, renderMarkdown } from '../lib/markdown';
import { useRefTasks } from './refs';

/**
 * Text from an agent or a person, rendered as sanitized Markdown with task references as chips and
 * mentions as pills (lib/markdown.ts). For message bodies; one-line titles stay `RefText`.
 *
 * - `inline`: one line without a paragraph around it, for a heading or a sentence.
 * - `clamp`: in a list, show the first lines only; a click on the text or on **Show more** expands
 *   it, and a second click folds it again. Links, buttons and images keep their own clicks.
 *   `lines` sets how many lines show folded (4 by default).
 * - `words`: search words to mark, as in Activity.
 */
export function Markdown({
  text,
  className,
  inline = false,
  clamp = false,
  lines,
  words,
}: {
  text: string;
  className?: string;
  inline?: boolean;
  clamp?: boolean;
  lines?: number;
  words?: string[];
}) {
  // Chips read the task index as they render: draw again when it changes.
  useRefTasks();
  const html = highlightHtml(
    inline ? renderInlineMarkdown(text) : renderMarkdown(text),
    words ?? [],
  );
  const body = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [over, setOver] = useState(false);

  useLayoutEffect(() => {
    const el = body.current;
    if (!clamp || open || !el) return;
    setOver(el.scrollHeight > el.clientHeight + 1);
  }, [clamp, open, html]);

  if (inline) {
    return (
      <span className={cx('md md-inline', className)} dangerouslySetInnerHTML={{ __html: html }} />
    );
  }
  if (!clamp) {
    return <div className={cx('md', className)} dangerouslySetInnerHTML={{ __html: html }} />;
  }

  const toggle = (e: MouseEvent): void => {
    if ((e.target as Element | null)?.closest?.('a, button, img, input, textarea')) return;
    // Selecting text to copy it is not a click to fold.
    if (window.getSelection?.()?.toString()) return;
    setOpen((o) => !o);
  };
  return (
    <div className={className}>
      <div
        ref={body}
        className={cx('md md-tight', !open && 'md-clamped', !open && over && 'md-faded')}
        data-clamp={open ? 'open' : 'closed'}
        style={lines ? ({ '--md-lines': lines } as CSSProperties) : undefined}
        onClick={toggle}
        dangerouslySetInnerHTML={{ __html: html }}
      />
      {(over || open) && (
        <button
          type="button"
          className="mt-0.5 text-xs text-fg-4 hover:text-signal"
          aria-expanded={open}
          onClick={() => setOpen((o) => !o)}
        >
          {open ? 'Show less' : 'Show more'}
        </button>
      )}
    </div>
  );
}
