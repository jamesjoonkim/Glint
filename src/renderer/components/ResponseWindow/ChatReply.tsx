import { useEffect, useRef, useState } from 'react';
import styles from './styles.module.css';

type Props = {
  disabled: boolean;
  threadId: string | null;
  onSend: (text: string) => void;
};

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

export function ChatReply({ disabled, threadId, onSend }: Props): JSX.Element {
  const [value, setValue] = useState('');
  const [dragging, setDragging] = useState(false);
  const [attaching, setAttaching] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: reset to 0 then read scrollHeight, clamp to CSS max-height.
  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
  };

  const onAttachCapture = () => {
    if (!threadId) return;
    void window.glint
      ?.invoke?.('capture:openForThread', { threadId })
      .catch((err) => console.error('capture:openForThread failed', err));
  };

  const attachFile = async (file: File): Promise<void> => {
    if (!threadId) return;
    if (!file.type.startsWith('image/')) return;
    setAttaching(true);
    try {
      const dataUrl = await readFileAsDataURL(file);
      await window.glint?.invoke?.('capture:attachImage', { threadId, dataUrl });
    } catch (err) {
      console.error('capture:attachImage failed', err);
    } finally {
      setAttaching(false);
    }
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!threadId) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        // Block the default paste so the data-URL doesn't dump as text into
        // the textarea.
        e.preventDefault();
        void attachFile(file);
        return;
      }
    }
  };

  const onDragOver = (e: React.DragEvent<HTMLFormElement>) => {
    if (!threadId) return;
    if (!Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file')) return;
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLFormElement>) => {
    // Only clear when leaving the form entirely, not when crossing into a
    // child element (which fires dragleave on the parent).
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  const onDrop = (e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragging(false);
    if (!threadId) return;
    const file = Array.from(e.dataTransfer?.files ?? []).find((f) =>
      f.type.startsWith('image/'),
    );
    if (!file) return;
    void attachFile(file);
  };

  const placeholder = attaching
    ? 'attaching image…'
    : dragging
      ? 'drop image to attach'
      : disabled
        ? 'wait for the answer to finish…'
        : 'ask a follow-up · paste or drop an image';

  return (
    <form
      className={styles.replyRow}
      data-disabled={disabled || undefined}
      data-dragging={dragging || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <button
        type="button"
        className={styles.replyAttach}
        onClick={onAttachCapture}
        disabled={!threadId || attaching}
        aria-label="capture screenshot into this chat"
        title="Capture screenshot into this chat"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M12 5 V19 M5 12 H19"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
          />
        </svg>
      </button>
      <textarea
        ref={textareaRef}
        rows={1}
        className={styles.replyInput}
        placeholder={placeholder}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
        onPaste={onPaste}
        disabled={disabled}
        aria-label="reply input"
      />
      <button
        type="submit"
        className={styles.replySend}
        disabled={disabled || !value.trim()}
        aria-label="send reply"
      >
        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden>
          <path
            d="M4 12 L20 12 M14 6 L20 12 L14 18"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </form>
  );
}
