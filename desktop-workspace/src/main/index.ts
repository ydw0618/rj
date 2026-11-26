import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { app, BrowserWindow, dialog, ipcMain, net, protocol, safeStorage, screen, type IpcMainInvokeEvent } from 'electron';
import { z } from 'zod';
import { Store } from './store';
import { MarkdownPreferences } from './markdown-preferences';
import { WorkspaceFiles } from './files';
import { runJob } from './jobs';
import { AffineView } from './affine-view';
import * as value from '../shared/validation';
import type { ChatMessage, DocumentFormat, Source, WorkspaceDocument } from '../shared/contracts';

protocol.registerSchemesAsPrivileged([{
  scheme: 'workspace-asset',
  privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true },
}]);

const format = z.enum(['md', 'docx', 'pdf', 'annotated-pdf', 'original']);
const settingsSchema = z.object({ model: z.string().min(1).max(100), secret: z.string().optional() });
const chatResult = z.object({ choices: z.array(z.object({ message: z.object({ content: z.string() }) })).min(1) });
const asMessage = (error: unknown) => error instanceof Error ? error.message : String(error);
const documents = new Map<string, BrowserWindow>();
const workspaceWindows = new Set<BrowserWindow>();
const closing = new Set<number>();
const flushes = new Map<string, { sender: number; complete: (error?: string) => void }>();
const tagTimers = new Map<string, ReturnType<typeof setTimeout>>();
let main: BrowserWindow | null = null;
let affine: AffineView | null = null;
let store: Store;
let files: WorkspaceFiles;
let markdownPreferences: MarkdownPreferences;
let quitting = false;

function load(window: BrowserWindow, query: Record<string, string>) {
  if (process.env.ELECTRON_RENDERER_URL) {
    const url = new URL(process.env.ELECTRON_RENDERER_URL);
    for (const [key, item] of Object.entries(query)) url.searchParams.set(key, item);
    return window.loadURL(url.toString());
  }
  return window.loadFile(join(__dirname, '../renderer/index.html'), { query });
}

function createWindow(title: string, width: number, height: number, minWidth = 640) {
  const window = new BrowserWindow({
    title, width, height, minWidth, minHeight: 480, show: false, autoHideMenuBar: true,
    backgroundColor: '#f7f8fb', icon: join(app.getAppPath(), 'assets', 'workspace.png'),
    webPreferences: { preload: join(__dirname, '../preload/index.js'), contextIsolation: true, sandbox: true, nodeIntegration: false },
  });
  workspaceWindows.add(window);
  window.once('closed', () => workspaceWindows.delete(window));
  window.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
  window.webContents.on('will-navigate', (event) => event.preventDefault());
  window.once('ready-to-show', () => window.show());
  return window;
}

