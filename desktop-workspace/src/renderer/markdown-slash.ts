import type { BlockCommand } from './affine-document';

export type EditorCommand = { label: string; name: BlockCommand | 'link' };

export const blockCommands = [
  { label: '一级标题', name: 'h1', aliases: ['heading', 'bt'] },
  { label: '二级标题', name: 'h2', aliases: ['heading', 'bt'] },
  { label: '三级标题', name: 'h3', aliases: ['heading', 'bt'] },
  { label: '表格', name: 'table', aliases: ['bg', 'biaoge'] },
  { label: '代码块', name: 'code', aliases: ['dmk', 'daima'] },
  { label: '无序列表', name: 'list', aliases: ['bullet', 'wxlb'] },
  { label: '有序列表', name: 'ordered-list', aliases: ['number', 'yxlb'] },
  { label: '待办列表', name: 'check', aliases: ['todo', 'task', 'db'] },
  { label: '引用', name: 'quote', aliases: ['yy', 'yinyong'] },
  { label: '分隔线', name: 'line', aliases: ['divider', 'fgx'] },
  { label: '链接', name: 'link', aliases: ['url', 'lj'] },
] satisfies (EditorCommand & { aliases: string[] })[];

export type SlashTrigger = {
  query: string;
  range: Range;
  caret: DOMRect;
};

export function getSlashTrigger(root: HTMLElement): SlashTrigger | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || !selection.isCollapsed) return null;
  const caret = selection.getRangeAt(0);
  const container = caret.startContainer;
  if (!root.contains(container)) return null;
  const parent = container instanceof Element ? container : container.parentElement;
  const paragraph = parent?.closest('rich-text');
  if (!paragraph || !paragraph.closest('affine-paragraph') || parent?.closest('a, code')) return null;

  const prefix = document.createRange();
  prefix.setStart(paragraph, 0);
  prefix.setEnd(container, caret.startOffset);
  const before = prefix.toString();
  const match = /(?:^|[\s\u200B])([/／]([\p{L}\p{N}_-]{0,28}))$/u.exec(before);
  if (!match) return null;

  const range = caret.cloneRange();
  let offset = before.length - match[1].length;
  const walker = document.createTreeWalker(paragraph, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const length = node.textContent?.length ?? 0;
    if (offset < length) {
      range.setStart(node, offset);
      return range.toString() === match[1] ? { query: match[2].toLocaleLowerCase(), range, caret: caret.getBoundingClientRect() } : null;
    }
    offset -= length;
  }
  return null;
}

export function matchingBlocks(query: string) {
  return blockCommands.filter((item) => [item.label, item.name, ...item.aliases].some((value) => value.includes(query)));
}
