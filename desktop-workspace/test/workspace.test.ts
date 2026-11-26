import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { test } from 'node:test';
import { strFromU8, strToU8, unzipSync, zipSync } from 'fflate';
import { MarkdownPreferences } from '../src/main/markdown-preferences';
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, StandardFonts } from 'pdf-lib';
import { packWorkspace, remapWorkspace, unpackWorkspace } from '../src/main/archive';
import { annotatedPdf, markdownDocx, markdownPrintHtml } from '../src/main/exports';
import { Store } from '../src/main/store';

const deadline = '2026-11-26T00:00:00.000Z';
const anchor = { type: 'pdf', page: 1, rect: { x: .3, y: .25, width: .25, height: .1 } } as const;

test('a task follows its PDF annotation through renaming and import, including a second import', () => {
  const source = new Store(':memory:');
  const destination = new Store(':memory:');
  try {
    const project = source.createProject('产品设计');
    const asset = randomUUID();
    const doc = source.createDocument({ kind: 'pdf', title: '报告', projectId: project.id, markdown: null, mediaType: 'application/pdf', asset });
    const note = source.addAnnotation(doc.id, anchor, '核实数据来源');
    source.createTask({ title: '找出数据来源', important: true, urgent: false, deadline, projectId: null, source: { documentId: doc.id, annotationId: note.id } });
    source.updateDocument(doc.id, '调研报告', project.id);
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const archive = packWorkspace(source.manifest(), new Map([[asset, bytes]]));
    const unpacked = unpackWorkspace(archive);
    assert.deepEqual(unpacked.assets.get(asset), bytes);
    destination.importManifest(unpacked.manifest);
    assert.equal(destination.tasks()[0].sourceTitle, '调研报告');
    assert.equal(destination.tasks()[0].source?.annotationId, note.id);
    const copy = remapWorkspace(unpacked.manifest, true);
    destination.importManifest(copy);
    const migrated = destination.tasks().find((task) => task.id === copy.tasks[0].id)!;
    assert.notEqual(migrated.source?.documentId, doc.id);
    assert.equal(destination.annotations(migrated.source!.documentId)[0].id, migrated.source?.annotationId);
    assert.equal(destination.tasks().length, 2);
    assert.equal(destination.overview().documents.length, 2);
  } finally { source.close(); destination.close(); }
});

test('rolls back an incomplete import and restores Markdown as a new revision', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('工作');
    const original = store.createDocument({ kind: 'markdown', title: '草稿', projectId: project.id, markdown: '# 初稿', mediaType: null, asset: null });
    const updated = store.saveMarkdown(original.id, '# 修改后', 0);
    assert.throws(() => store.saveMarkdown(original.id, '# 旧窗口覆盖', 0), /已经|已存在/);
    const first = store.history(original.id).find((item) => item.revision === 0)!;
    const restored = store.restoreVersion(original.id, first.id, updated.revision);
    assert.equal(restored.revision, 2);
    assert.equal(restored.markdown, '# 初稿');
    assert.equal(store.version(original.id, store.history(original.id)[1].id).markdown, '# 修改后');
    const duplicate = store.manifest();
    duplicate.projects.unshift({ id: randomUUID(), name: '不得留下' });
    assert.throws(() => store.importManifest(duplicate));
    assert.deepEqual(store.overview().projects.map((item) => item.name), ['工作']);
  } finally { store.close(); }
});

