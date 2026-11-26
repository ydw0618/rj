import { useEffect, useLayoutEffect, useRef } from 'react';

export type MarkdownAction = { label: string; run: () => void; disabled?: boolean; danger?: boolean };
export type MarkdownMenuLevel = { label: string; items: MarkdownAction[] };

export function MarkdownMenu({ x, y, groups, close }: { x: number; y: number; groups: MarkdownMenuLevel[]; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  const closeRef = useRef(close);
  closeRef.current = close;
  useLayoutEffect(() => {
    const element = ref.current;
    if (!element) return;
    const box = element.getBoundingClientRect();
    element.style.left = Math.max(5, Math.min(x, window.innerWidth - box.width - 5)) + 'px';
    element.style.top = Math.max(5, Math.min(y, window.innerHeight - box.height - 5)) + 'px';
    element.focus({ preventScroll: true });
  }, [x, y]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !ref.current?.contains(event.target)) closeRef.current();
    };
    const blur = () => closeRef.current();
    window.addEventListener('pointerdown', outside);
    window.addEventListener('blur', blur);
    window.addEventListener('resize', blur);
    return () => {
      window.removeEventListener('pointerdown', outside);
      window.removeEventListener('blur', blur);
      window.removeEventListener('resize', blur);
    };
  }, []);

  return <div ref={ref} className="markdown-menu" role="menu" aria-label="Markdown 功能" tabIndex={-1}
    onContextMenu={(event) => event.preventDefault()}
    onKeyDown={(event) => {
      if (event.key === 'Escape') { event.preventDefault(); close(); return; }
      if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
      const buttons = Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? []);
      if (!buttons.length) return;
      event.preventDefault();
      const index = buttons.findIndex((button) => button === document.activeElement);
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : buttons.length - 1)
        : (index + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length;
      buttons[next].focus();
    }}>
    {groups.map(({ label, items }) => <div role="group" aria-label={label} key={label} className="markdown-menu-group">
      {items.map((item) => <button key={item.label} type="button" role="menuitem" disabled={item.disabled}
        className={item.danger ? 'danger-action' : undefined} onMouseDown={(event) => event.preventDefault()}
        onClick={() => { close(); item.run(); }}>{item.label}</button>)}
    </div>)}
  </div>;
}
