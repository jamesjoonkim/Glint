import { Streamdown } from 'streamdown';
import remarkMath from 'remark-math';
import remarkGfm from 'remark-gfm';
import rehypeKatex from 'rehype-katex';
import 'katex/dist/katex.min.css';
import styles from './styles.module.css';

type Props = {
  source: string;
  isStreaming?: boolean;
};

/**
 * `\text{___}` (consecutive underscores inside \text) trips markdown emphasis
 * detection — replace with `\underline{\hspace{...}}` so KaTeX still renders
 * a blank line and markdown stops eating the underscores. Currency `$80...`
 * is intentionally NOT escaped: the model writes math-heavy responses where
 * a leading `$` is almost always a math delimiter.
 *
 * Qwen3-VL also habitually emits `\( inline \)` / `\[ display \]` LaTeX-
 * canonical delimiters which remark-math 6.x doesn't recognize (it only
 * parses `$...$` / `$$...$$`). These two forms are unambiguous (the escape
 * gives them away) so swapping to dollars is safe.
 */
function fixMathMarkdownConflicts(content: string): string {
  return content
    .replace(/\\\[([\s\S]+?)\\\]/g, (_m, body) => `$$${body}$$`)
    .replace(/\\\(([\s\S]+?)\\\)/g, (_m, body) => `$${body}$`)
    .replace(/\\text\{(_+)\}/g, '\\underline{\\hspace{2em}}');
}

// Streamdown + remark-math + rehype-katex is the canonical pipeline for
// streaming markdown with LaTeX. `singleDollarTextMath: true` enables
// `$inline$` (off by default in remark-math). `parseIncompleteMarkdown` is
// only true while tokens arrive — flipping it off when done removes the
// "incomplete-link" debug markers in the rendered output.
export function MarkdownView({ source, isStreaming = false }: Props): JSX.Element {
  const cleaned = fixMathMarkdownConflicts(source || '');
  return (
    <div className={styles.md}>
      <Streamdown
        parseIncompleteMarkdown={isStreaming}
        remarkPlugins={[[remarkMath, { singleDollarTextMath: true }], remarkGfm]}
        rehypePlugins={[rehypeKatex]}
        controls={false}
      >
        {cleaned}
      </Streamdown>
    </div>
  );
}
