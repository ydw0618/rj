import { createRoot } from 'react-dom/client';
import type { Anchor, WorkspaceApi } from '../shared/contracts';
import './styles.css';

declare global {
  interface Window { workspace: WorkspaceApi }
}

const query = new URLSearchParams(window.location.search);
const root = createRoot(document.getElementById('root')!);
const view = query.get('view');

if (view === 'document') {
  void import('./DocumentWindow').then(({ DocumentWindow }) => {
    const anchor = query.get('anchor');
    root.render(<DocumentWindow id={query.get('id') ?? ''} initialAnnotation={query.get('annotation')}
      initialAnchor={anchor ? JSON.parse(anchor) as Anchor : null} />);
  });
} else {
  void import('./Workspace').then(({ Workspace }) => root.render(<Workspace />));
}