function focus(window: BrowserWindow) {
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

function openMain() {
  if (main && !main.isDestroyed()) return focus(main);
  const window = createWindow('工作空间', 1180, 790, 780);
  main = window;
  affine = new AffineView(window);
  window.once('closed', () => {
    if (main === window) { main = null; affine = null; }
  });
  void load(window, { view: 'workspace' }).catch((error) => dialog.showErrorBox('无法打开工作空间', asMessage(error)));
}


function flushDocument(window: BrowserWindow): Promise<void> {
  if (window.isDestroyed() || window.webContents.isLoadingMainFrame()) return Promise.resolve();
  return new Promise((resolvePromise, reject) => {
    const ticket = randomUUID();
    const complete = (error?: string) => {
      clearTimeout(timeout);
      flushes.delete(ticket);
      window.removeListener('closed', closed);
      if (error) reject(new Error(error));
      else resolvePromise();
    };
    const closed = () => complete('资料窗口意外关闭。');
    const timeout = setTimeout(() => complete('等待保存超时，请稍后再试。'), 12_000);
    flushes.set(ticket, { sender: window.webContents.id, complete });
    window.once('closed', closed);
    window.webContents.send('workspace:flush', ticket);
  });
}

function openDocument(source: Source) {
  const document = store.document(source.documentId);
  const existing = documents.get(document.id);
  if (existing && !existing.isDestroyed()) {
    focus(existing);
    if (existing.webContents.isLoading()) existing.webContents.once('did-finish-load', () => existing.webContents.send('workspace:source', source));
    else existing.webContents.send('workspace:source', source);
    return;
  }
  const area = main ? screen.getDisplayMatching(main.getBounds()).workAreaSize : screen.getPrimaryDisplay().workAreaSize;
  const width = document.kind === 'markdown' ? 1280 : 1100;
  const window = createWindow(document.title + ' · 工作空间', Math.min(width, area.width), Math.min(780, area.height), 680);
  documents.set(document.id, window);
  window.once('closed', () => documents.delete(document.id));
  if (document.kind === 'markdown') {
    const windowId = window.id;
    const closeAfterSaving = (event: Electron.Event) => {
      if (quitting) return;
      event.preventDefault();
      if (closing.has(windowId)) return;
      closing.add(windowId);
      void flushDocument(window).then(
        () => {
          if (window.isDestroyed()) return;
          window.removeListener('close', closeAfterSaving);
          window.close();
        },
        (error) => dialog.showErrorBox('文档尚未关闭', asMessage(error)),
      ).finally(() => closing.delete(windowId));
    };
    window.on('close', closeAfterSaving);
  }
  const query: Record<string, string> = { view: 'document', id: document.id };
  if (source.annotationId) query.annotation = source.annotationId;
  if (source.anchor) query.anchor = JSON.stringify(source.anchor);
  void load(window, query).catch((error) => dialog.showErrorBox('无法打开资料', asMessage(error)));
}

function broadcast() {
  for (const window of workspaceWindows) {
    if (!window.isDestroyed() && window.webContents.getURL()) window.webContents.send('workspace:changed');
  }
}

function scheduleTags(document: WorkspaceDocument) {
  const previous = tagTimers.get(document.id);
  if (previous) clearTimeout(previous);
  const source = document.markdown ?? '';
  tagTimers.set(document.id, setTimeout(() => {
    tagTimers.delete(document.id);
    if (store.storedDocument(document.id).tagsEdited) return;
    void runJob<string[]>({ type: 'tags', title: document.title, markdown: source.slice(0, 12_000) }).then((tags) => {
      const current = store.storedDocument(document.id);
      if (current.revision === document.revision && current.title === document.title && !current.tagsEdited) {
        store.setTags(document.id, tags, false);
        broadcast();
      }
    }).catch((error) => console.error('Tag generation failed:', asMessage(error)));
  }, 700));
}

function windowFor(event: IpcMainInvokeEvent) {
  const window = BrowserWindow.fromWebContents(event.sender);
  if (!window || !workspaceWindows.has(window) || window.isDestroyed() || event.senderFrame !== event.sender.mainFrame) {
    throw new Error('窗口不可用。');
  }
  return window;
}

function handle(channel: string, operation: (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
  ipcMain.handle('workspace:' + channel, (event, ...args: unknown[]) => {
    windowFor(event);
    return operation(event, ...args);
  });
}

function changed<T>(result: T): T {
  broadcast();
  return result;
}

const settingsFile = () => join(app.getPath('userData'), 'chat-settings.json');

async function readSettings() {
  try { return settingsSchema.parse(JSON.parse(await readFile(settingsFile(), 'utf8'))); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    return { model: 'deepseek-flash', secret: undefined };
  }
}

async function updateSettings(model: string, key?: string) {
  const existing = await readSettings();
  if (key !== undefined && key && !safeStorage.isEncryptionAvailable()) throw new Error('当前 Windows 账户无法安全保存 API 密钥。');
  const secret = key === undefined ? existing.secret : key ? safeStorage.encryptString(key).toString('base64') : undefined;
  const temporary = settingsFile() + '.' + randomUUID() + '.tmp';
  try {
    await writeFile(temporary, JSON.stringify({ model, secret }), { flag: 'wx' });
    await rename(temporary, settingsFile());
  } finally {
    await rm(temporary, { force: true });
  }
}

async function sendChat(messages: ChatMessage[]) {
  const { model, secret } = await readSettings();
  if (!secret) throw new Error('请先设置 DeepSeek API 密钥。');
  const response = await fetch('https://api.deepseek.com/chat/completions', {
    method: 'POST', signal: AbortSignal.timeout(90_000),
    headers: { Authorization: 'Bearer ' + safeStorage.decryptString(Buffer.from(secret, 'base64')), 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, messages, stream: false }),
  });
  if (!response.ok) throw new Error('DeepSeek 请求失败（' + response.status + '）。请检查密钥、模型名称或余额。');
  return chatResult.parse(await response.json()).choices[0].message.content;
}

function extensionFor(document: WorkspaceDocument, selected: DocumentFormat) {
  if (selected !== 'original') return selected === 'annotated-pdf' ? 'pdf' : selected;
  return document.mediaType === 'image/jpeg' ? 'jpg' : document.mediaType?.split('/')[1] ?? 'md';
}

function registerHandlers() {
  const pixel = z.int().min(0).max(32768);
  const affineBounds = z.object({ x: pixel, y: pixel, width: pixel, height: pixel }).nullable();
  handle('setAffineBounds', (event, bounds) => {
    if (!affine || windowFor(event) !== main) throw new Error('AFFiNE 只能在主窗口打开。');
    return affine.setBounds(affineBounds.parse(bounds));
  });
  handle('reloadAffine', (event) => {
    if (!affine || windowFor(event) !== main) throw new Error('AFFiNE 只能在主窗口打开。');
    affine.reload();
  });
  handle('openAffineInBrowser', (event) => {
    if (!affine || windowFor(event) !== main) throw new Error('AFFiNE 只能在主窗口打开。');
    return affine.openInBrowser();
  });
  const project = value.id.nullable();
  const revision = z.int().min(0);
  const tags = z.array(value.name.max(36)).max(30);
  const metadata = value.taskInput.omit({ source: true });
  handle('overview', () => store.overview());
  handle('searchDocuments', (_event, search) => store.searchDocuments(value.documentSearch.parse(search)));
  handle('createProject', (_event, name) => changed(store.createProject(value.name.parse(name))));
  handle('deleteProject', (_event, id) => changed(store.deleteProject(value.id.parse(id))));
  handle('createDocument', (_event, title, projectId) => {
    const doc = store.createDocument({ kind: 'markdown', title: value.name.parse(title), projectId: project.parse(projectId), markdown: '', mediaType: null, asset: null });
    scheduleTags(doc);
    return changed(doc);
  });
  handle('importDocuments', async (event, projectId) => {
    const target = project.parse(projectId);
    const selection = await dialog.showOpenDialog(windowFor(event), {
      title: '导入资料', properties: ['openFile', 'multiSelections'],
      filters: [{ name: 'Markdown、PDF 和图片', extensions: ['md', 'markdown', 'pdf', 'png', 'jpg', 'jpeg', 'webp', 'gif'] }],
    });
    if (selection.canceled) return 0;
    const failures: string[] = [];
    let imported = 0;
    for (const path of selection.filePaths) {
      try {
        const document = await files.addFile(path, target);
        scheduleTags(document);
        imported++;
      } catch (error) { failures.push(asMessage(error)); }
    }
    if (imported) broadcast();
    if (failures.length) throw new Error('已导入 ' + imported + ' 份。' + failures.slice(0, 5).join('\n'));
    return imported;
  });
  handle('document', (_event, id) => store.document(value.id.parse(id)));
  handle('updateDocument', (_event, id, title, projectId) => {
    const doc = store.updateDocument(value.id.parse(id), value.name.parse(title), project.parse(projectId));
    scheduleTags(doc);
    return changed(doc);
  });
  handle('deleteDocument', async (_event, input) => {
    const id = value.id.parse(input);
    const asset = store.deleteDocument(id);
    const timer = tagTimers.get(id);
    if (timer) clearTimeout(timer);
    tagTimers.delete(id);
    documents.get(id)?.destroy();
    broadcast();
    if (asset) await files.removeAsset(asset).catch((error) => console.error('Asset cleanup failed:', asMessage(error)));
  });
  handle('saveMarkdown', (_event, id, text, version) => {
    const doc = store.saveMarkdown(value.id.parse(id), value.markdown.parse(text), revision.parse(version));
    scheduleTags(doc);
    return changed(doc);
  });
  handle('setTags', (_event, id, names) => changed(store.setTags(value.id.parse(id), tags.parse(names), true)));
  handle('openDocument', (_event, source) => openDocument(value.source.parse(source)));
  handle('asset', (_event, id) => files.asset(value.id.parse(id)));
  handle('annotations', (_event, id) => store.annotations(value.id.parse(id)));
  handle('addAnnotation', (_event, id, anchor, text) => changed(store.addAnnotation(value.id.parse(id), value.anchor.parse(anchor), value.note.parse(text))));
  handle('updateAnnotation', (_event, id, text) => changed(store.updateAnnotation(value.id.parse(id), value.note.parse(text))));
  handle('deleteAnnotation', (_event, id) => changed(store.deleteAnnotation(value.id.parse(id))));
  handle('history', (_event, id) => store.history(value.id.parse(id)));
  handle('version', (_event, id, versionId) => store.version(value.id.parse(id), value.id.parse(versionId)));
  handle('restoreVersion', (_event, id, versionId, version) => {
    const doc = store.restoreVersion(value.id.parse(id), value.id.parse(versionId), revision.parse(version));
    scheduleTags(doc);
    return changed(doc);
  });
  handle('tasks', () => store.tasks());
  handle('createTask', (_event, input) => changed(store.createTask(value.taskInput.parse(input))));
  handle('updateTask', (_event, id, input) => changed(store.updateTask(value.id.parse(id), metadata.parse(input))));
  handle('toggleTask', (_event, id, done) => changed(store.toggleTask(value.id.parse(id), z.boolean().parse(done))));
  handle('deleteTask', (_event, id) => changed(store.deleteTask(value.id.parse(id))));
  handle('reorderTasks', (_event, ids) => changed(store.reorderTasks(z.array(value.id).min(2).max(50_000).parse(ids))));
  handle('resetTaskOrder', () => changed(store.resetTaskOrder()));
  handle('markdownLayout', () => markdownPreferences.current());
  handle('saveMarkdownLayout', async (_event, input) => {
    const layout = await markdownPreferences.save(value.markdownLayout.parse(input));
    for (const window of workspaceWindows) {
      if (!window.isDestroyed() && window.webContents.getURL()) window.webContents.send('workspace:markdownLayout', layout);
    }
    return layout;
  });
  handle('exportDocument', async (event, raw, formatName) => {
    const id = value.id.parse(raw);
    const selected = format.parse(formatName);
    const document = store.document(id);
    const ext = extensionFor(document, selected);
    const title = document.title.replace(/[<>:"/\\|?*\u0000-\u001F]/g, '-').replace(/[. ]+$/, '') || '资料';
    const result = await dialog.showSaveDialog(windowFor(event), {
      title: '导出资料',
      defaultPath: title + (selected === 'annotated-pdf' ? '（含批注）' : '') + '.' + ext,
      filters: [{ name: ext.toUpperCase(), extensions: [ext] }],
    });
    if (result.canceled || !result.filePath) return false;
    const active = documents.get(id);
    if (active && document.kind === 'markdown') await flushDocument(active);
    await files.exportDocument(id, selected, result.filePath, markdownPreferences.current());
    return true;
  });
  handle('exportWorkspace', async (event) => {
    const result = await dialog.showSaveDialog(windowFor(event), {
      title: '导出工作空间', defaultPath: '工作空间-' + new Date().toISOString().slice(0, 10) + '.ydwspace',
      filters: [{ name: '工作空间迁移包', extensions: ['ydwspace'] }],
    });
    if (result.canceled || !result.filePath) return false;
    await Promise.all([...documents].filter(([id]) => store.storedDocument(id).kind === 'markdown').map(([, window]) => flushDocument(window)));
    await files.exportWorkspace(result.filePath);
    return true;
  });
  handle('previewImport', async (event) => {
    const result = await dialog.showOpenDialog(windowFor(event), {
      title: '导入工作空间', properties: ['openFile'], filters: [{ name: '工作空间迁移包', extensions: ['ydwspace'] }],
    });
    return result.canceled ? null : files.stageImport(result.filePaths[0]);
  });
  handle('finishImport', async (_event, token) => changed(await files.finishImport(value.id.parse(token))));
  handle('cancelImport', (_event, token) => files.cancelImport(value.id.parse(token)));
  handle('chatSettings', async () => {
    const settings = await readSettings();
    return { model: settings.model, keyConfigured: Boolean(settings.secret) };
  });
  handle('saveChatSettings', (_event, model, key) => updateSettings(
    z.string().trim().min(1).max(100).parse(model), z.string().trim().max(500).optional().parse(key),
  ));
  handle('sendChat', (_event, messages) => sendChat(value.chatMessages.parse(messages)));
  ipcMain.on('workspace:flush-result', (event, ticket: unknown, error: unknown) => {
    if (typeof ticket !== 'string') return;
    const pending = flushes.get(ticket);
    if (pending?.sender === event.sender.id) pending.complete(typeof error === 'string' ? error : undefined);
  });
}

function registerPdfAssets() {
  const pdfRoot = resolve(app.getAppPath(), 'node_modules', 'pdfjs-dist');
  protocol.handle('workspace-asset', (request) => {
    const url = new URL(request.url);
    const pdf = url.hostname === 'pdf' && /^\/(cmaps|standard_fonts|wasm|iccs)\//.test(url.pathname);
    if (!pdf) return new Response(null, { status: 404 });
    let path: string;
    try { path = resolve(pdfRoot, decodeURIComponent(url.pathname.slice(1))); }
    catch { return new Response(null, { status: 400 }); }
    const child = relative(pdfRoot, path);
    if (isAbsolute(child) || child.startsWith('..') || !child) return new Response(null, { status: 404 });
    return net.fetch(pathToFileURL(path).toString()).catch(() => new Response(null, { status: 404 }));
  });
}

if (!app.requestSingleInstanceLock()) app.quit();
else {
  app.on('second-instance', openMain);
  app.whenReady().then(async () => {
    registerPdfAssets();
    const root = app.getPath('userData');
    markdownPreferences = new MarkdownPreferences(join(root, 'markdown-layout.json'));
    await markdownPreferences.load();
    store = new Store(join(root, 'workspace.sqlite'));
    files = new WorkspaceFiles(store, join(root, 'assets'), join(root, 'staging'));
    await files.prepare();
    registerHandlers();
    openMain();
  }).catch((error) => {
    dialog.showErrorBox('无法启动工作空间', asMessage(error));
    app.exit(1);
  });
  app.on('activate', openMain);
  app.on('window-all-closed', () => app.quit());
  let quitRequested = false;
  app.on('before-quit', (event) => {
    if (quitting || !store || documents.size === 0) return;
    event.preventDefault();
    if (quitRequested) return;
    quitRequested = true;
    void Promise.all([...documents].filter(([id]) => store.storedDocument(id).kind === 'markdown').map(([, window]) => flushDocument(window))).then(
      () => { quitting = true; app.quit(); },
      (error) => dialog.showErrorBox('退出前保存失败', asMessage(error)),
    ).finally(() => { quitRequested = false; });
  });
  app.on('will-quit', () => {
    for (const timer of tagTimers.values()) clearTimeout(timer);
    store?.close();
  });
}
