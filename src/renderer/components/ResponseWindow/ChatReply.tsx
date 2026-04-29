import { useEffect, useRef, useState } from 'react';
import styles from './styles.module.css';

type Props = {
  disabled: boolean;
  threadId: string | null;
  onSend: (text: string) => void;
};

export function ChatReply({ disabled, threadId, onSend }: Props): JSX.Element {
  const [value, setValue] = useState('');
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  // Auto-grow: reset to 0 then read scrollHeight, clamp to CSS max-height.
  // The clamp itself is handled by `max-height` in CSS — once scrollHeight
  // exceeds that, the textarea begins scrolling internally.
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

  return (
    <form
      className={styles.replyRow}
      data-disabled={disabled || undefined}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
    >
      <button
        type="button"
        className={styles.replyAttach}
        onClick={onAttachCapture}
        disabled={!threadId}
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
        placeholder={disabled ? 'wait for the answer to finish…' : 'ask a follow-up'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          // Enter sends; Shift+Enter inserts a newline.
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
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
