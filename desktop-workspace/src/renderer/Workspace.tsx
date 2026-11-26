import { lazy, Suspense, useCallback, useEffect, useState, type FormEvent } from 'react';
import type { DocumentSummary, ImportPreview, Project, Task, WorkspaceApi } from '../shared/contracts';
import { errorMessage, Icon, Modal, Notice, TaskForm, useNotice } from './ui';
import { SpaceView } from './SpaceView';
import { TaskView } from './TaskView';
import { MarkdownLayoutSettings } from './MarkdownLayoutSettings';
import { AffinePane } from './AffinePane';

type Overview = Awaited<ReturnType<WorkspaceApi['overview']>>;
type Deletion = { kind: 'project'; item: Project } | { kind: 'document'; item: DocumentSummary } | { kind: 'task'; item: Task };
const Chat = lazy(async () => ({ default: (await import('./ChatWindow')).ChatWindow }));

export function Workspace() {
  const [overview, setOverview] = useState<Overview>({ projects: [], documents: [], tags: [] });
  const [tasks, setTasks] = useState<Task[]>([]);
  const [section, setSection] = useState<'affine' | 'space' | 'tasks' | 'chat'>('affine');
  const [project, setProject] = useState<string | null>(null);
  const [dialog, setDialog] = useState<'project' | 'document' | 'task' | null>(null);
  const [editing, setEditing] = useState<Task>();
  const [taskDocument, setTaskDocument] = useState<DocumentSummary>();
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [pendingDelete, setPendingDelete] = useState<Deletion | null>(null);
  const [chatOpened, setChatOpened] = useState(false);
  const [layoutSettings, setLayoutSettings] = useState(false);
  const [transfer, setTransfer] = useState(false);
  const [busy, setBusy] = useState(false);
  const [ready, setReady] = useState(false);
  const [formError, setFormError] = useState('');
  const notice = useNotice();
  const load = useCallback(async () => {
    const [snapshot, list] = await Promise.all([window.workspace.overview(), window.workspace.tasks()]);
    setOverview(snapshot);
    setTasks(list);
    setReady(true);
  }, []);

  useEffect(() => {
    let request: ReturnType<typeof setTimeout> | undefined;
    const refresh = () => { void load().catch(notice.failure); };
    refresh();
    const dispose = window.workspace.onWorkspaceChange(() => {
      if (request) clearTimeout(request);
      request = setTimeout(refresh, 80);
    });
    return () => { dispose(); if (request) clearTimeout(request); };
  }, [load]);

  const openTasks = tasks.filter((task) => !task.done);

  function selectProject(id: string | null) {
    setSection('space');
    setProject(id);
  }

  function startDialog(type: 'project' | 'document' | 'task', task?: Task, document?: DocumentSummary) {
    setFormError('');
    setEditing(task);
    setTaskDocument(document);
    setDialog(type);
  }

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const title = String(new FormData(event.currentTarget).get('title') ?? '').trim();
    if (!title) { setFormError('请输入名称。'); return; }
    setBusy(true);
    setFormError('');
    try {
      if (dialog === 'project') {
        const item = await window.workspace.createProject(title);
        selectProject(item.id);
      } else {
        const document = await window.workspace.createDocument(title, project);
        await window.workspace.openDocument({ documentId: document.id });
      }
      setDialog(null);
    } catch (error) { setFormError(errorMessage(error)); }
    finally { setBusy(false); }
  }

  async function runTransfer(action: () => Promise<void>) {
    setTransfer(true);
    try { await action(); }
    catch (error) { notice.failure(error); }
    finally { setTransfer(false); }
  }

  async function remove() {
    if (!pendingDelete || busy) return;
    setBusy(true);
    try {
      if (pendingDelete.kind === 'project') {
        await window.workspace.deleteProject(pendingDelete.item.id);
        if (project === pendingDelete.item.id) setProject(null);
      } else if (pendingDelete.kind === 'document') {
        await window.workspace.deleteDocument(pendingDelete.item.id);
      } else {
        await window.workspace.deleteTask(pendingDelete.item.id);
      }
      setPendingDelete(null);
    } catch (error) { notice.failure(error); }
    finally { setBusy(false); }
  }

  return <div className="shell">
    <aside className="sidebar">
      <button type="button" className="brand" aria-label="工作空间，返回 AFFiNE"
        aria-current={section === 'affine' ? 'page' : undefined} onClick={() => setSection('affine')}>
        <span className="brand-mark"><Icon name="grid" size={19} /></span><strong>工作空间</strong>
      </button>
      <nav className="nav-group" aria-label="导航">
        <button className={'nav-item ' + (section === 'space' && !project ? 'selected' : '')} onClick={() => selectProject(null)}><Icon name="space" />空间</button>
        <button className={'nav-item ' + (section === 'tasks' ? 'selected' : '')} onClick={() => setSection('tasks')}><Icon name="task" />任务<span className="nav-count">{openTasks.length || ''}</span></button>
        <button className={'nav-item ' + (section === 'chat' ? 'selected' : '')} onClick={() => { setChatOpened(true); setSection('chat'); }}><Icon name="chat" />AI 聊天</button>
      </nav>
      <div className="nav-heading"><span>项目</span><button className="icon-button" aria-label="新建项目" onClick={() => startDialog('project')}><Icon name="plus" size={16} /></button></div>
      <nav className="project-list" aria-label="项目">
        {overview.projects.map((item) => <div key={item.id} className={'project-row ' + (section === 'space' && project === item.id ? 'selected' : '')}>
          <button title={item.name} className="nav-item project-item" onClick={() => selectProject(item.id)}><span className="project-dot" /><span>{item.name}</span></button>
          <button className="icon-button danger-action project-delete" aria-label={'删除项目 ' + item.name} title="删除项目" onClick={() => setPendingDelete({ kind: 'project', item })}><Icon name="trash" size={14} /></button>
        </div>)}
        {!overview.projects.length && ready && <p className="nav-empty">暂无项目</p>}
      </nav>
      <div className="sidebar-bottom">
        <button className="nav-item" onClick={() => setLayoutSettings(true)}><Icon name="settings" size={16} />设置</button>
        <button className="nav-item" disabled={transfer} onClick={() => void runTransfer(async () => {
          const review = await window.workspace.previewImport();
          if (review) setPreview(review);
        })}><Icon name="import" size={16} />导入工作空间</button>
        <button className="nav-item" disabled={transfer} onClick={() => void runTransfer(async () => {
          if (await window.workspace.exportWorkspace()) notice.success('工作空间已导出。');
        })}><Icon name="export" size={16} />导出工作空间</button>
      </div>
    </aside>
    <main className={'workspace-content ' + (section === 'chat' || section === 'affine' ? 'workspace-full' : '')}>
      {section === 'affine' && <AffinePane active={!dialog && !preview && !layoutSettings && !pendingDelete} />}
      <div hidden={section !== 'space'}>
        <SpaceView {...overview} project={project} ready={ready} transfer={transfer} setProject={setProject}
          createDocument={() => startDialog('document')} createTask={(item) => startDialog('task', undefined, item)}
          deleteDocument={(item) => setPendingDelete({ kind: 'document', item })} onError={notice.failure}
          importDocuments={() => void runTransfer(async () => {
            const count = await window.workspace.importDocuments(project);
            if (count) notice.success('已导入 ' + count + ' 份资料。');
          })} />
      </div>
      <div hidden={section !== 'tasks'}>
        <TaskView tasks={tasks} ready={ready} update={setTasks} create={() => startDialog('task')}
          edit={(item) => startDialog('task', item)} remove={(item) => setPendingDelete({ kind: 'task', item })} onError={notice.failure} />
      </div>
      {chatOpened && <div hidden={section !== 'chat'} className="chat-host">
        <Suspense fallback={<div className="loading">正在加载聊天…</div>}><Chat /></Suspense>
      </div>}
    </main>
    {dialog && dialog !== 'task' && <Modal title={dialog === 'project' ? '新建项目' : '新建 Markdown 文档'} close={() => { if (!busy) setDialog(null); }}>
      <form onSubmit={(event) => void create(event)} className="form-stack">
        <label>{dialog === 'project' ? '项目名称' : '文档标题'}<input name="title" required autoFocus maxLength={150} /></label>
        {formError && <p className="inline-error" role="alert">{formError}</p>}
        <footer className="form-actions"><button type="button" className="button" disabled={busy} onClick={() => setDialog(null)}>取消</button><button className="button primary" disabled={busy}>创建</button></footer>
      </form>
    </Modal>}
    {dialog === 'task' && <TaskForm projects={overview.projects} projectId={taskDocument ? taskDocument.projectId : editing ? editing.projectId : project}
      task={editing} source={taskDocument ? { documentId: taskDocument.id } : undefined}
      title={taskDocument?.title} close={() => setDialog(null)}
      submit={async (input) => { if (editing) await window.workspace.updateTask(editing.id, input); else await window.workspace.createTask(input); }} />}
    {preview && <Modal title="导入工作空间" close={() => {
      if (transfer) return;
      setPreview(null);
      void window.workspace.cancelImport(preview.token).catch(notice.failure);
    }}>
      <div className="form-stack">
        <p>{preview.counts.projects} 个项目、{preview.counts.documents} 份资料、{preview.counts.annotations} 条批注和 {preview.counts.tasks} 项任务。</p>
        <p className="muted">{preview.hasExisting ? '现有数据会保留。导入内容作为一套副本加入，任务仍关联对应的导入资料。' : '资料、历史和任务来源将在本机恢复。'}</p>
        <footer className="form-actions"><button className="button" disabled={transfer} onClick={() => {
          setPreview(null); void window.workspace.cancelImport(preview.token).catch(notice.failure);
        }}>取消</button><button className="button primary" disabled={transfer} onClick={() => void runTransfer(async () => {
          try { await window.workspace.finishImport(preview.token); notice.success('工作空间已导入。'); }
          finally { setPreview(null); }
        })}>{transfer ? '正在导入…' : '确认导入'}</button></footer>
      </div>
    </Modal>}
    {layoutSettings && <MarkdownLayoutSettings close={() => setLayoutSettings(false)} />}
    {pendingDelete && <Modal title={pendingDelete.kind === 'project' ? '删除项目' : pendingDelete.kind === 'document' ? '删除资料' : '删除任务'} close={() => { if (!busy) setPendingDelete(null); }}><div className="form-stack">
      <p>删除「{'title' in pendingDelete.item ? pendingDelete.item.title : pendingDelete.item.name}」？</p>
      <p className="muted">{pendingDelete.kind === 'project' ? '项目里的资料和任务会保留，归为未分类。'
        : pendingDelete.kind === 'document' ? '这份资料的批注和历史将一并删除。关联任务会保留，来源链接将移除。'
          : '来源资料和批注会保留。'}</p>
      <footer className="form-actions"><button className="button" disabled={busy} onClick={() => setPendingDelete(null)}>取消</button>
        <button className="button destructive" disabled={busy} onClick={() => void remove()}>删除</button></footer>
    </div></Modal>}
    <Notice message={notice.message} clear={notice.clear} />
  </div>;
}
