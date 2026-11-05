import { ImagePlus, Loader2, X } from 'lucide-react';
import type { ClipboardEvent, DragEvent } from 'react';
import { useEffect, useRef, useState } from 'react';
import { api } from '../api';
import { cx } from '../components';
import {
  ACCEPT,
  altFor,
  attachmentUrl,
  imageFiles,
  prepareImage,
  toBase64,
} from '../lib/attachments';

/** Where an upload goes: the task's root for a comment or answer, else the default root. */
export interface AttachTarget {
  task?: string;
}

interface Uploaded {
  name: string;
  markdown: string;
}

/** Uploads images and hands each Markdown link to `insert`, in order. */
export function useAttach(target: AttachTarget | undefined, insert: (markdown: string) => void) {
  const [busy, setBusy] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const insertRef = useRef(insert);
  insertRef.current = insert;
  const upload = async (files: File[]): Promise<void> => {
    if (!target || files.length === 0) return;
    setError(null);
    setBusy((n) => n + files.length);
    for (const file of files) {
      try {
        const blob = await prepareImage(file);
        const a = await api<Uploaded>('POST', '/api/attachments', {
          data: await toBase64(blob),
          task: target.task,
          alt: altFor(file),
        });
        insertRef.current(a.markdown);
      } catch (err) {
        setError((err as Error).message);
      } finally {
        setBusy((n) => n - 1);
      }
    }
  };
  return {
    enabled: Boolean(target),
    busy: busy > 0,
    error,
    clearError: () => setError(null),
    upload: (files: File[]) => void upload(files),
    /** Paste: images on the clipboard upload; text pastes as usual. */
    onPaste: (e: ClipboardEvent<HTMLTextAreaElement>): void => {
      if (!target) return;
      const files = imageFiles(e.clipboardData.files);
      if (files.length === 0) return;
      e.preventDefault();
      void upload(files);
    },
    onDragOver: (e: DragEvent<HTMLElement>): void => {
      if (!target || !Array.from(e.dataTransfer.types).includes('Files')) return;
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
    },
    onDrop: (e: DragEvent<HTMLElement>): void => {
      if (!target) return;
      const files = imageFiles(e.dataTransfer.files);
      if (files.length === 0) return;
      e.preventDefault();
      void upload(files);
    },
  };
}

/** The paperclip button: picks image files from disk. */
export function AttachButton({
  busy,
  onFiles,
}: {
  busy: boolean;
  onFiles: (files: File[]) => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  return (
    <>
      <button
        type="button"
        title="Attach an image (or paste or drop one)"
        aria-label="Attach an image"
        onClick={() => input.current?.click()}
        className={cx(
          'absolute top-1.5 right-1.5 rounded-md p-1 text-fg-4 transition hover:bg-white/8 hover:text-fg',
          busy && 'text-signal',
        )}
      >
        {busy ? <Loader2 size={15} className="animate-spin" /> : <ImagePlus size={15} />}
      </button>
      <input
        ref={input}
        type="file"
        accept={ACCEPT}
        multiple
        hidden
        onChange={(e) => {
          onFiles(imageFiles(e.target.files));
          e.target.value = '';
        }}
      />
    </>
  );
}

/**
 * Shows an attached image full size when one in rendered Markdown is clicked. Escape, a click
 * anywhere and the close button close it, without closing a dialog underneath.
 */
export function Lightbox() {
  const [name, setName] = useState<string | null>(null);
  useEffect(() => {
    const click = (e: MouseEvent): void => {
      const img = (e.target as Element | null)?.closest?.('img[data-attachment]');
      if (!img) return;
      e.preventDefault();
      e.stopPropagation();
      setName(img.getAttribute('data-attachment'));
    };
    document.addEventListener('click', click, true);
    return () => document.removeEventListener('click', click, true);
  }, []);
  useEffect(() => {
    if (!name) return;
    const key = (e: KeyboardEvent): void => {
      if (e.key !== 'Escape') return;
      e.preventDefault();
      e.stopImmediatePropagation();
      setName(null);
    };
    // Capture on window runs before the dialogs' own Escape handlers.
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [name]);
  if (!name) return null;
  return (
    <div
      role="dialog"
      aria-label="Image"
      className="animate-fade fixed inset-0 z-[60] flex cursor-zoom-out items-center justify-center bg-black/85 p-8"
      // Closes on click, not mousedown, so the click never lands on what is underneath.
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => {
        e.stopPropagation();
        setName(null);
      }}
    >
      <img
        src={attachmentUrl(name)}
        alt=""
        className="max-h-full max-w-full rounded-lg object-contain shadow-2xl"
      />
      <button
        type="button"
        aria-label="Close"
        className="absolute top-4 right-4 rounded-md p-1.5 text-fg-2 hover:bg-white/10 hover:text-fg"
      >
        <X size={20} />
      </button>
    </div>
  );
}
