import { useLayoutEffect, useRef } from 'react';
import type { EditorCommand, SlashTrigger } from './markdown-slash';

export function SlashMenu({ id, trigger, choices, active, onChoose }: {
  id: string; trigger: SlashTrigger; choices: EditorCommand[]; active: number;
  onChoose: (item: EditorCommand) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const { left, top, bottom } = trigger.caret;
  useLayoutEffect(() => {
    const node = menu.current;
    if (!node) return;
    const { width, height } = node.getBoundingClientRect();
    node.style.left = Math.max(8, Math.min(left, window.innerWidth - width - 8)) + 'px';
    const below = window.innerHeight - bottom >= height + 12;
    node.style.top = Math.max(8, below ? bottom + 6 : top - height - 6) + 'px';
  }, [left, top, bottom, choices.length]);
  useLayoutEffect(() => {
    const panel = menu.current?.querySelector('.slash-options');
    const item = panel?.children[active] as HTMLElement | undefined;
    if (!panel || !item) return;
    if (item.offsetTop < panel.scrollTop) panel.scrollTop = item.offsetTop;
    else if (item.offsetTop + item.offsetHeight > panel.scrollTop + panel.clientHeight) {
      panel.scrollTop = item.offsetTop + item.offsetHeight - panel.clientHeight;
    }
  }, [active, choices.length]);

  return <div className="slash-menu" ref={menu} data-slash-menu>
    <div className="slash-heading">插入内容</div>
    <div id={id} className="slash-options" role="listbox" aria-label="插入内容">
      {choices.map((item, index) => <button key={item.name} id={id + '-' + index} type="button" role="option"
        aria-selected={index === active} tabIndex={-1} onMouseDown={(event) => event.preventDefault()}
        onClick={() => onChoose(item)}>
        <span>{item.label}</span><span aria-hidden="true" className="slash-shortcut">/{item.name}</span>
      </button>)}
    </div>
    {!choices.length && <p className="slash-empty" role="status">没有匹配的内容块</p>}
  </div>;
}
