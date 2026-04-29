import { useEffect, useRef, useState } from 'react';
import styles from './styles.module.css';

type Props = {
  disabled: boolean;
  threadId: string | null;
  streaming: boolean;
  onSend: (text: string) => void;
  onCancel: () => void;
};

type Attachment = {
  id: string;
  dataUrl: string;
  name: string;
};

function readFileAsDataURL(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result ?? ''));
    reader.onerror = () => reject(reader.error ?? new Error('read failed'));
    reader.readAsDataURL(file);
  });
}

let attachmentCounter = 0;
const nextAttachmentId = () => `att-${Date.now()}-${++attachmentCounter}`;

export function ChatReply({
  disabled,
  threadId,
  streaming,
  onSend,
  onCancel,
}: Props): JSX.Element {
  const [value, setValue] = useState('');
  const [attachments, setAttachments] = useState<Attachment[]>([]);
  const [dragging, setDragging] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const ta = textareaRef.current;
    if (!ta) return;
    ta.style.height = '0px';
    ta.style.height = `${ta.scrollHeight}px`;
  }, [value]);

  // Focus the input when the response window mounts so ⌘⇧Z chats land
  // ready-to-type without an extra click.
  useEffect(() => {
    textareaRef.current?.focus();
  }, []);

  const stageFile = async (file: File): Promise<void> => {
    if (!file.type.startsWith('image/')) return;
    try {
      const dataUrl = await readFileAsDataURL(file);
      setAttachments((prev) => [
        ...prev,
        { id: nextAttachmentId(), dataUrl, name: file.name || 'image' },
      ]);
    } catch (err) {
      console.error('attachment read failed', err);
    }
  };

  const removeAttachment = (id: string) => {
    setAttachments((prev) => prev.filter((a) => a.id !== id));
  };

  const submit = async () => {
    const trimmed = value.trim();
    if (disabled || sending) return;
    if (!trimmed && attachments.length === 0) return;
    if (!threadId && attachments.length > 0) return;

    // Snapshot then clear so the user can keep typing while the request
    // flies.
    const text = trimmed;
    const queued = attachments;
    setValue('');
    setAttachments([]);

    if (queued.length === 0) {
      // Text-only path stays on the existing continueThread flow.
      onSend(text);
      return;
    }

    setSending(true);
    try {
      // Multi-image + text → one composed turn. Main saves each image as
      // a capture row, builds a single multimodal vision message with
      // [text, ...image_url(N)], streams ONE assistant response.
      await window.glint?.invoke?.('chat:sendComposed', {
        threadId,
        attachments: queued.map((a) => ({ dataUrl: a.dataUrl })),
        text,
      });
    } catch (err) {
      console.error('chat:sendComposed failed', err);
    } finally {
      setSending(false);
    }
  };

  const onAttachCapture = () => {
    if (!threadId) return;
    void window.glint
      ?.invoke?.('capture:openForThread', { threadId })
      .catch((err) => console.error('capture:openForThread failed', err));
  };

  const onPaste = (e: React.ClipboardEvent<HTMLTextAreaElement>) => {
    if (!threadId) return;
    const items = e.clipboardData?.items;
    if (!items) return;
    let staged = false;
    for (const item of items) {
      if (item.type.startsWith('image/')) {
        const file = item.getAsFile();
        if (!file) continue;
        staged = true;
        void stageFile(file);
      }
    }
    // Only suppress the default paste if we actually intercepted an image —
    // otherwise plain-text paste should pass through.
    if (staged) e.preventDefault();
  };

  const onDragOver = (e: React.DragEvent<HTMLFormElement>) => {
    if (!threadId) return;
    if (!Array.from(e.dataTransfer?.items ?? []).some((i) => i.kind === 'file')) return;
    e.preventDefault();
    setDragging(true);
  };

  const onDragLeave = (e: React.DragEvent<HTMLFormElement>) => {
    if (e.currentTarget.contains(e.relatedTarget as Node | null)) return;
    setDragging(false);
  };

  const onDrop = (e: React.DragEvent<HTMLFormElement>) => {
    e.preventDefault();
    setDragging(false);
    if (!threadId) return;
    for (const file of Array.from(e.dataTransfer?.files ?? [])) {
      if (file.type.startsWith('image/')) void stageFile(file);
    }
  };

  const hasContent = value.trim().length > 0 || attachments.length > 0;
  const sendDisabled = disabled || sending || !hasContent;
  const placeholder = sending
    ? 'sending…'
    : dragging
      ? 'drop image to attach'
      : disabled
        ? 'queue the next message…'
        : 'ask a follow-up · paste or drop an image';

  return (
    <form
      className={styles.replyRow}
      data-disabled={disabled || undefined}
      data-dragging={dragging || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void submit();
      }}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {attachments.length > 0 && (
        <div className={styles.attachmentRow}>
          {attachments.map((att) => (
            <div key={att.id} className={styles.attachmentChip}>
              <img className={styles.attachmentImage} src={att.dataUrl} alt={att.name} />
              <button
                type="button"
                className={styles.attachmentRemove}
                onClick={() => removeAttachment(att.id)}
                aria-label={`remove ${att.name}`}
                title="Remove"
              >
                <svg width="10" height="10" viewBox="0 0 24 24" fill="none" aria-hidden>
                  <path
                    d="M5 5 L19 19 M19 5 L5 19"
                    stroke="currentColor"
                    strokeWidth="2.5"
                    strokeLinecap="round"
                  />
                </svg>
              </button>
            </div>
          ))}
        </div>
      )}
      <div className={styles.replyInputRow}>
        <button
          type="button"
          className={styles.replyAttach}
          onClick={onAttachCapture}
          disabled={!threadId || sending}
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
              // While streaming (disabled=true), Enter is a no-op so the
              // user can draft the next message. Send unlocks once the
              // current stream completes.
              if (disabled) return;
              void submit();
            }
          }}
          onPaste={onPaste}
          // Don't disable during streaming — only during our own image
          // upload IPC roundtrip (sending). The send button is already
          // swapped for stop (via the streaming prop), so accidental
          // sends mid-stream aren't possible.
          disabled={sending}
          aria-label="reply input"
        />
        {streaming ? (
          <button
            type="button"
            className={styles.replyStop}
            onClick={onCancel}
            aria-label="stop generating"
            title="Stop generating"
          >
            <svg width="12" height="12" viewBox="0 0 24 24" fill="currentColor" aria-hidden>
              <rect x="6" y="6" width="12" height="12" rx="2" />
            </svg>
          </button>
        ) : (
          <button
            type="submit"
            className={styles.replySend}
            disabled={sendDisabled}
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
        )}
      </div>
    </form>
  );
}
