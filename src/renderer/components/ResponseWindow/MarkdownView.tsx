import { Streamdown } from 'streamdown';
import 'katex/dist/katex.min.css';
import styles from './styles.module.css';

type Props = { source: string };

// Streamdown handles partial-stream markdown gracefully (LaTeX delimiters,
// unclosed code fences, half-written tables). Keeps math + GFM tables intact
// while tokens are still arriving.
export function MarkdownView({ source }: Props): JSX.Element {
  return (
    <div className={styles.md}>
      <Streamdown parseIncompleteMarkdown>{source || ''}</Streamdown>
    </div>
  );
}
