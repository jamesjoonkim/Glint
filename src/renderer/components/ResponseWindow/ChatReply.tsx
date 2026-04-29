import { useState } from 'react';
import styles from './styles.module.css';

type Props = {
  disabled: boolean;
  onSend: (text: string) => void;
};

export function ChatReply({ disabled, onSend }: Props): JSX.Element {
  const [value, setValue] = useState('');

  const submit = () => {
    const trimmed = value.trim();
    if (!trimmed || disabled) return;
    onSend(trimmed);
    setValue('');
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
      <input
        type="text"
        className={styles.replyInput}
        placeholder={disabled ? 'wait for the answer to finish…' : 'ask a follow-up'}
        value={value}
        onChange={(e) => setValue(e.target.value)}
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
