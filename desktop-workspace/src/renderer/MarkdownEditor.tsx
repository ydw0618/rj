import { useEffect, useId, useImperativeHandle, useRef, useState, type KeyboardEvent, type MouseEvent, type Ref } from 'react';
import type { PageEditor } from '@blocksuite/presets';
import type { Doc } from '@blocksuite/store';
import '@toeverything/theme/style.css';
import './markdown-reading.css';
import type { Anchor } from '../shared/contracts';
import { applyBlockCommand, blockAt, createPageEditor, importDocument, releaseDocument, serializeDocument, type BlockCommand } from './affine-document';
import { captureAnchor, resolveAnchor } from './annotation-range';
import { MarkdownMenu, type MarkdownAction, type MarkdownMenuLevel } from './MarkdownMenu';
import { SlashMenu } from './SlashMenu';
import { getSlashTrigger, matchingBlocks, type EditorCommand, type SlashTrigger } from './markdown-slash';
import { errorMessage, Modal } from './ui';

export type Heading = { level: number; title: string; element: HTMLElement };
export type TextAnchor = Extract<Anchor, { type: 'markdown' }>;
export type MarkdownHandle = {
  read(): Promise<string | undefined>;
  range(anchor: TextAnchor): Range | null;
  replace(markdown: string): Promise<void>;
  goto(anchor: TextAnchor): boolean;
};

type Menu = { x: number; y: number; range: Range | null; anchor: TextAnchor | null };
type InlineFormat = 'bold' | 'italic' | 'code';
type EditorSession = { page: PageEditor; doc: Doc; close(): void };

function rangeFor(root: HTMLElement, event: MouseEvent) {
  const selection = window.getSelection();
  const current = selection?.rangeCount ? selection.getRangeAt(0) : null;
  const inside = current && root.contains(current.startContainer) && root.contains(current.endContainer);
  if (inside && (!current.collapsed || (!event.clientX && !event.clientY))) return current.cloneRange();
  const point = document.caretRangeFromPoint(event.clientX, event.clientY);
  return point && blockAt(point) && root.contains(point.startContainer) ? point : null;
}

function textRanges(root: HTMLElement, range: Range) {
  return [...root.querySelectorAll('rich-text')].flatMap((element) => {
    if (!range.intersectsNode(element) || element.closest('affine-code')) return [];
    const editor = element.inlineEditor;
    const selection = editor?.toInlineRange(range);
    return editor && selection?.length ? [{ editor, selection }] : [];
  });
}

