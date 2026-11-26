import { randomUUID } from 'node:crypto';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import type { Anchor, Annotation, DocumentSearch, DocumentSummary, Project, Tag, Task, TaskInput, Version, WorkspaceDocument } from '../shared/contracts';
import type { Manifest, StoredDocument } from '../shared/validation';

const now = () => new Date().toISOString();
const SOURCE_SELECT = 'SELECT t.*, d.title AS sourceTitle FROM tasks t LEFT JOIN documents d ON d.id=t.documentId';
const schema = `
  CREATE TABLE projects (id TEXT PRIMARY KEY, name TEXT NOT NULL);
  CREATE TABLE documents (
    id TEXT PRIMARY KEY, kind TEXT NOT NULL, title TEXT NOT NULL, projectId TEXT REFERENCES projects(id),
    updatedAt TEXT NOT NULL, revision INTEGER NOT NULL, markdown TEXT, mediaType TEXT, asset TEXT UNIQUE,
    tagsEdited INTEGER NOT NULL
  );
  CREATE TABLE tags (id TEXT PRIMARY KEY, name TEXT NOT NULL UNIQUE COLLATE NOCASE);
  CREATE TABLE document_tags (
    documentId TEXT NOT NULL REFERENCES documents(id), tagId TEXT NOT NULL REFERENCES tags(id),
    PRIMARY KEY (documentId, tagId)
  );
  CREATE TABLE versions (
    id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id), createdAt TEXT NOT NULL,
    revision INTEGER NOT NULL, markdown TEXT NOT NULL, UNIQUE(documentId, revision)
  );
  CREATE TABLE annotations (
    id TEXT PRIMARY KEY, documentId TEXT NOT NULL REFERENCES documents(id), anchor TEXT NOT NULL,
    text TEXT NOT NULL, createdAt TEXT NOT NULL
  );
  CREATE TABLE tasks (
    id TEXT PRIMARY KEY, title TEXT NOT NULL, deadline TEXT, priority TEXT NOT NULL, done INTEGER NOT NULL,
    projectId TEXT REFERENCES projects(id), documentId TEXT REFERENCES documents(id),
    annotationId TEXT REFERENCES annotations(id) ON DELETE SET NULL, sourceAnchor TEXT, createdAt TEXT NOT NULL
  );
  CREATE INDEX idx_documents_project ON documents(projectId);
  CREATE INDEX idx_annotations_document ON annotations(documentId, createdAt);
  CREATE INDEX idx_tasks_order ON tasks(done, deadline);
`;

type PersistedDocument = Omit<StoredDocument, 'tagsEdited'> & { tagsEdited: number };
type PersistedAnnotation = Omit<Annotation, 'anchor'> & { anchor: string };
type TaskRow = Omit<Task, 'source' | 'done' | 'important' | 'urgent'> & {
  documentId: string | null; annotationId: string | null; sourceAnchor: string | null; done: number; important: number; urgent: number;
};
const taskMigration = `
  ALTER TABLE tasks ADD COLUMN important INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN urgent INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE tasks ADD COLUMN position INTEGER;
  UPDATE tasks SET important=1 WHERE priority='high';
  ALTER TABLE tasks DROP COLUMN priority;
  PRAGMA user_version=2;
`;

