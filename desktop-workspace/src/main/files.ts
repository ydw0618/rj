import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { copyFile, mkdir, mkdtemp, open, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';
import { app, BrowserWindow } from 'electron';
import { MAX_ASSET, remapWorkspace } from './archive';
import { runJob } from './jobs';
import type { Store } from './store';
import type { DocumentFormat, ImportPreview, MarkdownLayout } from '../shared/contracts';
import { markdown, type Manifest, type StoredDocument } from '../shared/validation';

const mediaTypes = new Map<string, NonNullable<StoredDocument['mediaType']>>([
  ['.pdf', 'application/pdf'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'], ['.jpeg', 'image/jpeg'],
  ['.gif', 'image/gif'], ['.webp', 'image/webp'],
]);

async function verifyAsset(path: string, mediaType: string) {
  const handle = await open(path, 'r');
  const header = Buffer.alloc(1024);
  try { await handle.read(header); } finally { await handle.close(); }
  const valid = mediaType === 'application/pdf' ? header.includes(Buffer.from('%PDF-'))
    : mediaType === 'image/png' ? header.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      : mediaType === 'image/jpeg' ? header.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
        : mediaType === 'image/gif' ? ['GIF87a', 'GIF89a'].includes(header.toString('ascii', 0, 6))
          : header.toString('ascii', 0, 4) === 'RIFF' && header.toString('ascii', 8, 12) === 'WEBP';
  if (!valid) throw new Error('资料格式与文件内容不一致。');
}

export class WorkspaceFiles {
  private readonly imports = new Map<string, { staging: string; manifest: Manifest }>();

  constructor(private readonly store: Store, private readonly assets: string, private readonly stagingRoot: string) {}

  async prepare() {
    await mkdir(this.assets, { recursive: true });
    await mkdir(this.stagingRoot, { recursive: true });
  }

  async addFile(path: string, projectId: string | null) {
    const extension = extname(path).toLowerCase();
    const title = basename(path, extname(path)).trim().slice(0, 150) || '未命名资料';
    const size = (await stat(path)).size;
    if (extension === '.md' || extension === '.markdown') {
      if (size > 12_000_000) throw new Error(title + ' 超出 Markdown 大小限制。');
      const input = new TextDecoder('utf-8', { fatal: true }).decode(await readFile(path));
      return this.store.createDocument({ kind: 'markdown', title, projectId, markdown: markdown.parse(input), mediaType: null, asset: null });
    }
    const mediaType = mediaTypes.get(extension);
    if (!mediaType || size > MAX_ASSET) throw new Error(title + ' 的格式或大小不受支持。');
    const asset = randomUUID();
    const destination = join(this.assets, asset);
    await verifyAsset(path, mediaType);
    let copied = false;
    try {
      await copyFile(path, destination, constants.COPYFILE_EXCL);
      copied = true;
      return this.store.createDocument({
        kind: mediaType === 'application/pdf' ? 'pdf' : 'image', title, projectId, markdown: null, mediaType, asset,
      });
    } catch (error) {
      if (copied) await rm(destination, { force: true });
      throw error;
    }
  }

  async asset(id: string) {
    const asset = this.store.storedDocument(id).asset;
    if (!asset) throw new Error('该资料没有原始附件。');
    return new Uint8Array(await readFile(join(this.assets, asset)));
  }

  removeAsset(asset: string) {
    return runJob({ type: 'remove-asset', path: join(this.assets, asset) });
  }

  async exportDocument(id: string, format: DocumentFormat, destination: string, layout: MarkdownLayout) {
    const document = this.store.storedDocument(id);
    if (format === 'original' && document.asset) {
      await copyFile(join(this.assets, document.asset), destination);
      return;
    }
    if (format === 'annotated-pdf' && document.kind === 'pdf' && document.asset) {
      await runJob({ type: 'pdf-notes', source: join(this.assets, document.asset), destination, annotations: this.store.annotations(id) });
      return;
    }
    if (document.markdown === null) throw new Error('该资料不支持此导出格式。');
    if (format === 'md') {
      await writeFile(destination, document.markdown, 'utf8');
      return;
    }
    if (format === 'docx') {
      await runJob({ type: 'docx', title: document.title, markdown: document.markdown, layout, destination });
      return;
    }
    if (format !== 'pdf') throw new Error('该资料不支持此导出格式。');
    const html = await runJob<string>({ type: 'print-html', title: document.title, markdown: document.markdown, layout });
    const folder = await mkdtemp(join(app.getPath('temp'), 'workspace-print-'));
    const window = new BrowserWindow({ show: false, webPreferences: { javascript: false, sandbox: true } });
    try {
      const path = join(folder, 'print.html');
      await writeFile(path, html, 'utf8');
      await window.loadFile(path);
      const bytes = await window.webContents.printToPDF({ preferCSSPageSize: true, printBackground: true });
      const temporary = join(dirname(destination), '.ydw-' + randomUUID() + '.tmp');
      try {
        await writeFile(temporary, bytes, { flag: 'wx' });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    } finally {
      window.destroy();
      await rm(folder, { recursive: true, force: true });
    }
  }

  exportWorkspace(destination: string) {
    return runJob({ type: 'export-workspace', manifest: this.store.manifest(), assetsDir: this.assets, destination });
  }

  async stageImport(path: string): Promise<ImportPreview> {
    const staging = await mkdtemp(join(this.stagingRoot, 'import-'));
    try {
      const manifest = await runJob<Manifest>({ type: 'stage-workspace', source: path, staging });
      for (const document of manifest.documents) {
        if (document.asset && document.mediaType) await verifyAsset(join(staging, document.asset), document.mediaType);
      }
      const token = randomUUID();
      this.imports.set(token, { staging, manifest });
      return {
        token, hasExisting: this.store.hasData(),
        counts: {
          projects: manifest.projects.length, documents: manifest.documents.length,
          annotations: manifest.annotations.length, tasks: manifest.tasks.length,
        },
      };
    } catch (error) {
      await rm(staging, { recursive: true, force: true });
      throw error;
    }
  }

  async cancelImport(token: string) {
    const pending = this.imports.get(token);
    if (!pending) return;
    this.imports.delete(token);
    await rm(pending.staging, { recursive: true, force: true });
  }

  async finishImport(token: string) {
    const pending = this.imports.get(token);
    if (!pending) throw new Error('导入已结束，请重新选择迁移包。');
    this.imports.delete(token);
    const copied: string[] = [];
    const manifest = remapWorkspace(pending.manifest, this.store.hasData());
    try {
      for (const [index, item] of manifest.documents.entries()) {
        if (!item.asset) continue;
        const original = pending.manifest.documents[index].asset!;
        const destination = join(this.assets, item.asset);
        await copyFile(join(pending.staging, original), destination, constants.COPYFILE_EXCL);
        copied.push(destination);
      }
      this.store.importManifest(manifest);
    } catch (error) {
      await Promise.allSettled(copied.map((path) => rm(path, { force: true })));
      throw error;
    } finally {
      await rm(pending.staging, { recursive: true, force: true });
    }
  }
}
