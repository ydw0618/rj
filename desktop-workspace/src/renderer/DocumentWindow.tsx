import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState, type FormEvent } from 'react';
import type { Anchor, Annotation, DocumentFormat, Project, Source, Version, WorkspaceDocument } from '../shared/contracts';
import type { Heading, MarkdownHandle } from './MarkdownEditor';
import type { PdfHandle } from './PdfViewer';
import { useDraft } from './useDraft';
import { Outline } from './Outline';
import { layoutStyle, MarkdownLayoutSettings } from './MarkdownLayoutSettings';
import { defaultMarkdownLayout } from '../shared/contracts';
import { dateLabel, Empty, errorMessage, Icon, Modal, Notice, TaskForm, useNotice } from './ui';

const MarkdownEditor = lazy(async () => ({ default: (await import('./MarkdownEditor')).MarkdownEditor }));
const PdfViewer = lazy(async () => ({ default: (await import('./PdfViewer')).PdfViewer }));
type HistoryItem = Omit<Version, 'markdown'>;

function ImageViewer({ item, onError }: { item: WorkspaceDocument; onError: (error: unknown) => void }) {
  const [url, setUrl] = useState('');
  const failure = useRef(onError);
  failure.current = onError;
  useEffect(() => {
    let active = true;
    let link: string | undefined;
    void window.workspace.asset(item.id).then((bytes) => {
      if (!active) return;
      link = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: item.mediaType ?? undefined }));
      setUrl(link);
    }).catch((error) => { if (active) failure.current(error); });
    return () => { active = false; if (link) URL.revokeObjectURL(link); };
  }, [item.id, item.mediaType]);
  return <div className="image-viewer">{url ? <img src={url} alt={item.title} /> : <span className="loading">正在打开图片…</span>}</div>;
}

