import { useEffect, useState, type FormEvent } from 'react';
import type { DocumentSearch, DocumentSummary, Kind, Project, Tag } from '../shared/contracts';
import { Empty, Icon, kindIcon, kindLabels, Modal } from './ui';

const defaultFilters = { kind: null, tagIds: [], updatedFrom: null, updatedBefore: null, includeBody: false } satisfies Omit<DocumentSearch, 'query' | 'projectId'>;
type Options = Omit<DocumentSearch, 'query' | 'projectId'>;
type Props = {
  project: string | null; projects: Project[]; tags: Tag[]; documents: DocumentSummary[]; ready: boolean; transfer: boolean;
  setProject: (id: string | null) => void; createDocument: () => void; importDocuments: () => void;
  createTask: (item: DocumentSummary) => void; deleteDocument: (item: DocumentSummary) => void; onError: (error: unknown) => void;
};

function dateValue(value: string | null, end = false) {
  if (!value) return '';
  const date = new Date(value);
  if (end) date.setDate(date.getDate() - 1);
  return new Date(date.getTime() - date.getTimezoneOffset() * 60_000).toISOString().slice(0, 10);
}

function boundary(value: string, end = false) {
  if (!value) return null;
  const date = new Date(value + 'T00:00:00');
  if (end) date.setDate(date.getDate() + 1);
  return date.toISOString();
}

export function SpaceView({ project, projects, tags, documents, ready, transfer, setProject, createDocument, importDocuments, createTask, deleteDocument, onError }: Props) {
  const [query, setQuery] = useState('');
  const [options, setOptions] = useState<Options>(defaultFilters);
  const [advanced, setAdvanced] = useState(false);
  const [result, setResult] = useState<Set<string> | null>(null);
  const [searching, setSearching] = useState(false);
  const [formError, setFormError] = useState('');
  const active = Boolean(query.trim() || options.kind || options.tagIds.length || options.updatedFrom || options.updatedBefore);
  const activeCount = Number(Boolean(options.kind)) + options.tagIds.length + Number(Boolean(options.updatedFrom || options.updatedBefore)) + Number(options.includeBody);

  useEffect(() => {
    if (!active) { setResult(null); setSearching(false); return; }
    let current = true;
    setSearching(true);
    const timer = setTimeout(() => {
      void window.workspace.searchDocuments({ ...options, query: query.trim(), projectId: project })
        .then((ids) => { if (current) setResult(new Set(ids)); })
        .catch((error: unknown) => { if (current) onError(error); })
        .finally(() => { if (current) setSearching(false); });
    }, 120);
    return () => { current = false; clearTimeout(timer); };
  }, [active, project, options, query, documents]);

  const filtered = documents.filter((item) => (!project || item.projectId === project) && (!active || result?.has(item.id)));

  function apply(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const from = String(data.get('from') ?? '');
    const end = String(data.get('end') ?? '');
    if (from && end && from > end) { setFormError('开始日期不能晚于结束日期。'); return; }
    setProject(String(data.get('project') ?? '') || null);
    setOptions({
      kind: (String(data.get('kind') ?? '') || null) as Kind | null,
      includeBody: data.has('body'), tagIds: data.getAll('tag').map(String),
      updatedFrom: boundary(from), updatedBefore: boundary(end, true),
    });
    setAdvanced(false);
  }

  function clear() {
    setQuery('');
    setProject(null);
    setOptions(defaultFilters);
  }

  return <>
    <h1 className="sr-only">{projects.find((item) => item.id === project)?.name ?? '空间'}</h1>
    <div className="space-controls">
      <div className="filters">
        <label className="search"><Icon name="search" size={16} /><input aria-label="搜索资料" placeholder="搜索资料或标签" value={query} maxLength={250} onChange={(event) => setQuery(event.target.value)} /></label>
        <button className="button" aria-pressed={Boolean(activeCount)} onClick={() => { setFormError(''); setAdvanced(true); }}><Icon name="settings" size={16} />高级检索{activeCount > 0 ? ' · ' + activeCount : ''}</button>
      </div>
      <div className="actions">
        <button className="button" disabled={transfer} onClick={importDocuments}><Icon name="import" size={16} />导入资料</button>
        <button className="button primary" onClick={createDocument}><Icon name="plus" size={17} />新建文档</button>
      </div>
    </div>
    {ready && !filtered.length && !searching ? <Empty icon="space" title={active ? '没有符合条件的资料' : '这里还没有资料'}>
      {active ? <button className="button" onClick={clear}>清除筛选</button>
        : <button className="button" onClick={createDocument}><Icon name="plus" size={16} />新建文档</button>}
    </Empty> : <div className="file-list" aria-label="资料列表" aria-busy={searching}>
      {filtered.map((item) => <article key={item.id} className="file-row">
        <button className="file-open" aria-label={item.title} onClick={() => void window.workspace.openDocument({ documentId: item.id }).catch(onError)}>
          <span className={'file-icon ' + item.kind} title={kindLabels[item.kind]}><Icon name={kindIcon[item.kind]} size={20} /></span>
          <strong>{item.title}</strong>
        </button>
        <div className="file-actions">
          <button className="icon-button" title="添加任务" aria-label={'为' + item.title + '添加任务'} onClick={() => createTask(item)}><Icon name="taskAdd" size={17} /></button>
          <button className="icon-button danger-action" title="删除资料" aria-label={'删除资料 ' + item.title} onClick={() => deleteDocument(item)}><Icon name="trash" size={17} /></button>
        </div>
      </article>)}
    </div>}
    {advanced && <Modal title="高级检索" close={() => setAdvanced(false)}>
      <form className="form-stack" onSubmit={apply}>
        <div className="form-pair">
          <label>项目<select name="project" defaultValue={project ?? ''}><option value="">全部项目</option>{projects.map((item) => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>
          <label>资料类型<select name="kind" defaultValue={options.kind ?? ''}>
            <option value="">全部类型</option><option value="markdown">Markdown</option><option value="pdf">PDF</option><option value="image">图片</option>
          </select></label>
        </div>
        <div className="form-pair">
          <label>更新起始日期<input type="date" name="from" defaultValue={dateValue(options.updatedFrom)} /></label>
          <label>更新结束日期<input type="date" name="end" defaultValue={dateValue(options.updatedBefore, true)} /></label>
        </div>
        {tags.length > 0 && <fieldset className="tag-options"><legend>同时包含所选标签</legend><div className="task-dimensions">
          {tags.map((item) => <label key={item.id}><input type="checkbox" name="tag" value={item.id} defaultChecked={options.tagIds.includes(item.id)} />{item.name}</label>)}
        </div></fieldset>}
        <div className="task-dimensions"><label><input type="checkbox" name="body" defaultChecked={options.includeBody} />搜索关键词时同时检索 Markdown 正文</label></div>
        {formError && <p className="inline-error" role="alert">{formError}</p>}
        <footer className="form-actions"><button type="button" className="button" onClick={() => { clear(); setAdvanced(false); }}>清除筛选</button><button className="button primary">应用</button></footer>
      </form>
    </Modal>}
  </>;
}
