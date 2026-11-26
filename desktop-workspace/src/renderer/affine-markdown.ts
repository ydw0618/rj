import { defaultBlockMarkdownAdapterMatchers, MarkdownAdapter } from '@blocksuite/blocks';
import type { Job } from '@blocksuite/store';
import { marked } from 'marked';

const sourceLanguage = 'workspace-markdown-source';
type Matcher = (typeof defaultBlockMarkdownAdapterMatchers)[number];
type SnapshotText = { delta?: { insert: string }[] };

function sourceBlock(raw: string) {
  let width = 3;
  for (const [run] of raw.matchAll(/`+/g)) width = Math.max(width, run.length + 1);
  const fence = '`'.repeat(width);
  return '\n\n' + fence + sourceLanguage + '\n' + raw.trimEnd() + '\n' + fence + '\n\n';
}

export function preserveMarkdownSource(markdown: string) {
  const tokens = marked.lexer(markdown, { gfm: true });
  return tokens.map((token) => {
    let needsSource = false;
    marked.walkTokens([token], (part) => {
      if (part.type === 'image' || part.type === 'html' || part.type === 'def'
        || (part.type === 'text' && /\[\^[^\]]+\]/.test(part.raw))
        || (part.type === 'link' && /\]\s*\[/.test(part.raw))) needsSource = true;
    });
    return needsSource ? sourceBlock(token.raw) : token.raw;
  }).join('');
}

const originalCode = defaultBlockMarkdownAdapterMatchers.find((matcher) => matcher.flavour === 'affine:code')!;
const sourceMatcher: Matcher = {
  ...originalCode,
  fromBlockSnapshot: {
    enter(value, context) {
      if (value.node.props.language !== sourceLanguage) return originalCode.fromBlockSnapshot.enter?.(value, context);
      const text = value.node.props.text as SnapshotText;
      context.walkerContext.openNode({
        type: 'html', value: text.delta?.map(({ insert }) => insert).join('') ?? '',
      }, 'children').closeNode();
    },
  },
};

export function markdownAdapter(job: Job) {
  return new MarkdownAdapter(job, defaultBlockMarkdownAdapterMatchers.map((matcher) =>
    matcher === originalCode ? sourceMatcher : matcher));
}
