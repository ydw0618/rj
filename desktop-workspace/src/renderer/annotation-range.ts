import type { Anchor } from '../shared/contracts';

type TextAnchor = Extract<Anchor, { type: 'markdown' }>;

type Segment = { node: Text; start: number };

function readText(root: HTMLElement) {
  let text = '';
  const segments: Segment[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode(node) {
      return node.parentElement?.closest('rich-text [data-v-text]') && node.textContent !== '\u200B'
        ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const part = node as Text;
    segments.push({ node: part, start: text.length });
    text += part.data;
  }
  return { text, segments };
}

export function captureAnchor(root: HTMLElement): TextAnchor | null {
  const selection = window.getSelection();
  if (!selection || selection.isCollapsed || !selection.rangeCount) return null;
  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer) || !root.contains(range.endContainer)) return null;
  const { text, segments } = readText(root);
  const selected = segments.filter(({ node }) => range.intersectsNode(node));
  const first = selected[0];
  const last = selected.at(-1);
  if (!first || !last) return null;
  const start = first.start + (range.startContainer === first.node ? range.startOffset : 0);
  const end = last.start + (range.endContainer === last.node ? range.endOffset : last.node.length);
  const quote = text.slice(start, end);
  if (!quote.trim() || quote.length > 4000) return null;
  return { type: 'markdown', quote, prefix: text.slice(Math.max(0, start - 48), start), suffix: text.slice(end, end + 48), offset: start };
}

function matchingPrefix(left: string, right: string) {
  let count = 0;
  while (count < Math.min(left.length, right.length) && left[count] === right[count]) count++;
  return count;
}

function matchingSuffix(left: string, right: string) {
  let count = 0;
  while (count < Math.min(left.length, right.length) && left[left.length - 1 - count] === right[right.length - 1 - count]) count++;
  return count;
}

export function resolveAnchor(root: HTMLElement, anchor: TextAnchor) {
  const { text, segments } = readText(root);
  const hits: { start: number; confidence: number }[] = [];
  for (let start = text.indexOf(anchor.quote); start !== -1; start = text.indexOf(anchor.quote, start + 1)) {
    const end = start + anchor.quote.length;
    const left = text.slice(Math.max(0, start - anchor.prefix.length), start);
    const right = text.slice(end, end + anchor.suffix.length);
    hits.push({ start, confidence: matchingSuffix(left, anchor.prefix) + matchingPrefix(right, anchor.suffix) });
  }
  hits.sort((left, right) => right.confidence - left.confidence);
  const best = hits[0];
  if (!best || (hits[1] && (best.confidence === 0 || best.confidence === hits[1].confidence))) return null;
  const end = best.start + anchor.quote.length;
  const first = segments.find((segment) => best.start < segment.start + segment.node.length);
  const last = segments.find((segment) => end <= segment.start + segment.node.length);
  if (!first || !last) return null;
  const range = document.createRange();
  range.setStart(first.node, best.start - first.start);
  range.setEnd(last.node, end - last.start);
  return range;
}
