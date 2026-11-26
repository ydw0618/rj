import { useEffect, useId, useRef, useState, type FormEvent, type ReactNode } from 'react';
import type { Project, Source, Task, TaskInput } from '../shared/contracts';

const icons = {
  space: 'M4 7V5a1 1 0 0 1 1-1h5l2 2h7a1 1 0 0 1 1 1v12H4Z',
  task: 'M4 5h16v14H4z M8 12l2 2 5-5',
  chat: 'M5 5h14v11H9l-4 3z M9 9h6 M9 12h4',
  plus: 'M12 5v14 M5 12h14',
  import: 'M12 4v11m-4-4 4 4 4-4M5 15v5h14v-5',
  export: 'M12 15V4m-4 4 4-4 4 4M5 15v5h14v-5',
  search: 'M10.5 4a6.5 6.5 0 1 0 0 13 6.5 6.5 0 0 0 0-13zm5 11.5L21 21',
  doc: 'M6 3h8l4 4v14H6z M14 3v5h4 M9 12h6 M9 16h6',
  pdf: 'M6 3h8l4 4v14H6z M14 3v5h4 M10 17c2-4 2-6 2-6s-3 6 3 5',
  image: 'M4 5h16v14H4z M7 16l4-4 3 3 2-2 4 4 M8 9h.01',
  tag: 'M4 4h8l8 8-8 8-8-8z M8 8h.01',
  chevron: 'm9 6 6 6-6 6',
  left: 'm15 6-6 6 6 6',
  close: 'M6 6l12 12M18 6 6 18',
  more: 'M5 12h.01 M12 12h.01 M19 12h.01',
  history: 'M3 11a9 9 0 1 1 2 7 M3 5v6h6 M12 7v5l4 2',
  note: 'M4 5h16v12H9l-5 3z M8 9h8 M8 13h5',
  link: 'M9 15l6-6 M8 17l-1 1a4 4 0 0 1-5-5l4-4a4 4 0 0 1 5 0 M16 7l1-1a4 4 0 0 1 5 5l-4 4a4 4 0 0 1-5 0',
  settings: 'M5 8h14 M5 16h14 M9 5v6 M15 13v6',
  send: 'M4 5l16 7-16 7 4-7z M8 12h12',
  clock: 'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18z M12 7v5l3 2',
  grid: 'M4 4h6v6H4z M14 4h6v6h-6z M4 14h6v6H4z M14 14h6v6h-6z',
  grip: 'M9 6h.01 M15 6h.01 M9 12h.01 M15 12h.01 M9 18h.01 M15 18h.01',
  trash: 'M5 7h14 M9 7V4h6v3 M7 7l1 13h8l1-13 M10 10v7 M14 10v7',
  taskAdd: 'M5 5h10v5 M5 5v14h14v-5 M12 13h8 M16 9v8 M8 10h3 M8 14h2',
} as const;

export function Icon({ name, size = 18 }: { name: keyof typeof icons; size?: number }) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.65" strokeLinecap="round" strokeLinejoin="round"><path d={icons[name]} /></svg>;
}

export const kindLabels = { markdown: 'Markdown', pdf: 'PDF', image: '图片' };
export const kindIcon = { markdown: 'doc', pdf: 'pdf', image: 'image' } as const;
export const dateLabel = (date: string) => new Date(date).toLocaleString('zh-CN', {
  month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false,
});

export function errorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function Modal({ title, children, close, wide = false }: { title: string; children: ReactNode; close: () => void; wide?: boolean }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const label = useId();
  useEffect(() => {
    dialog.current?.showModal();
  }, []);
  return <dialog ref={dialog} className={wide ? 'modal modal-wide' : 'modal'} aria-labelledby={label}
    onCancel={(event) => { event.preventDefault(); close(); }}>
    <header className="modal-header"><h2 id={label}>{title}</h2><button className="icon-button" aria-label="关闭" onClick={close}><Icon name="close" /></button></header>
    {children}
  </dialog>;
}

export function Empty({ icon, title, children }: { icon: keyof typeof icons; title: string; children?: ReactNode }) {
  return <div className="empty"><div className="empty-icon"><Icon name={icon} size={27} /></div><p>{title}</p>{children}</div>;
}

export function Notice({ message, clear }: { message: { text: string; error: boolean } | null; clear: () => void }) {
  if (!message) return null;
  return <div className={'notice ' + (message.error ? 'notice-error' : '')} role={message.error ? 'alert' : 'status'}>
    <span>{message.text}</span><button className="icon-button" aria-label="关闭提示" onClick={clear}><Icon name="close" size={14} /></button>
  </div>;
}

export function useNotice() {
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  useEffect(() => {
    if (!message || message.error) return;
    const timer = setTimeout(() => setMessage(null), 4500);
    return () => clearTimeout(timer);
  }, [message]);
  return {
    message,
    clear: () => setMessage(null),
    success: (text: string) => setMessage({ text, error: false }),
    failure: (error: unknown) => setMessage({ text: errorMessage(error), error: true }),
  };
}

function localDeadline(value?: string | null) {
  if (!value) return '';
  const date = new Date(value);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 16);
}

export function TaskForm({ projects, projectId, task, source, title, close, submit }: {
  projects: Project[]; projectId: string | null; task?: Task; source?: Source; title?: string; close: () => void;
  submit: (input: TaskInput) => Promise<void>;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function save(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const taskTitle = String(data.get('title') ?? '').trim();
    if (!taskTitle) { setError('请输入任务名称。'); return; }
    const deadline = String(data.get('deadline') ?? '');
    setBusy(true);
    setError('');
    try {
      await submit({
        title: taskTitle, deadline: deadline ? new Date(deadline).toISOString() : null,
        important: data.has('important'), urgent: data.has('urgent'),
        projectId: source || task?.source ? projectId : String(data.get('project') ?? '') || null, source,
      });
      close();
    } catch (failure) { setError(errorMessage(failure)); }
    finally { setBusy(false); }
  }
  return <Modal title={task ? '编辑任务' : '新建任务'} close={() => { if (!busy) close(); }}>
    <form onSubmit={(event) => void save(event)} className="form-stack">
      <label>任务名称<input name="title" required maxLength={150} defaultValue={task?.title ?? title ?? ''} autoFocus /></label>
      <label>截止时间<input type="datetime-local" name="deadline" defaultValue={localDeadline(task?.deadline)} /></label>
      <div className="task-dimensions" aria-label="任务维度">
        <label><input type="checkbox" name="important" defaultChecked={task?.important} />重要</label>
        <label><input type="checkbox" name="urgent" defaultChecked={task?.urgent} />紧急</label>
      </div>
      <label>项目<select name="project" defaultValue={task?.projectId ?? projectId ?? ''} disabled={Boolean(source ?? task?.source)}>
        <option value="">无项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}
      </select></label>
      {error && <p className="inline-error" role="alert">{error}</p>}
      <footer className="form-actions"><button type="button" className="button" disabled={busy} onClick={close}>取消</button><button className="button primary" disabled={busy}>{busy ? '正在保存…' : '保存任务'}</button></footer>
    </form>
  </Modal>;
}