export class Store {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    this.db = new DatabaseSync(path);
    this.db.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=4000');
    const { user_version } = this.one<{ user_version: number }>('PRAGMA user_version')!;
    if (user_version === 0) this.atomic(() => this.db.exec(schema + taskMigration));
    if (user_version === 1) this.atomic(() => this.db.exec(taskMigration));
    if (user_version > 2) throw new Error('数据库由较新版本创建，请使用对应版本打开。');
  }

  close() { this.db.close(); }

  private all<T>(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).all(...values) as unknown as T[]; }
  private one<T>(sql: string, ...values: SQLInputValue[]) { return this.db.prepare(sql).get(...values) as unknown as T | undefined; }
  private run(sql: string, ...values: SQLInputValue[]) { this.db.prepare(sql).run(...values); }

  private atomic<T>(callback: () => T): T {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      const result = callback();
      this.db.exec('COMMIT');
      return result;
    } catch (error) {
      this.db.exec('ROLLBACK');
      throw error;
    }
  }

  overview() {
    const tagsByDocument = new Map<string, Tag[]>();
    for (const { documentId, id, name } of this.all<Tag & { documentId: string }>(
      'SELECT dt.documentId, t.id, t.name FROM tags t JOIN document_tags dt ON dt.tagId=t.id ORDER BY t.name',
    )) {
      const tags = tagsByDocument.get(documentId) ?? [];
      tags.push({ id, name });
      tagsByDocument.set(documentId, tags);
    }
    const documents = this.all<Omit<DocumentSummary, 'tags'>>(
      'SELECT id, kind, title, projectId, updatedAt FROM documents ORDER BY updatedAt DESC, title',
    ).map((doc) => ({ ...doc, tags: tagsByDocument.get(doc.id) ?? [] }));
    return {
      projects: this.all<Project>('SELECT id, name FROM projects ORDER BY name'),
      tags: this.all<Tag>('SELECT id, name FROM tags WHERE id IN (SELECT tagId FROM document_tags) ORDER BY name'),
      documents,
    };
  }

  createProject(name: string): Project {
    const project = { id: randomUUID(), name };
    this.run('INSERT INTO projects VALUES (?, ?)', project.id, project.name);
    return project;
  }

  deleteProject(id: string) {
    this.atomic(() => {
      this.run('UPDATE documents SET projectId=NULL WHERE projectId=?', id);
      this.run('UPDATE tasks SET projectId=NULL WHERE projectId=?', id);
      this.run('DELETE FROM projects WHERE id=?', id);
    });
  }

  searchDocuments(filter: DocumentSearch) {
    const tags = [...new Set(filter.tagIds)];
    return this.all<{ id: string }>(`
      SELECT d.id FROM documents d
      WHERE (?1 IS NULL OR d.projectId=?1)
        AND (?2 IS NULL OR d.kind=?2)
        AND (?3 IS NULL OR d.updatedAt>=?3)
        AND (?4 IS NULL OR d.updatedAt<?4)
        AND (?5='' OR instr(lower(d.title),lower(?5))>0
          OR (?6=1 AND instr(lower(d.markdown),lower(?5))>0)
          OR EXISTS (SELECT 1 FROM document_tags dt JOIN tags t ON t.id=dt.tagId
            WHERE dt.documentId=d.id AND instr(lower(t.name),lower(?5))>0))
        AND (?7=0 OR (SELECT COUNT(*) FROM document_tags dt
          WHERE dt.documentId=d.id AND dt.tagId IN (SELECT value FROM json_each(?8)))=?7)
      ORDER BY d.updatedAt DESC, d.title
    `, filter.projectId, filter.kind, filter.updatedFrom, filter.updatedBefore, filter.query,
    Number(filter.includeBody), tags.length, JSON.stringify(tags)).map((row) => row.id);
  }

  storedDocument(id: string): StoredDocument {
    const result = this.one<PersistedDocument>('SELECT * FROM documents WHERE id=?', id);
    if (!result) throw new Error('找不到这份资料。');
    return { ...result, tagsEdited: Boolean(result.tagsEdited) };
  }

  document(id: string): WorkspaceDocument {
    const { asset: _asset, tagsEdited: _tagsEdited, ...document } = this.storedDocument(id);
    const tags = this.all<Tag>(
      'SELECT t.id,t.name FROM tags t JOIN document_tags dt ON t.id=dt.tagId WHERE dt.documentId=? ORDER BY t.name', id,
    );
    return { ...document, tags };
  }

  private insertDocument(doc: StoredDocument) {
    this.run('INSERT INTO documents VALUES (?,?,?,?,?,?,?,?,?,?)',
      doc.id, doc.kind, doc.title, doc.projectId, doc.updatedAt, doc.revision, doc.markdown, doc.mediaType, doc.asset, Number(doc.tagsEdited));
  }

  createDocument(input: Pick<StoredDocument, 'kind' | 'title' | 'projectId' | 'markdown' | 'mediaType' | 'asset'>) {
    const document: StoredDocument = { ...input, id: randomUUID(), updatedAt: now(), revision: 0, tagsEdited: false };
    this.atomic(() => {
      this.insertDocument(document);
      if (document.markdown !== null) this.snapshot(document.id, 0, document.markdown, document.updatedAt);
    });
    return this.document(document.id);
  }

  updateDocument(id: string, title: string, projectId: string | null) {
    this.storedDocument(id);
    this.atomic(() => {
      this.run('UPDATE documents SET title=?,projectId=?,updatedAt=? WHERE id=?', title, projectId, now(), id);
      this.run('UPDATE tasks SET projectId=? WHERE documentId=?', projectId, id);
    });
    return this.document(id);
  }

  deleteDocument(id: string) {
    const document = this.storedDocument(id);
    this.atomic(() => {
      this.run('UPDATE tasks SET documentId=NULL,annotationId=NULL,sourceAnchor=NULL WHERE documentId=?', id);
      for (const table of ['document_tags', 'versions', 'annotations']) {
        this.run('DELETE FROM ' + table + ' WHERE documentId=?', id);
      }
      this.run('DELETE FROM documents WHERE id=?', id);
    });
    return document.asset;
  }

  private snapshot(id: string, revision: number, markdown: string, date: string) {
    this.run('INSERT INTO versions VALUES (?,?,?,?,?)', randomUUID(), id, date, revision, markdown);
  }

  saveMarkdown(id: string, markdown: string, expected: number) {
    const previous = this.storedDocument(id);
    if (previous.kind !== 'markdown') throw new Error('此资料不能作为 Markdown 编辑。');
    if (previous.revision !== expected) throw new Error('已存在更新版本，请重新打开资料后再编辑。');
    if (previous.markdown === markdown) return this.document(id);
    this.atomic(() => {
      const revision = expected + 1;
      const date = now();
      this.run('UPDATE documents SET markdown=?,revision=?,updatedAt=? WHERE id=?', markdown, revision, date, id);
      this.snapshot(id, revision, markdown, date);
    });
    return this.document(id);
  }

  history(id: string) {
    this.storedDocument(id);
    return this.all<Omit<Version, 'markdown'>>('SELECT id,createdAt,revision FROM versions WHERE documentId=? ORDER BY revision DESC', id);
  }

  version(id: string, versionId: string) {
    const record = this.one<Version>('SELECT id,createdAt,revision,markdown FROM versions WHERE id=? AND documentId=?', versionId, id);
    if (!record) throw new Error('找不到这条历史记录。');
    return record;
  }

  restoreVersion(id: string, versionId: string, expected: number) {
    const version = this.version(id, versionId);
    return this.saveMarkdown(id, version.markdown, expected);
  }

  private attachTag(documentId: string, name: string) {
    this.run('INSERT INTO tags VALUES (?,?) ON CONFLICT(name) DO NOTHING', randomUUID(), name);
    this.run('INSERT OR IGNORE INTO document_tags SELECT ?, id FROM tags WHERE name=?', documentId, name);
  }

  setTags(id: string, names: string[], manual: boolean) {
    const document = this.storedDocument(id);
    if (!manual && document.tagsEdited) return this.document(id);
    this.atomic(() => {
      this.run('DELETE FROM document_tags WHERE documentId=?', id);
      for (const name of names) this.attachTag(id, name);
      if (manual) this.run('UPDATE documents SET tagsEdited=1 WHERE id=?', id);
    });
    return this.document(id);
  }

  annotations(id: string) {
    return this.all<PersistedAnnotation>('SELECT * FROM annotations WHERE documentId=? ORDER BY createdAt', id)
      .map((item) => ({ ...item, anchor: JSON.parse(item.anchor) as Anchor }));
  }

  addAnnotation(id: string, anchor: Anchor, text: string): Annotation {
    const document = this.storedDocument(id);
    if (document.kind !== anchor.type) throw new Error('批注位置与资料类型不匹配。');
    const item = { id: randomUUID(), documentId: id, anchor, text, createdAt: now() };
    this.insertAnnotation(item);
    return item;
  }

  private insertAnnotation(item: Annotation) {
    this.run('INSERT INTO annotations VALUES (?,?,?,?,?)', item.id, item.documentId, JSON.stringify(item.anchor), item.text, item.createdAt);
  }

  updateAnnotation(id: string, text: string) { this.run('UPDATE annotations SET text=? WHERE id=?', text, id); }
  deleteAnnotation(id: string) { this.run('DELETE FROM annotations WHERE id=?', id); }

  private readTask({ documentId, annotationId, sourceAnchor, done, important, urgent, ...task }: TaskRow): Task {
    return { ...task, important: Boolean(important), urgent: Boolean(urgent), done: Boolean(done), source: documentId ? {
      documentId, annotationId: annotationId ?? undefined, anchor: sourceAnchor ? JSON.parse(sourceAnchor) as Anchor : undefined,
    } : null };
  }

  tasks() {
    return this.all<TaskRow>(SOURCE_SELECT + `
      ORDER BY t.done, t.position IS NULL, t.position, t.deadline IS NULL, t.deadline,
      t.urgent DESC, t.important DESC, t.createdAt, t.id`).map((row) => this.readTask(row));
  }

  private task(id: string) {
    const row = this.one<TaskRow>(SOURCE_SELECT + ' WHERE t.id=?', id);
    if (!row) throw new Error('找不到这项任务。');
    return this.readTask(row);
  }

  createTask(input: TaskInput) {
    const document = input.source ? this.storedDocument(input.source.documentId) : null;
    if (input.source?.anchor && input.source.anchor.type !== document?.kind) throw new Error('任务来源与资料类型不匹配。');
    if (input.source?.annotationId && !this.one(
      'SELECT id FROM annotations WHERE id=? AND documentId=?', input.source.annotationId, input.source.documentId,
    )) throw new Error('原批注已不存在。');
    const task = { ...input, projectId: document ? document.projectId : input.projectId, id: randomUUID(), done: false, createdAt: now() };
    this.insertTask(task);
    return this.task(task.id);
  }

  private insertTask(task: TaskInput & { id: string; done: boolean; createdAt: string; position?: number | null }) {
    this.run(`INSERT INTO tasks
      (id,title,deadline,done,projectId,documentId,annotationId,sourceAnchor,createdAt,important,urgent,position)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`, task.id, task.title, task.deadline, Number(task.done),
      task.projectId, task.source?.documentId ?? null, task.source?.annotationId ?? null,
      task.source?.anchor ? JSON.stringify(task.source.anchor) : null, task.createdAt,
      Number(task.important), Number(task.urgent), task.position ?? null);
  }

  updateTask(id: string, input: Omit<TaskInput, 'source'>) {
    const current = this.task(id);
    this.run('UPDATE tasks SET title=?,deadline=?,important=?,urgent=?,projectId=? WHERE id=?',
      input.title, input.deadline, Number(input.important), Number(input.urgent), current.source ? current.projectId : input.projectId, id);
    return this.task(id);
  }

  toggleTask(id: string, done: boolean) { this.run('UPDATE tasks SET done=? WHERE id=?', Number(done), id); }
  deleteTask(id: string) { this.run('DELETE FROM tasks WHERE id=?', id); }

  reorderTasks(ids: string[]) {
    this.atomic(() => {
      const visible = new Set(ids);
      const tasks = this.tasks();
      const selection = tasks.filter((task) => visible.has(task.id));
      if (ids.length !== visible.size || selection.length !== ids.length
        || selection.some((task) => task.done !== selection[0]?.done)) throw new Error('任务列表已更新，请重新排序。');
      let next = 0;
      tasks.forEach((task, position) => this.run(
        'UPDATE tasks SET position=? WHERE id=?', position, visible.has(task.id) ? ids[next++] : task.id,
      ));
    });
    return this.tasks();
  }

  resetTaskOrder() {
    this.run('UPDATE tasks SET position=NULL WHERE position IS NOT NULL');
    return this.tasks();
  }

  manifest(): Manifest {
    return {
      format: 'ydw-workspace', version: 2,
      projects: this.all<Project>('SELECT * FROM projects'),
      documents: this.all<PersistedDocument>('SELECT * FROM documents').map((doc) => ({ ...doc, tagsEdited: Boolean(doc.tagsEdited) })),
      documentTags: this.all<Manifest['documentTags'][number]>(
        'SELECT dt.documentId,t.name FROM document_tags dt JOIN tags t ON t.id=dt.tagId',
      ),
      versions: this.all<Manifest['versions'][number]>('SELECT * FROM versions'),
      annotations: this.all<PersistedAnnotation>('SELECT * FROM annotations').map((item) => ({ ...item, anchor: JSON.parse(item.anchor) as Anchor })),
      tasks: this.tasks().map(({ sourceTitle: _sourceTitle, ...task }) => ({ ...task, source: task.source ?? undefined })),
    };
  }

  hasData() { return Boolean(this.one('SELECT id FROM documents UNION ALL SELECT id FROM projects UNION ALL SELECT id FROM tasks LIMIT 1')); }

  importManifest(manifest: Manifest) {
    this.atomic(() => {
      const start = this.one<{ start: number }>('SELECT COALESCE(MAX(position) + 1, 0) AS start FROM tasks')!.start;
      for (const project of manifest.projects) this.run('INSERT INTO projects VALUES (?,?)', project.id, project.name);
      for (const document of manifest.documents) this.insertDocument(document);
      for (const item of manifest.documentTags) this.attachTag(item.documentId, item.name);
      for (const version of manifest.versions) this.run('INSERT INTO versions VALUES (?,?,?,?,?)',
        version.id, version.documentId, version.createdAt, version.revision, version.markdown);
      for (const item of manifest.annotations) this.insertAnnotation(item);
      for (const task of manifest.tasks) this.insertTask({
        ...task, position: task.position === null ? null : start + task.position,
      });
    });
  }
}
