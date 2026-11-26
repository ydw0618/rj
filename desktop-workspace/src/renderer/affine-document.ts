import { AffineSlashMenuWidget } from '@blocksuite/blocks';
import { effects as registerBlocks } from '@blocksuite/blocks/effects';
import { createEmptyDoc, PageEditor } from '@blocksuite/presets';
import { effects as registerEditors } from '@blocksuite/presets/effects';
import { Job, Text, type Doc } from '@blocksuite/store';
import { markdownAdapter, preserveMarkdownSource } from './affine-markdown';

export const tableTemplate = '| 列 1 | 列 2 |\n| --- | --- |\n|  |  |\n';

export function createPageEditor() {
  if (!customElements.get('page-editor')) {
    registerBlocks();
    registerEditors();
  }
  const page = new PageEditor();
  // The workspace supplies a Chinese slash menu and an outer A4 scroll area.
  AffineSlashMenuWidget.DEFAULT_CONFIG = { ...AffineSlashMenuWidget.DEFAULT_CONFIG, triggerKeys: [] };
  page.hasViewport = false;
  return page;
}

export async function importDocument(markdown: string): Promise<Doc> {
  const { doc, init } = createEmptyDoc();
  init();
  try {
    const note = doc.getBlocksByFlavour('affine:note')[0].model;
    if (markdown.trim()) {
      const inserted = await insertMarkdown(doc, note.id, markdown, 0);
      if (inserted) doc.deleteBlock(note.children.at(-1)!);
    }
    doc.resetHistory();
    return doc;
  } catch (error) {
    releaseDocument(doc);
    throw error;
  }
}

export function releaseDocument(doc: Doc) {
  doc.collection.removeDoc(doc.id);
  doc.collection.dispose();
}

export async function insertMarkdown(doc: Doc, parent: string, markdown: string, index: number) {
  const job = new Job({ collection: doc.collection });
  const adapter = markdownAdapter(job);
  const snapshot = await adapter.toBlockSnapshot({
    file: preserveMarkdownSource(markdown), assets: job.assetsManager,
  });
  for (const [offset, child] of snapshot.children.entries()) {
    const model = await job.snapshotToBlock(child, doc, parent, index + offset);
    if (!model) throw new Error('无法打开 Markdown 中的内容块。');
  }
  return snapshot.children[0]?.id;
}

export async function serializeDocument(doc: Doc) {
  const job = new Job({ collection: doc.collection });
  const snapshot = job.docToSnapshot(doc);
  if (!snapshot) throw new Error('无法读取 Markdown 文档内容。');
  const result = await markdownAdapter(job).fromDocSnapshot({ snapshot, assets: job.assetsManager });
  if (result.assetsIds.length) throw new Error('请将图片作为独立资料导入，再在 Markdown 中引用。');
  return result.file;
}

export function blockAt(range: Range) {
  const node = range.startContainer;
  const element = node instanceof Element ? node : node.parentElement;
  return element?.closest<HTMLElement>('[data-block-id]') ?? null;
}

export type BlockCommand = 'h1' | 'h2' | 'h3' | 'list' | 'ordered-list' | 'check' | 'quote' | 'table' | 'code' | 'line';

export async function applyBlockCommand(page: PageEditor, block: HTMLElement, name: BlockCommand, replaceEmpty: boolean) {
  const { doc } = page;
  const model = doc.getBlockById(block.dataset.blockId ?? '');
  const parent = model && doc.getParent(model);
  if (!model || !parent) return;
  const index = parent.children.indexOf(model);
  let target: string;
  doc.captureSync();

  if (name === 'table' || name === 'code' || name === 'line') {
    const replace = replaceEmpty && model.text?.length === 0 && !model.children.length;
    const position = index + (replace ? 0 : 1);
    if (name === 'table') {
      target = (await insertMarkdown(doc, parent.id, tableTemplate, position)) ?? model.id;
    } else if (name === 'code') {
      target = doc.addBlock('affine:code', { language: 'plaintext', text: new Text() }, parent.id, position);
    } else {
      doc.addBlock('affine:divider', {}, parent.id, position);
      target = doc.addBlock('affine:paragraph', {}, parent.id, position + 1);
    }
    if (replace) doc.deleteBlock(model);
  } else if (model.flavour === 'affine:paragraph' && (name.startsWith('h') || name === 'quote')) {
    doc.updateBlock(model, { type: name });
    target = model.id;
  } else {
    const type = name === 'list' ? 'bulleted' : name === 'ordered-list' ? 'numbered' : name === 'check' ? 'todo' : name;
    const flavour = ['bulleted', 'numbered', 'todo'].includes(type) ? 'affine:list' : 'affine:paragraph';
    if (model.flavour === flavour) {
      doc.updateBlock(model, { type });
      target = model.id;
    } else {
      target = doc.addBlock(flavour, { type, text: model.text?.clone() ?? new Text() }, parent.id, index);
      doc.moveBlocks(model.children, doc.getBlockById(target)!);
      doc.deleteBlock(model);
    }
  }

  if (name !== 'table') {
    const view = page.std.view.getBlock(target);
    await view?.updateComplete;
    if (!page.isConnected || page.doc !== doc) return;
    page.std.selection.setGroup('note', [
      page.std.selection.create('text', {
        from: { blockId: target, index: doc.getBlockById(target)?.text?.length ?? 0, length: 0 },
        to: null,
      }),
    ]);
  }
}