test('manual labels survive automatic tag refresh and deadline remains the default order', () => {
  const store = new Store(':memory:');
  try {
    const doc = store.createDocument({ kind: 'markdown', title: '访谈', projectId: null, markdown: '访谈', mediaType: null, asset: null });
    store.setTags(doc.id, ['访谈'], false);
    store.setTags(doc.id, ['需求研究'], true);
    store.setTags(doc.id, ['访谈', '记录'], false);
    assert.deepEqual(store.document(doc.id).tags.map((tag) => tag.name), ['需求研究']);
    const noDeadline = store.createTask({ title: '无截止时间', important: true, urgent: false, deadline: null, projectId: null });
    const important = store.createTask({ title: '明天重要', important: true, urgent: false, deadline, projectId: null });
    const today = store.createTask({ title: '今天截止', important: false, urgent: false, deadline: '2026-11-25T00:00:00.000Z', projectId: null });
    const urgent = store.createTask({ title: '明天紧急', important: false, urgent: true, deadline, projectId: null });
    const automatic = [today.id, urgent.id, important.id, noDeadline.id];
    assert.deepEqual(store.tasks().map((task) => task.id), automatic);
    assert.deepEqual(store.reorderTasks([noDeadline.id, urgent.id]).map((task) => task.id), [today.id, noDeadline.id, important.id, urgent.id]);
    const imported = new Store(':memory:');
    try {
      const backup = unpackWorkspace(packWorkspace(store.manifest(), new Map()));
      imported.importManifest(backup.manifest);
      assert.deepEqual(imported.tasks().map((task) => task.id), [today.id, noDeadline.id, important.id, urgent.id]);
      assert.deepEqual(imported.resetTaskOrder().map((task) => task.id), automatic);
    } finally { imported.close(); }
  } finally { store.close(); }
});

test('advanced search combines body, project, type and all labels; deletion preserves related tasks', () => {
  const store = new Store(':memory:');
  try {
    const project = store.createProject('研发');
    const doc = store.createDocument({ kind: 'markdown', title: '周报', projectId: project.id, markdown: '需要回归的特殊场景', mediaType: null, asset: null });
    const unrelated = store.createDocument({ kind: 'markdown', title: '另一个周报', projectId: project.id, markdown: '特殊场景', mediaType: null, asset: null });
    store.setTags(doc.id, ['评审', '前端'], true);
    store.setTags(unrelated.id, ['评审'], true);
    const tags = store.document(doc.id).tags.map((tag) => tag.id);
    const query = { query: '特殊场景', projectId: project.id, kind: 'markdown', tagIds: tags, updatedFrom: null, updatedBefore: null } as const;
    assert.deepEqual(store.searchDocuments({ ...query, includeBody: false }), []);
    assert.deepEqual(store.searchDocuments({ ...query, includeBody: true }), [doc.id]);
    const task = store.createTask({ title: '回归', important: false, urgent: true, deadline: null, projectId: null, source: { documentId: doc.id } });
    store.deleteProject(project.id);
    assert.equal(store.document(doc.id).projectId, null);
    assert.equal(store.tasks()[0].projectId, null);
    store.deleteDocument(doc.id);
    assert.equal(store.tasks()[0].source, null);
    assert.equal(store.tasks()[0].id, task.id);
    assert.deepEqual(store.history(unrelated.id).map((item) => item.revision), [0]);
    assert.equal(store.manifest().versions.some((item) => item.documentId === doc.id), false);
  } finally { store.close(); }
});

test('opens the previous SQLite schema and upgrades legacy priorities without dropping tasks', async () => {
  const temp = resolve(tmpdir());
  const dir = await mkdtemp(join(temp, 'ydw-upgrade-'));
  const path = join(dir, 'legacy.sqlite');
  try {
    const prior = new DatabaseSync(path);
    const taskId = randomUUID();
    try {
      prior.exec(`
        CREATE TABLE documents(id TEXT PRIMARY KEY, title TEXT);
        CREATE TABLE tasks(id TEXT PRIMARY KEY, title TEXT, deadline TEXT, priority TEXT NOT NULL, done INTEGER,
          projectId TEXT, documentId TEXT, annotationId TEXT, sourceAnchor TEXT, createdAt TEXT);
        PRAGMA user_version=1;
      `);
      prior.prepare("INSERT INTO tasks VALUES (?, '旧任务', NULL, 'high', 0, NULL, NULL, NULL, NULL, ?)").run(taskId, deadline);
    } finally { prior.close(); }
    const upgraded = new Store(path);
    try {
      assert.deepEqual(upgraded.tasks().map(({ id, important, urgent }) => ({ id, important, urgent })), [{ id: taskId, important: true, urgent: false }]);
    } finally { upgraded.close(); }
  } finally {
    const child = relative(temp, dir);
    if (child.startsWith('ydw-upgrade-') && !isAbsolute(child)) await rm(dir, { recursive: true, force: true });
  }
});