export function MarkdownEditor({ initial, onChange, onHeadings, onSelection, onReady, handle, documentActions }: {
  initial: string;
  onChange: () => void;
  onHeadings: (headings: Heading[]) => void;
  onSelection: (anchor: TextAnchor | null) => void;
  onReady: () => void;
  handle: Ref<MarkdownHandle>;
  documentActions: (anchor: TextAnchor | null) => MarkdownAction[];
}) {
  const host = useRef<HTMLDivElement>(null);
  const session = useRef<EditorSession | null>(null);
  const source = useRef(initial);
  const mountVersion = useRef(0);
  const [menu, setMenu] = useState<Menu | null>(null);
  const [slash, setSlash] = useState<SlashTrigger | null>(null);
  const [activeBlock, setActiveBlock] = useState(0);
  const [link, setLink] = useState<{ range: Range; replaceTrigger?: boolean } | null>(null);
  const [failure, setFailure] = useState('');
  const slashId = useId();
  const callbacks = useRef({ onChange, onHeadings, onSelection, onReady });
  callbacks.current = { onChange, onHeadings, onSelection, onReady };
  const choices = slash ? matchingBlocks(slash.query) : [];

  async function mount(markdown: string) {
    const element = host.current;
    if (!element) return;
    const version = ++mountVersion.current;
    const page = createPageEditor();
    const doc = await importDocument(markdown);
    if (version !== mountVersion.current) {
      releaseDocument(doc);
      return;
    }
    session.current?.close();
    page.doc = doc;
    page.setAttribute('aria-label', 'Markdown 正文');
    element.replaceChildren(page);
    let frame = 0;
    function queueHeadings() {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        const headings: Heading[] = [];
        for (const node of page.querySelectorAll<HTMLElement>('affine-paragraph .affine-paragraph-rich-text-wrapper')) {
          const type = [...node.classList].find((name) => /^h[1-6]$/.test(name));
          if (!type) continue;
          const title = node.querySelector('rich-text')?.textContent?.replaceAll('\u200B', '').trim();
          if (title) headings.push({ level: Number(type[1]), title, element: node });
        }
        callbacks.current.onHeadings(headings);
      });
    }
    const changed = doc.slots.blockUpdated.on(() => {
      callbacks.current.onChange();
      queueHeadings();
    });
    session.current = {
      page, doc, close: () => {
        changed.dispose();
        cancelAnimationFrame(frame);
        page.remove();
        releaseDocument(doc);
      },
    };
    queueHeadings();
    await page.updateComplete;
    if (version !== mountVersion.current) return;
    queueHeadings();
    callbacks.current.onReady();
  }

  useImperativeHandle(handle, () => ({
    async read() { return session.current ? serializeDocument(session.current.doc) : undefined; },
    range(anchor) { return host.current ? resolveAnchor(host.current, anchor) : null; },
    async replace(markdown) {
      source.current = markdown;
      setSlash(null);
      callbacks.current.onSelection(null);
      await mount(markdown);
    },
    goto(anchor) {
      const range = host.current && resolveAnchor(host.current, anchor);
      if (!range) return false;
      range.startContainer.parentElement?.scrollIntoView({ block: 'center', behavior: 'smooth' });
      return true;
    },
  }), []);

  useEffect(() => {
    const element = host.current;
    let frame = 0;
    const queueSlash = (event: Event) => {
      if (event instanceof InputEvent && event.isComposing) return;
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(() => {
        frame = requestAnimationFrame(() => {
          const trigger = element && getSlashTrigger(element);
          setSlash(trigger);
          setActiveBlock(0);
        });
      });
    };
    element?.addEventListener('beforeinput', queueSlash, true);
    element?.addEventListener('compositionend', queueSlash, true);
    void mount(source.current).catch((error: unknown) => setFailure(errorMessage(error)));
    return () => {
      cancelAnimationFrame(frame);
      element?.removeEventListener('beforeinput', queueSlash, true);
      element?.removeEventListener('compositionend', queueSlash, true);
      mountVersion.current++;
      session.current?.close();
      session.current = null;
    };
  }, []);

  function updateSelection() {
    if (host.current) callbacks.current.onSelection(captureAnchor(host.current));
  }

  function runBlock(name: BlockCommand, range: Range | null, removeTrigger = false) {
    const active = session.current;
    const block = range && blockAt(range);
    if (!active || !range || !block || !active.page.contains(block)) return;
    if (removeTrigger) {
      const text = block.querySelector('rich-text')?.inlineEditor;
      const selection = text?.toInlineRange(range);
      if (!text || !selection) return;
      text.deleteText(selection);
    }
    void applyBlockCommand(active.page, block, name, removeTrigger).catch((error: unknown) => setFailure(errorMessage(error)));
  }

  function chooseBlock(item: EditorCommand) {
    const trigger = host.current && getSlashTrigger(host.current);
    setSlash(null);
    if (!trigger) return;
    if (item.name === 'link') {
      setLink({ range: trigger.range, replaceTrigger: true });
      return;
    }
    runBlock(item.name, trigger.range, true);
  }

  function useBlockKeys(event: KeyboardEvent) {
    if (!slash || event.nativeEvent.isComposing || event.keyCode === 229) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      setSlash(null);
    } else if (choices.length && (event.key === 'ArrowDown' || event.key === 'ArrowUp')) {
      event.preventDefault();
      event.stopPropagation();
      const step = event.key === 'ArrowDown' ? 1 : -1;
      setActiveBlock((index) => (index + step + choices.length) % choices.length);
    } else if (choices.length && event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      chooseBlock(choices[Math.min(activeBlock, choices.length - 1)]);
    }
  }

  useEffect(() => {
    if (!slash) return;
    const dismiss = (event: Event) => {
      if (!(event.target instanceof Element) || !event.target.closest('[data-slash-menu]')) setSlash(null);
    };
    window.addEventListener('pointerdown', dismiss, true);
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    window.addEventListener('blur', dismiss);
    return () => {
      window.removeEventListener('pointerdown', dismiss, true);
      window.removeEventListener('scroll', dismiss, true);
      window.removeEventListener('resize', dismiss);
      window.removeEventListener('blur', dismiss);
    };
  }, [slash]);

  function openMenu(event: MouseEvent) {
    const root = host.current;
    if (!root || !session.current) return;
    event.preventDefault();
    setSlash(null);
    const range = rangeFor(root, event);
    const bounds = range?.getBoundingClientRect() ?? root.getBoundingClientRect();
    const keyboard = !event.clientX && !event.clientY;
    setMenu({ range, anchor: captureAnchor(root), x: keyboard ? bounds.left : event.clientX, y: keyboard ? bounds.bottom : event.clientY });
  }

  function format(range: Range, name: InlineFormat) {
    const active = session.current;
    if (!active) return;
    const ranges = textRanges(active.page, range);
    const remove = ranges.every(({ editor, selection }) => editor.getFormat(selection)[name]);
    active.doc.captureSync();
    for (const { editor, selection } of ranges) editor.formatText(selection, { [name]: remove ? null : true });
  }

  function command(label: string, name: BlockCommand): MarkdownAction {
    return { label, disabled: !menu?.range || !blockAt(menu.range), run: () => runBlock(name, menu?.range ?? null) };
  }

  function style(label: string, name: InlineFormat): MarkdownAction {
    const range = menu?.range;
    return { label, disabled: !range || range.collapsed, run: () => { if (range) format(range, name); } };
  }

  const menuGroups: MarkdownMenuLevel[] = menu ? [
    { label: '插入', items: [
      command('插入表格', 'table'), command('代码块', 'code'),
      { label: '插入链接', disabled: !menu.range || !blockAt(menu.range), run: () => { if (menu.range) setLink({ range: menu.range }); } },
      command('分隔线', 'line'),
    ] },
    { label: '格式', items: [
      command('一级标题', 'h1'), command('二级标题', 'h2'), command('三级标题', 'h3'),
      style('粗体', 'bold'), style('斜体', 'italic'), style('行内代码', 'code'),
      command('无序列表', 'list'), command('有序列表', 'ordered-list'), command('待办列表', 'check'), command('引用', 'quote'),
    ] },
    { label: '文档', items: documentActions(menu.anchor) },
  ] : [];

  return <div className="markdown-panel">
    <div className="markdown-scroll affine-page-viewport">
      <div ref={host} className="editor-host" onContextMenu={openMenu} onKeyDownCapture={useBlockKeys}
        onMouseUpCapture={updateSelection} onKeyUp={updateSelection}
        onClickCapture={(event) => {
          if (event.target instanceof Element && event.target.closest('a[href]')) event.preventDefault();
        }} />
      {failure && <p className="inline-error" role="alert">{failure}</p>}
    </div>
    {slash && <SlashMenu id={slashId} trigger={slash} choices={choices} active={Math.min(activeBlock, Math.max(0, choices.length - 1))} onChoose={chooseBlock} />}
    {menu && <MarkdownMenu x={menu.x} y={menu.y} groups={menuGroups} close={() => setMenu(null)} />}
    {link && <Modal title="插入链接" close={() => setLink(null)}><form className="form-stack" onSubmit={(event) => {
      event.preventDefault();
      const url = String(new FormData(event.currentTarget).get('url') ?? '').trim();
      if (!/^https?:\/\//i.test(url)) return;
      const page = session.current?.page;
      if (!page || !page.contains(link.range.startContainer)) return;
      page.doc.captureSync();
      if (link.range.collapsed || link.replaceTrigger) {
        const text = blockAt(link.range)?.querySelector('rich-text')?.inlineEditor;
        const selection = text?.toInlineRange(link.range);
        if (text && selection) text.insertText(selection, url, { link: url });
      } else {
        for (const { editor, selection } of textRanges(page, link.range)) editor.formatText(selection, { link: url });
      }
      setLink(null);
    }}>
      <label>链接地址<input name="url" type="url" pattern="https?://.+" placeholder="https://" required autoFocus /></label>
      <footer className="form-actions"><button className="button primary">插入</button></footer>
    </form></Modal>}
  </div>;
}

