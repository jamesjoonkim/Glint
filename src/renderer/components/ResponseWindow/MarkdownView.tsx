import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import rehypeSanitize, { defaultSchema } from 'rehype-sanitize';
import styles from './styles.module.css';

// Tighten the default rehype-sanitize schema: drop anything that could
// execute or load remote resources. The LLM stream is hostile by default.
const schema = {
  ...defaultSchema,
  tagNames: (defaultSchema.tagNames ?? []).filter(
    (t) => !['img', 'iframe', 'video', 'audio', 'object', 'embed', 'svg', 'script', 'style'].includes(t),
  ),
  attributes: {
    ...defaultSchema.attributes,
    a: [['href'], ['title'], ['rel'], ['target']],
  },
  protocols: { ...defaultSchema.protocols, href: ['http', 'https', 'mailto'] },
};

type Props = { source: string };

export function MarkdownView({ source }: Props): JSX.Element {
  return (
    <div className={styles.md}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} rehypePlugins={[[rehypeSanitize, schema]]}>
        {source || ''}
      </ReactMarkdown>
    </div>
  );
}
