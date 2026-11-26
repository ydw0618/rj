import { useState } from 'react';
import type { Heading } from './MarkdownEditor';
import { Icon } from './ui';

type OutlineNode = { heading: Heading; index: number; children: OutlineNode[] };

function nestHeadings(headings: Heading[]): OutlineNode[] {
  const roots: OutlineNode[] = [];
  const ancestors: OutlineNode[] = [];
  headings.forEach((heading, index) => {
    while (ancestors.length && ancestors[ancestors.length - 1].heading.level >= heading.level) ancestors.pop();
    const node = { heading, index, children: [] };
    const parent = ancestors.at(-1);
    (parent?.children ?? roots).push(node);
    ancestors.push(node);
  });
  return roots;
}

function Branch({ nodes, folded, active, toggle, navigate }: {
  nodes: OutlineNode[]; folded: ReadonlySet<string>; active: string | null;
  toggle: (id: string) => void; navigate: (id: string, heading: Heading) => void;
}) {
  return <ul className="outline-list">
    {nodes.map(({ heading, index, children }) => {
      const id = heading.element.id || index + ':' + heading.title;
      const expanded = !folded.has(id);
      return <li key={id}>
        <div className="outline-entry">
          {children.length ? <button className="outline-toggle" aria-expanded={expanded}
            aria-label={(expanded ? '折叠 ' : '展开 ') + heading.title} onClick={() => toggle(id)}>
            <Icon name="chevron" size={12} />
          </button> : <span className="outline-spacer" />}
          <button className="outline-link" title={heading.title} aria-current={active === id ? 'location' : undefined}
            onClick={() => navigate(id, heading)}>{heading.title}</button>
        </div>
        {children.length > 0 && expanded && <Branch nodes={children} folded={folded} active={active} toggle={toggle} navigate={navigate} />}
      </li>;
    })}
  </ul>;
}

export function Outline({ headings }: { headings: Heading[] }) {
  const [folded, setFolded] = useState<Set<string>>(new Set());
  const [active, setActive] = useState<string | null>(null);
  function toggle(id: string) {
    setFolded((current) => {
      const next = new Set(current);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }
  function navigate(id: string, heading: Heading) {
    setActive(id);
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    heading.element.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'auto' : 'smooth' });
  }
  return <nav className="outline" aria-label="文档大纲">
    <h2>大纲</h2>
    {headings.length ? <Branch nodes={nestHeadings(headings)} folded={folded} active={active} toggle={toggle} navigate={navigate} /> : <p>添加标题后显示大纲</p>}
  </nav>;
}