test('imports version 1 backups with the legacy task priority mapped to importance', () => {
  const store = new Store(':memory:');
  try {
    const task = store.createTask({ title: '旧备份', deadline, important: true, urgent: false, projectId: null });
    const current = store.manifest();
    const legacy = { ...current, version: 1, tasks: [{ ...current.tasks[0], priority: 'high' }] };
    const { manifest } = unpackWorkspace(zipSync({ 'workspace.json': strToU8(JSON.stringify(legacy)) }));
    assert.equal(manifest.version, 2);
    assert.equal(manifest.tasks[0].id, task.id);
    assert.equal(manifest.tasks[0].important, true);
    assert.equal(manifest.tasks[0].urgent, false);
    assert.equal(manifest.tasks[0].position, null);
  } finally { store.close(); }
});

test('writes a native Unicode annotation without changing the original PDF', async () => {
  const pdf = await PDFDocument.create();
  const page = pdf.addPage([300, 500]);
  page.drawText('Report', { x: 50, y: 450, font: await pdf.embedFont(StandardFonts.Helvetica) });
  const original = await pdf.save();
  const result = await annotatedPdf(original, [{ id: randomUUID(), documentId: randomUUID(), anchor, text: '核实数据来源', createdAt: deadline }]);
  const parsed = await PDFDocument.load(result);
  const notes = parsed.getPage(0).node.lookup(PDFName.of('Annots'), PDFArray);
  const note = notes.lookup(0, PDFDict);
  assert.equal(note.get(PDFName.of('Subtype'))?.toString(), '/Text');
  assert.equal(note.lookup(PDFName.of('Contents'), PDFHexString).decodeText(), '核实数据来源');
  const clean = await PDFDocument.load(original);
  assert.equal(clean.getPage(0).node.lookupMaybe(PDFName.of('Annots'), PDFArray)?.size() ?? 0, 0);
});

test('produces a Word archive and renders printable Markdown with scripts and remote images excluded', async () => {
  const content = '# 报告\n\n正文和 **重点**\n\n<script>throw "untrusted"</script>\n\n![图](https://example.org/img.png)';
  const document = await markdownDocx('报告', content);
  assert.equal(document.subarray(0, 2).toString(), 'PK');
  const html = markdownPrintHtml('报告', content);
  assert.match(html, /<h1>报告<\/h1>/);
  assert.doesNotMatch(html, /<script|example\.org/);
});

test('persists Markdown layout and applies it to A4 Word and PDF output', async () => {
  const temp = resolve(tmpdir());
  const path = await mkdtemp(join(temp, 'ydw-layout-'));
  try {
    const prefs = new MarkdownPreferences(join(path, 'layout.json'));
    const layout = { fontSize: 18, lineHeight: 1.85, paragraphGap: 17, indentParagraphs: true };
    await prefs.save(layout);
    const reopened = new MarkdownPreferences(join(path, 'layout.json'));
    await reopened.load();
    assert.deepEqual(reopened.current(), layout);
    const files = unzipSync(await markdownDocx('排版', '正文', layout));
    const word = strFromU8(files['word/document.xml']);
    const size = /<w:pgSz w:w="(\d+)" w:h="(\d+)"/.exec(word);
    assert.ok(size);
    assert.ok(Math.abs(Number(size[1]) * 25.4 / 1440 - 210) < .1);
    assert.ok(Math.abs(Number(size[2]) * 25.4 / 1440 - 297) < .1);
    assert.match(word, /w:firstLine="540"/);
    assert.match(strFromU8(files['word/styles.xml']), /w:line="444"/);
    assert.match(strFromU8(files['word/styles.xml']), /w:after="255"/);
    const html = markdownPrintHtml('排版', '正文', layout);
    assert.match(html, /@page\{size:A4/);
    assert.match(html, /font:18px\/1\.85/);
    assert.match(html, /body>p\{text-indent:2em/);
  } finally {
    const child = relative(temp, path);
    if (child.startsWith('ydw-layout-') && !isAbsolute(child)) await rm(path, { recursive: true, force: true });
  }
});