export function DocumentWindow({ id, initialAnnotation, initialAnchor }: { id: string; initialAnnotation: string | null; initialAnchor: Anchor | null }) {
  const [item, setItem] = useState<WorkspaceDocument | null>(null);
  const [projects, setProjects] = useState<Project[]>([]);
  const [annotations, setAnnotations] = useState<Annotation[]>([]);
  const [headings, setHeadings] = useState<Heading[]>([]);
  const [selection, setSelection] = useState<Anchor | null>(null);
  const [follow, setFollow] = useState<Anchor | null>(initialAnchor);
  const [selectedId, setSelectedId] = useState<string | null>(initialAnnotation);
  const [waiting, setWaiting] = useState(Boolean(initialAnnotation || initialAnchor));
  const [editorReady, setEditorReady] = useState(false);
  const [layout, setLayout] = useState(defaultMarkdownLayout);
  const [layoutSettings, setLayoutSettings] = useState(false);
  const [metadata, setMetadata] = useState(false);
  const [editNote, setEditNote] = useState<{ anchor: Anchor; existing?: Annotation } | null>(null);
  const [createTask, setCreateTask] = useState<{ source: Source; title?: string } | null>(null);
  const [removeNote, setRemoveNote] = useState<Annotation | null>(null);
  const [removeDocument, setRemoveDocument] = useState(false);
  const [history, setHistory] = useState<HistoryItem[] | null>(null);
  const [historyItem, setHistoryItem] = useState<Version | null>(null);
  const [busy, setBusy] = useState(false);
  const [formError, setFormError] = useState('');
  const [loadError, setLoadError] = useState('');
  const [path, setPath] = useState('');
  const [anchorPosition, setAnchorPosition] = useState<{ x: number; y: number } | null>(null);
  const editor = useRef<MarkdownHandle>(null);
  const pdf = useRef<PdfHandle>(null);
  const grid = useRef<HTMLDivElement>(null);
  const cards = useRef<HTMLDivElement>(null);
  const notice = useNotice();
  const draft = useDraft(setItem, () => editorReady ? editor.current?.read() : undefined);
  const selected = annotations.find((entry) => entry.id === selectedId);

  useEffect(() => {
    if (item?.kind !== 'markdown') return;
    let active = true;
    let updated = false;
    const dispose = window.workspace.onMarkdownLayoutChange((value) => { updated = true; setLayout(value); });
    void window.workspace.markdownLayout().then((value) => { if (active && !updated) setLayout(value); })
      .catch((error: unknown) => { if (active) notice.failure(error); });
    return () => { active = false; dispose(); };
  }, [item?.kind]);

  useEffect(() => {
    let alive = true;
    void Promise.all([window.workspace.document(id), window.workspace.annotations(id), window.workspace.overview()])
      .then(([document, notes, space]) => {
        if (!alive) return;
        draft.initialize(document);
        setItem(document);
        setAnnotations(notes);
        setProjects(space.projects);
        window.document.title = document.title + ' · 工作空间';
      }).catch((error) => { if (alive) setLoadError(errorMessage(error)); });
    return () => { alive = false; };
  }, [id, draft.initialize]);

  const navigate = useCallback((source: Source) => {
    setSelectedId(source.annotationId ?? null);
    setFollow(source.anchor ?? null);
    setWaiting(Boolean(source.annotationId || source.anchor));
  }, []);

  useEffect(() => window.workspace.onOpenSource(navigate), [navigate]);

  useEffect(() => {
    if (!waiting || !item) return;
    const anchor = selected?.anchor ?? follow;
    if (!anchor) {
      setWaiting(false);
      return;
    }
    if (anchor.type === 'markdown') {
      if (!editorReady) return;
      if (!editor.current?.goto(anchor)) notice.failure('原文已修改，当前版本无法定位这段文字。');
    } else {
      pdf.current?.goto(anchor);
    }
    setWaiting(false);
  }, [waiting, item, selected, follow, editorReady]);

  function selectNote(note: Annotation) {
    setSelectedId(note.id);
    setFollow(null);
    setWaiting(true);
    requestAnimationFrame(() => cards.current?.querySelector('[data-note="' + note.id + '"]')?.scrollIntoView({ block: 'nearest' }));
  }

  const position = useCallback(() => {
    const anchor = selected?.anchor ?? follow;
    const panel = grid.current;
    if (anchor?.type !== 'markdown' || !panel || !editor.current) {
      setPath(''); setAnchorPosition(null); return;
    }
    const range = editor.current.range(anchor);
    const rect = range?.getClientRects()[0];
    const card = selected && cards.current?.querySelector('[data-note="' + selected.id + '"]')?.getBoundingClientRect();
    const box = panel.getBoundingClientRect();
    if (!rect || rect.bottom < box.top || rect.top > box.bottom) {
      setPath(''); setAnchorPosition(null); return;
    }
    const x = rect.right - box.left;
    const y = rect.top + rect.height / 2 - box.top;
    setAnchorPosition((previous) => previous?.x === x && previous.y === y ? previous : { x, y });
    if (card && card.bottom >= box.top && card.top <= box.bottom) {
      const end = card.left - box.left;
      const y2 = card.top + Math.min(22, card.height / 2) - box.top;
      setPath('M ' + x + ' ' + y + ' C ' + (x + 32) + ' ' + y + ', ' + (end - 32) + ' ' + y2 + ', ' + end + ' ' + y2);
    } else setPath('');
  }, [selected, follow]);

  useLayoutEffect(() => {
    let frame = 0;
    const onMove = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        position();
      });
    };
    onMove();
    window.addEventListener('resize', onMove, { passive: true });
    window.addEventListener('scroll', onMove, { passive: true, capture: true });
    return () => {
      cancelAnimationFrame(frame);
      window.removeEventListener('resize', onMove);
      window.removeEventListener('scroll', onMove, true);
    };
  }, [position, headings, editorReady, annotations, layout]);

  async function refreshNotes() { setAnnotations(await window.workspace.annotations(id)); }

  function action(operation: () => Promise<void>) {
    setBusy(true);
    setFormError('');
    void operation().catch((error) => { setFormError(errorMessage(error)); notice.failure(error); }).finally(() => setBusy(false));
  }

  function saveMetadata(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    const title = String(data.get('title')).trim();
    const nextProject = String(data.get('project')) || null;
    const nextTags = Array.from(new Set(String(data.get('tags')).split(/[,，、]/).map((name) => name.trim()).filter(Boolean)));
    if (!title) { setFormError('请输入标题。'); return; }
    action(async () => {
      await draft.flush();
      let latest = await window.workspace.updateDocument(id, title, nextProject);
      if (nextTags.join(',') !== item?.tags.map((tag) => tag.name).join(',')) {
        latest = { ...latest, ...await window.workspace.setTags(id, nextTags) };
      }
      setItem(latest);
      window.document.title = latest.title + ' · 工作空间';
      setMetadata(false);
    });
  }

  function saveNote(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const text = String(new FormData(event.currentTarget).get('text')).trim();
    const pending = editNote;
    if (!pending || !text) { setFormError('请输入批注内容。'); return; }
    action(async () => {
      await draft.flush();
      const note = pending.existing;
      if (note) await window.workspace.updateAnnotation(note.id, text);
      else {
        const created = await window.workspace.addAnnotation(id, pending.anchor, text);
        setSelectedId(created.id);
      }
      setFollow(null);
      await refreshNotes();
      window.getSelection()?.removeAllRanges();
      setSelection(null);
      setEditNote(null);
    });
  }

  function runExport(selectedFormat: DocumentFormat) {
    action(async () => {
      await draft.flush();
      if (await window.workspace.exportDocument(id, selectedFormat)) notice.success('资料已导出。');
    });
  }

  function openHistory() {
    action(async () => { await draft.flush(); setHistory(await window.workspace.history(id)); setHistoryItem(null); });
  }

  function openMetadata() {
    action(async () => {
      const [document, space] = await Promise.all([window.workspace.document(id), window.workspace.overview()]);
      setItem((current) => current && { ...current, title: document.title, projectId: document.projectId, tags: document.tags });
      setProjects(space.projects);
      setMetadata(true);
    });
  }

  if (!item) return <main className="document-shell">{loadError
    ? <Empty icon="doc" title={loadError}><button className="button" onClick={() => window.close()}>关闭窗口</button></Empty>
    : <div className="loading">正在打开资料…</div>}</main>;

  const exportItems: [DocumentFormat, string][] = item.kind === 'markdown'
    ? [['md', 'Markdown (.md)'], ['docx', 'Word (.docx)'], ['pdf', 'PDF']]
    : item.kind === 'pdf' ? [['original', '原始 PDF'], ['annotated-pdf', '带批注的 PDF']] : [['original', '原始图片']];
  const notePanel = item.kind !== 'image';
  const openTaskFrom = (anchor: Anchor | null) => setCreateTask({
    source: { documentId: id, anchor: anchor ?? undefined }, title: anchor?.quote?.trim().slice(0, 150),
  });
  return <div className="document-shell" style={item.kind === 'markdown' ? layoutStyle(layout) : undefined}>
    <h1 className="sr-only">{item.title}</h1>
    {item.kind !== 'markdown' && <header className="document-header document-actions" aria-label="资料操作">
      <div className="actions">
        <button className="button compact" onClick={() => openTaskFrom(selection)}><Icon name="task" size={16} />创建任务</button>
        <details className="dropdown"><summary className="button compact"><Icon name="export" size={16} />导出</summary>
          <div className="dropdown-content">{exportItems.map(([type, label]) => <button key={type} disabled={busy} onClick={(event) => {
            event.currentTarget.closest('details')?.removeAttribute('open'); runExport(type);
          }}>{label}</button>)}</div>
        </details>
        <button className="icon-button" aria-label="资料设置" disabled={busy} onClick={openMetadata}><Icon name="settings" /></button>
      </div>
    </header>}
    {draft.error && <div className="save-error" role="alert">{draft.error}<button className="text-button" onClick={() => void draft.flush().catch(notice.failure)}>重试保存</button></div>}
    <div ref={grid} className={'document-body ' + (item.kind === 'markdown' ? 'markdown-layout' : notePanel ? 'pdf-layout' : 'image-layout')}>
      {item.kind === 'markdown' && <Outline headings={headings} />}
      <main className="document-canvas">
        <Suspense fallback={<div className="loading">正在加载编辑器…</div>}>
          {item.kind === 'markdown' && <MarkdownEditor initial={item.markdown ?? ''} handle={editor}
            onChange={draft.change} onHeadings={setHeadings} onSelection={setSelection} onReady={() => setEditorReady(true)}
            documentActions={(anchor) => [
              { label: '添加批注', disabled: !anchor, run: () => { if (anchor) { setFormError(''); setEditNote({ anchor }); } } },
              { label: '创建任务', run: () => openTaskFrom(anchor) },
              { label: '编辑历史', disabled: busy, run: openHistory },
              { label: '排版设置', run: () => setLayoutSettings(true) },
              ...exportItems.map(([type, label]) => ({ label: '导出 ' + label, disabled: busy, run: () => runExport(type) })),
              { label: '资料设置', run: openMetadata },
              { label: '删除资料', danger: true, run: () => setRemoveDocument(true) },
            ]} />}
          {item.kind === 'pdf' && <PdfViewer id={id} annotations={annotations} active={selectedId} handle={pdf}
            selection={selection?.type === 'pdf' ? selection : null}
            follow={(selected?.anchor ?? follow)?.type === 'pdf' ? (selected?.anchor ?? follow) as Extract<Anchor, { type: 'pdf' }> : null}
            onSelection={setSelection} onActivate={selectNote} onError={notice.failure} />}
          {item.kind === 'image' && <ImageViewer item={item} onError={notice.failure} />}
        </Suspense>
      </main>
      {notePanel && <aside className="annotation-panel">
        <header><div><h2>批注</h2><span className="heading-count">{annotations.length}</span></div>
          <button className="icon-button" aria-label="添加批注" title={selection ? '添加批注' : '先选中文字或区域'} disabled={!selection}
            onClick={() => { if (selection) { setFormError(''); setEditNote({ anchor: selection }); } }}><Icon name="plus" size={17} /></button></header>
        <div className="note-list" ref={cards}>
          {selection && <button className="button primary selection-action" onClick={() => { setFormError(''); setEditNote({ anchor: selection }); }}><Icon name="note" size={16} />批注所选内容</button>}
          {!annotations.length && <p className="annotation-hint">{item.kind === 'markdown' ? '选中正文后添加批注。' : '选中文字，或使用「区域批注」圈选。'}</p>}
          {annotations.map((note) => <article key={note.id} data-note={note.id} className={'note-card ' + (selectedId === note.id ? 'active' : '')}>
            <button className="note-content" onClick={() => selectNote(note)}>
              <span>{note.anchor.type === 'pdf' ? '第 ' + note.anchor.page + ' 页' : '正文批注'}</span>
              <strong>{note.text}</strong>
              {note.anchor.quote && <small>{note.anchor.quote}</small>}
            </button>
            <div className="note-actions">
              <button className="text-button" onClick={() => setCreateTask({ source: { documentId: id, annotationId: note.id }, title: note.text.slice(0, 150) })}>创建任务</button>
              <button className="text-button" onClick={() => { setFormError(''); setEditNote({ anchor: note.anchor, existing: note }); }}>编辑</button>
              <button className="text-button" onClick={() => setRemoveNote(note)}>删除</button>
            </div>
          </article>)}
        </div>
      </aside>}
      {item.kind === 'markdown' && anchorPosition && <svg className="connector" aria-hidden="true"><path d={path} /><circle cx={anchorPosition.x} cy={anchorPosition.y} r="3.5" /></svg>}
    </div>
    {metadata && <Modal title="资料设置" close={() => { if (!busy) setMetadata(false); }}><form className="form-stack" onSubmit={saveMetadata}>
      <label>资料标题<input name="title" defaultValue={item.title} maxLength={150} required autoFocus /></label>
      <label>项目<select name="project" defaultValue={item.projectId ?? ''}><option value="">无项目</option>{projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}</select></label>
      <label>标签<input name="tags" defaultValue={item.tags.map((tag) => tag.name).join('，')} placeholder="用逗号分隔" /></label>
      {formError && <p className="inline-error" role="alert">{formError}</p>}
      <footer className="form-actions"><button type="button" className="button" onClick={() => setMetadata(false)} disabled={busy}>取消</button><button className="button primary" disabled={busy}>保存</button></footer>
    </form></Modal>}
    {editNote && <Modal title={editNote.existing ? '编辑批注' : '添加批注'} close={() => { if (!busy) setEditNote(null); }}><form className="form-stack" onSubmit={saveNote}>
      {editNote.anchor.quote && <blockquote className="excerpt">{editNote.anchor.quote}</blockquote>}
      <label>批注内容<textarea name="text" defaultValue={editNote.existing?.text ?? ''} required autoFocus rows={5} maxLength={12_000} /></label>
      {formError && <p className="inline-error" role="alert">{formError}</p>}
      <footer className="form-actions"><button type="button" className="button" onClick={() => setEditNote(null)} disabled={busy}>取消</button><button className="button primary" disabled={busy}>保存批注</button></footer>
    </form></Modal>}
    {createTask && <TaskForm source={createTask.source} title={createTask.title} projects={projects} projectId={item.projectId} close={() => setCreateTask(null)}
      submit={async (input) => { await draft.flush(); await window.workspace.createTask(input); notice.success('任务已创建。'); }} />}
    {removeNote && <Modal title="删除批注" close={() => setRemoveNote(null)}><div className="form-stack">
      <p>删除后，关联任务仍可打开原资料。</p>
      <footer className="form-actions"><button className="button" onClick={() => setRemoveNote(null)}>取消</button><button className="button destructive" disabled={busy}
        onClick={() => action(async () => {
          await window.workspace.deleteAnnotation(removeNote.id);
          if (selectedId === removeNote.id) setSelectedId(null);
          setRemoveNote(null); await refreshNotes();
        })}>删除</button></footer>
    </div></Modal>}
    {removeDocument && <Modal title="删除资料" close={() => { if (!busy) setRemoveDocument(false); }}><div className="form-stack">
      <p>删除「{item.title}」及其批注和历史？关联任务会保留，来源链接将移除。</p>
      <footer className="form-actions"><button className="button" disabled={busy} onClick={() => setRemoveDocument(false)}>取消</button>
        <button className="button destructive" disabled={busy} onClick={() => action(() => window.workspace.deleteDocument(id))}>删除</button></footer>
    </div></Modal>}
    {history && <Modal title="编辑历史" wide close={() => { if (!busy) setHistory(null); }}>
      <div className="history-view">
        <nav aria-label="历史版本">{history.map((version) => <button className={historyItem?.id === version.id ? 'selected' : ''} key={version.id}
          onClick={() => action(async () => setHistoryItem(await window.workspace.version(id, version.id)))}>
          <strong>版本 {version.revision + 1}</strong><span>{dateLabel(version.createdAt)}</span></button>)}</nav>
        <pre>{historyItem?.markdown ?? '选择一个历史版本查看内容。'}</pre>
      </div>
      <footer className="form-actions padded"><button className="button" onClick={() => setHistory(null)} disabled={busy}>关闭</button>
        <button className="button primary" disabled={!historyItem || busy || historyItem.revision === item.revision} onClick={() => {
          if (!historyItem) return;
          action(async () => {
            await draft.flush();
            const restored = await window.workspace.restoreVersion(id, historyItem.id, draft.revision());
            draft.initialize(restored);
            await editor.current?.replace(restored.markdown ?? '');
            setItem(restored);
            setHistory(null);
            notice.success('已恢复为新版本。');
          });
        }}>恢复为新版本</button></footer>
    </Modal>}
    {layoutSettings && <MarkdownLayoutSettings close={() => setLayoutSettings(false)} />}
    <Notice message={notice.message} clear={notice.clear} />
  </div>;
}
