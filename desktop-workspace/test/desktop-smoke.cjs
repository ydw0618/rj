const assert = require('node:assert/strict');
const { mkdtemp, readFile, rm, writeFile } = require('node:fs/promises');
const { tmpdir } = require('node:os');
const { join, resolve } = require('node:path');
const { _electron: electron } = require('playwright-core');
const { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName } = require('pdf-lib');

const root = resolve(__dirname, '..');

async function mockOpen(app, file) {
  await app.evaluate(({ dialog }, filePaths) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths });
  }, Array.isArray(file) ? file : [file]);
}

async function mockSave(app, file) {
  await app.evaluate(({ dialog }, filePath) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath });
  }, file);
}

async function launch(profile) {
  const packaged = process.env.YDWWORKSPACE_TEST_EXE;
  return electron.launch({
    executablePath: packaged || require('electron'), cwd: root,
    args: [...(packaged ? [] : [root]), '--user-data-dir=' + profile], timeout: 30_000,
    env: { ...process.env, ELECTRON_RENDERER_URL: '' },
  });
}

function nextDocumentWindow(app) {
  return app.waitForEvent('window', {
    timeout: 20_000,
    predicate: (window) => window.waitForURL((url) => url.protocol === 'file:' && url.searchParams.get('view') === 'document',
      { timeout: 12_000 }).then(() => true, () => false),
  });
}

async function openDocument(app, main, name) {
  const [window] = await Promise.all([
    nextDocumentWindow(app),
    main.locator('.file-open').getByText(name, { exact: true }).click(),
  ]);
  window.setDefaultTimeout(10_000);
  window.on('pageerror', (error) => console.error('Document renderer:', error.stack));
  await window.getByRole('heading', { name, exact: true }).waitFor();
  return window;
}

async function markdownAction(window, text, paragraph) {
  const content = window.locator('page-editor .affine-page-root-block-container');
  const target = paragraph ? content.locator('affine-paragraph rich-text').filter({ hasText: paragraph }) : content.locator('affine-paragraph rich-text').first();
  await target.click({ button: 'right' });
  await window.getByRole('menuitem', { name: text, exact: true }).click();
}

async function verifyAffine(app, main) {
  const nav = main.getByRole('button', { name: '工作空间，返回 AFFiNE', exact: true });
  assert.equal(await nav.getAttribute('aria-current'), 'page');
  assert.equal(await main.getByRole('navigation', { name: '导航', exact: true })
    .getByRole('button', { name: 'AFFiNE', exact: true }).count(), 0);
  if (!process.env.YDWWORKSPACE_TEST_AFFINE) return;

  const pane = main.getByRole('region', { name: 'AFFiNE 工作区' });
  await main.locator('.affine-pane[data-status="ready"]').waitFor({ timeout: 45_000 });
  const inspect = () => app.evaluate(async ({ BrowserWindow }) => {
    const host = BrowserWindow.getAllWindows()[0];
    const view = host.contentView.children.find((item) => item.webContents && item.webContents !== host.webContents);
    if (!view) throw new Error('AFFiNE is missing from the main window');
    const contents = view.webContents;
    const page = await contents.executeJavaScript("({ url: location.href, title: document.title, workspace: typeof window.workspace, node: typeof window.require, text: document.body.innerText.slice(0, 500) })");
    return { id: contents.id, visible: view.getVisible(), bounds: view.getBounds(), ...page };
  });
  const first = await inspect();
  assert.equal(new URL(first.url).origin, 'https://app.affine.pro');
  assert.match(first.title, /AFFiNE/i);
  assert.equal(first.workspace, 'undefined');
  assert.equal(first.node, 'undefined');
  const slot = await pane.boundingBox();
  assert.ok(first.visible && first.bounds.x > 0 && slot && Math.abs(first.bounds.width - slot.width) <= 2, JSON.stringify(first));
  await main.getByRole('button', { name: '设置', exact: true }).click();
  await main.getByRole('dialog', { name: 'Markdown 排版设置' }).waitFor();
  assert.equal((await inspect()).visible, false);
  await main.keyboard.press('Escape');
  await pane.waitFor();
  await main.getByRole('button', { name: '空间', exact: true }).click();
  assert.equal((await inspect()).visible, false);
  await nav.click();
  await main.locator('.affine-pane[data-status="ready"]').waitFor();
  const reopened = await inspect();
  assert.equal(reopened.id, first.id);
  assert.equal(reopened.visible, true);
  const affine = app.windows().find((window) => window.url().startsWith('https://app.affine.pro/'));
  assert.ok(affine, 'The official AFFiNE page should have its own renderer');
  await affine.getByText('Demo Workspace', { exact: true }).first().waitFor({ timeout: 40_000 });
  console.log('Official AFFiNE is embedded in the main window with an isolated, persistent session.');
}

async function verifyAffineRecovery(app, main) {
  if (!process.env.YDWWORKSPACE_TEST_AFFINE) return;

  const fixtureUrl = 'https://app.affine.pro/__workspace_startup_test__';
  const contentsId = await app.evaluate(async ({ BrowserWindow }, url) => {
    const host = BrowserWindow.getAllWindows()[0];
    const view = host.contentView.children.find((item) => item.webContents && item.webContents !== host.webContents);
    const contents = view.webContents;
    globalThis.affineTestStall = false;
    contents.debugger.attach('1.3');
    await contents.debugger.sendCommand('Fetch.enable', { patterns: [{ urlPattern: url + '*' }] });
    contents.debugger.on('message', (_event, method, params) => {
      if (method !== 'Fetch.requestPaused' || globalThis.affineTestStall || params.request.url !== url) return;
      void contents.debugger.sendCommand('Fetch.fulfillRequest', {
        requestId: params.requestId,
        responseCode: 200,
        responseHeaders: [
          { name: 'Content-Type', value: 'text/html' },
          { name: 'Cache-Control', value: 'no-store' },
        ],
        body: Buffer.from('<!doctype html><title>AFFiNE startup fixture</title><h1>Ready</h1><img src="?slow=image">').toString('base64'),
      }).catch(() => {});
    });
    void contents.loadURL(url).catch(() => {});
    return contents.id;
  }, fixtureUrl);
  const affine = app.windows().find((window) => window.url().startsWith('https://app.affine.pro/'));
  await affine.getByRole('heading', { name: 'Ready', exact: true }).waitFor();
  await main.evaluate(() => window.workspace.reloadAffine());
  await main.locator('.affine-pane[data-status="ready"]').waitFor();
  assert.equal(await app.evaluate(({ webContents }, id) => webContents.fromId(id).isLoading(), contentsId), true);

  await app.evaluate(() => { globalThis.affineTestStall = true; });
  await main.evaluate(() => window.workspace.reloadAffine());
  await main.getByText('AFFiNE 加载超时', { exact: true }).waitFor({ timeout: 20_000 });
  await main.getByRole('button', { name: '在浏览器打开', exact: true }).waitFor();
  await app.evaluate(() => { globalThis.affineTestStall = false; });
  await main.getByRole('button', { name: '重新加载', exact: true }).click();
  await main.locator('.affine-pane[data-status="ready"]').waitFor();
  console.log('AFFiNE renders while a subresource stalls, and a stalled navigation times out and recovers on retry.');
}

async function verify() {
  const folder = await mkdtemp(join(tmpdir(), 'ydw-desktop-test-'));
  let app;
  try {
    const fixture = join(folder, '调研报告.pdf');
    const markdown = join(folder, '项目笔记.md');
    const exported = join(folder, '带批注.pdf');
    const migrated = join(folder, '项目.ydwspace');
    const testPdf = await PDFDocument.create();
    testPdf.addPage([380, 460]).drawText('Page one');
    testPdf.addPage([380, 460]).drawText('Page two');
    await writeFile(fixture, await testPdf.save());
    await writeFile(markdown, '# 会议记录\n\n需要核实的数字。\n', 'utf8');

    app = await launch(join(folder, 'profile'));
    const main = await app.firstWindow();
    main.setDefaultTimeout(10_000);
    await verifyAffine(app, main);
    await verifyAffineRecovery(app, main);
    await main.getByRole('button', { name: '空间', exact: true }).click();
    await main.getByRole('heading', { name: '空间', exact: true }).waitFor();
    await main.getByRole('button', { name: 'AI 聊天', exact: true }).click();
    await main.getByRole('heading', { name: 'AI 聊天', exact: true }).waitFor();
    assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
    await main.getByRole('button', { name: '空间', exact: true }).click();
    await main.getByRole('button', { name: '新建项目' }).click();
    await main.getByLabel('项目名称').fill('产品设计');
    await main.getByRole('button', { name: '创建', exact: true }).click();
    await main.getByRole('heading', { name: '产品设计', exact: true }).waitFor();

    await mockOpen(app, fixture);
    await main.getByRole('button', { name: '导入资料', exact: true }).click();
    const pdf = await openDocument(app, main, '调研报告');
    await pdf.getByRole('button', { name: '下一页' }).click();
    await pdf.waitForFunction(() => document.querySelector('input[name=page]')?.value === '2');
    await pdf.getByRole('button', { name: '区域批注' }).click();
    const box = await pdf.locator('.pdf-page canvas').boundingBox();
    assert.ok(box);
    await pdf.mouse.move(box.x + 40, box.y + 65);
    await pdf.mouse.down();
    await pdf.mouse.move(box.x + 160, box.y + 105, { steps: 5 });
    await pdf.mouse.up();
    await pdf.getByRole('button', { name: '批注所选内容' }).click();
    await pdf.getByLabel('批注内容').fill('核实这一页的数据来源');
    await pdf.getByRole('button', { name: '保存批注' }).click();
    const note = pdf.locator('.note-card').filter({ hasText: '核实这一页的数据来源' });
    await note.getByRole('button', { name: '创建任务' }).click();
    await pdf.getByLabel('截止时间').fill('2026-12-02T10:00');
    await pdf.getByRole('button', { name: '保存任务' }).click();
    await pdf.getByText('任务已创建。', { exact: true }).waitFor();

    await mockSave(app, exported);
    await pdf.getByText('导出', { exact: true }).click();
    await pdf.getByRole('button', { name: '带批注的 PDF', exact: true }).click();
    await pdf.getByText('资料已导出。', { exact: true }).waitFor();
    const parsed = await PDFDocument.load(await readFile(exported));
    const nativeNotes = parsed.getPage(1).node.lookup(PDFName.of('Annots'), PDFArray);
    assert.equal(nativeNotes.lookup(0, PDFDict).lookup(PDFName.of('Contents'), PDFHexString).decodeText(), '核实这一页的数据来源');

    await pdf.evaluate(() => window.close());
    await main.getByRole('button', { name: /^任务/ }).click();
    const jumped = await openTaskSource(app, main, '核实这一页的数据来源');
    await jumped.waitForFunction(() => document.querySelector('input[name=page]')?.value === '2');
    await jumped.locator('.note-card.active').getByText('核实这一页的数据来源').waitFor();
    console.log('PDF import, page annotation, export and task navigation passed.');

    await main.getByRole('button', { name: '产品设计', exact: true }).click();
    await mockOpen(app, markdown);
    await main.getByRole('button', { name: '导入资料', exact: true }).click();
    const editor = await openDocument(app, main, '项目笔记');
    await editor.locator('.outline').getByRole('button', { name: '会议记录' }).waitFor().catch(async (error) => {
      console.error('Markdown initialization:', await editor.locator('.document-shell').innerText());
      throw error;
    });
    const paper = await editor.locator('.editor-host').evaluate((node) => {
      const box = node.getBoundingClientRect();
      return { width: box.width, height: box.height };
    });
    assert.ok(paper.width > 520 && paper.width <= 794 && Math.abs(paper.height / paper.width - 297 / 210) < .05, JSON.stringify(paper));
    await main.getByRole('button', { name: '设置', exact: true }).click();
    const layoutSettings = main.getByRole('dialog', { name: 'Markdown 排版设置' });
    await layoutSettings.getByRole('spinbutton', { name: '正文字号' }).fill('19');
    await layoutSettings.getByRole('spinbutton', { name: '行距倍数' }).fill('1.85');
    await layoutSettings.getByRole('spinbutton', { name: '段后间距' }).fill('17');
    await layoutSettings.getByRole('checkbox', { name: '首行缩进两个字符' }).check();
    await layoutSettings.getByRole('button', { name: '保存设置' }).click();
    await editor.waitForFunction(() => {
      const editable = document.querySelector('page-editor .affine-page-root-block-container');
      const paragraph = editable?.querySelector('affine-paragraph .affine-paragraph-rich-text-wrapper.text');
      return editable && paragraph && getComputedStyle(editable).fontSize === '19px'
        && getComputedStyle(paragraph).marginBottom === '17px'
        && getComputedStyle(paragraph).textIndent === '38px'
        && Math.abs(parseFloat(getComputedStyle(editable).lineHeight) - 35.15) < .15;
    });
    await editor.evaluate(() => {
      const paragraph = document.querySelector('page-editor affine-paragraph .affine-paragraph-rich-text-wrapper.text rich-text');
      const span = paragraph?.querySelector('[data-v-text]');
      const text = span && document.createTreeWalker(span, NodeFilter.SHOW_TEXT).nextNode();
      if (!paragraph || !text) throw new Error('Missing Markdown text node');
      const range = document.createRange();
      range.setStart(text, 0);
      range.setEnd(text, 4);
      window.getSelection().removeAllRanges();
      window.getSelection().addRange(range);
      if (window.getSelection().toString() !== '需要核实') throw new Error('Markdown selection was lost');
      paragraph.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
    });
    await editor.getByRole('button', { name: '批注所选内容' }).click();
    await editor.getByLabel('批注内容').fill('复查会议纪要');
    await editor.getByRole('button', { name: '保存批注' }).click();
    await editor.locator('.note-card.active').getByText('复查会议纪要').waitFor();
    await editor.locator('.connector circle').waitFor({ state: 'attached' });
    await editor.locator('affine-paragraph .affine-paragraph-rich-text-wrapper.text rich-text').first().click();
    await editor.keyboard.press('End');
    await editor.keyboard.type(' update');
    await editor.locator('affine-paragraph rich-text').filter({ hasText: 'update' }).waitFor();
    await markdownAction(editor, '编辑历史');
    await editor.getByRole('button', { name: /版本 2/ }).waitFor();
    await editor.getByRole('button', { name: '关闭', exact: true }).last().click();
    await editor.evaluate(() => window.close());
    const reopened = await openDocument(app, main, '项目笔记');
    await reopened.locator('.note-content').filter({ hasText: '复查会议纪要' }).click();
    await reopened.locator('.connector circle').waitFor({ state: 'attached' });
    assert.equal(await reopened.locator('page-editor .affine-page-root-block-container').evaluate((node) => getComputedStyle(node).fontSize), '19px');
    const printed = join(folder, 'Markdown A4.pdf');
    await mockSave(app, printed);
    await markdownAction(reopened, '导出 PDF');
    await reopened.getByText('资料已导出。', { exact: true }).waitFor();
    const pdfSize = (await PDFDocument.load(await readFile(printed))).getPage(0).getSize();
    assert.ok(Math.abs(pdfSize.width - 595.28) <= 1.5 && Math.abs(pdfSize.height - 841.89) <= 1.5, JSON.stringify(pdfSize));
    console.log('A4 paper, live paragraph settings, and A4 PDF export passed.');
    console.log('Markdown editor, history, annotation and reopen passed.');

    const extra = [
      [join(folder, '附件甲.pdf'), await testPdf.save()],
      [join(folder, '附件乙.md'), '# 另一篇文档\n\n![保留旧图](images/legacy.png)\n\n<!-- 旧文档备注 -->\n\n准备插入表格。\n\n准备插入代码。\n\n块编辑练习。\n'],
      [join(folder, '附件丙.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jR2cAAAAASUVORK5CYII=', 'base64')],
    ];
    for (const [path, data] of extra) await writeFile(path, data);
    await mockOpen(app, extra.map(([path]) => path));
    await main.getByRole('button', { name: '导入资料', exact: true }).click();
    const extraPdf = await openDocument(app, main, '附件甲');
    const extraMarkdown = await openDocument(app, main, '附件乙');
    const extraImage = await openDocument(app, main, '附件丙');
    await extraPdf.getByRole('button', { name: '下一页' }).click();
    await extraMarkdown.locator('.outline').getByText('另一篇文档').waitFor();
    const prose = extraMarkdown.locator('page-editor affine-paragraph .affine-paragraph-rich-text-wrapper.text rich-text').filter({ hasText: '准备插入表格。' });
    await prose.click();
    const paragraphAction = extraMarkdown.locator('affine-drag-handle-widget');
    assert.equal(await paragraphAction.isVisible(), false);
    await markdownAction(extraMarkdown, '插入表格', '准备插入表格。');
    const table = extraMarkdown.locator('page-editor affine-database-table');
    await table.waitFor();
    await table.getByText('列 1', { exact: true }).waitFor();
    assert.equal(await paragraphAction.isVisible(), false);
    await extraMarkdown.locator('page-editor affine-paragraph .affine-paragraph-rich-text-wrapper.text rich-text').filter({ hasText: '准备插入代码。' }).click();
    await markdownAction(extraMarkdown, '代码块', '准备插入代码。');
    await extraMarkdown.keyboard.type('const answer = 42;');
    await extraMarkdown.locator('page-editor affine-code rich-text').filter({ hasText: 'const answer = 42;' }).waitFor({ state: 'attached' });
    console.log('Markdown context menu inserts editable tables and code, with paragraph actions hidden.');
    await extraMarkdown.locator('page-editor affine-paragraph .affine-paragraph-rich-text-wrapper.text rich-text').filter({ hasText: '块编辑练习。' }).click();
    await extraMarkdown.keyboard.press('End');
    await extraMarkdown.waitForFunction(() => {
      const caret = getSelection();
      return caret?.anchorNode?.textContent === '块编辑练习。' && caret.anchorOffset === '块编辑练习。'.length;
    });
    await extraMarkdown.keyboard.press('Enter');
    await extraMarkdown.waitForFunction(() => {
      const last = [...document.querySelectorAll('affine-paragraph rich-text')].at(-1);
      return last?.contains(getSelection()?.anchorNode) && !last.textContent.replaceAll('\u200B', '').trim();
    }).catch(async (error) => {
      console.error('After Markdown Enter:', await extraMarkdown.evaluate(() => ({
        anchor: getSelection()?.anchorNode?.textContent,
        blocks: [...document.querySelectorAll('page-editor affine-paragraph rich-text')].map((node) => node.textContent),
      })));
      throw error;
    });
    const insertMenu = extraMarkdown.getByRole('listbox', { name: '插入内容' });
    await extraMarkdown.keyboard.type('/');
    await insertMenu.getByRole('option', { name: '一级标题', exact: true }).waitFor().catch(async (error) => {
      console.error('Slash selection:', await extraMarkdown.evaluate(() => {
        const caret = getSelection();
        return { text: caret?.anchorNode?.textContent, parent: caret?.anchorNode?.parentElement?.outerHTML.slice(0, 300),
          offset: caret?.anchorOffset, last: [...document.querySelectorAll('affine-paragraph rich-text')].at(-1)?.textContent };
      }));
      throw error;
    });
    await extraMarkdown.keyboard.press('ArrowDown');
    await insertMenu.getByRole('option', { name: '二级标题', exact: true, selected: true }).waitFor();
    await extraMarkdown.keyboard.press('Enter');
    await extraMarkdown.keyboard.insertText('快捷标题');
    await extraMarkdown.locator('page-editor affine-paragraph .affine-paragraph-rich-text-wrapper.h2 rich-text').filter({ hasText: '快捷标题' }).waitFor();
    const outline = extraMarkdown.getByRole('navigation', { name: '文档大纲' });
    await outline.getByRole('button', { name: '折叠 另一篇文档', exact: true }).click();
    await outline.getByRole('button', { name: '快捷标题', exact: true }).waitFor({ state: 'hidden' });
    await outline.getByRole('button', { name: '展开 另一篇文档', exact: true }).click();
    await outline.getByRole('button', { name: '快捷标题', exact: true }).click();
    assert.equal(await outline.getByRole('button', { name: '快捷标题', exact: true }).getAttribute('aria-current'), 'location');
    await extraMarkdown.locator('page-editor affine-paragraph .affine-paragraph-rich-text-wrapper.h2 rich-text').filter({ hasText: '快捷标题' }).click();
    await extraMarkdown.keyboard.press('End');
    await extraMarkdown.keyboard.press('Enter');
    await extraMarkdown.keyboard.insertText('／代码');
    await insertMenu.getByRole('option', { name: '代码块', exact: true }).click();
    await extraMarkdown.keyboard.type('const quick = true;');
    await extraMarkdown.locator('page-editor affine-code rich-text').filter({ hasText: 'const quick = true;' }).first().waitFor({ state: 'attached' });
    console.log('Slash insertion and foldable outline passed with keyboard and Chinese text input.');
    await extraImage.getByRole('img', { name: '附件丙' }).waitFor();
    assert.equal(app.windows().filter((window) => window.url().includes('view=document')).length, 5);
    await mockSave(app, migrated);
    await main.getByRole('button', { name: '导出工作空间', exact: true }).click();
    await reopened.locator('affine-paragraph .affine-paragraph-rich-text-wrapper.text rich-text').first().click();
    await reopened.keyboard.press('End');
    await reopened.keyboard.type(' run');
    await extraPdf.getByRole('button', { name: '上一页' }).click();
    await extraPdf.waitForFunction(() => document.querySelector('input[name=page]')?.value === '1');
    await main.getByText('工作空间已导出。', { exact: true }).waitFor();
    console.log('Five independent document windows stayed usable during workspace export.');
    await app.close();
    app = await launch(join(folder, 'migrated-profile'));
    const second = await app.firstWindow();
    await second.getByRole('button', { name: '空间', exact: true }).click();
    await second.getByRole('heading', { name: '空间', exact: true }).waitFor();
    await mockOpen(app, migrated);
    await second.getByRole('button', { name: '导入工作空间', exact: true }).click();
    await second.getByRole('button', { name: '确认导入' }).click();
    await second.getByText('工作空间已导入。', { exact: true }).waitFor();
    await second.getByRole('button', { name: /^任务/ }).click();
    const importedPdf = await openTaskSource(app, second, '核实这一页的数据来源');
    await importedPdf.waitForFunction(() => document.querySelector('input[name=page]')?.value === '2');
    await importedPdf.locator('.note-card.active').getByText('核实这一页的数据来源').waitFor();
    await second.getByRole('button', { name: '产品设计', exact: true }).click();
    const importedMarkdown = await openDocument(app, second, '附件乙');
    await importedMarkdown.locator('page-editor affine-database-table').waitFor();
    const savedMarkdown = await importedMarkdown.evaluate(async () => {
      const id = new URLSearchParams(location.search).get('id');
      return (await window.workspace.document(id)).markdown;
    });
    assert.match(savedMarkdown, /\x60{3}[^\n]*\nconst answer = 42;\n\x60{3}/);
    assert.match(savedMarkdown, /## 快捷标题/);
    assert.match(savedMarkdown, /const quick = true;/);
    assert.match(savedMarkdown, /!\[保留旧图\]\(images\/legacy.png\)/);
    assert.match(savedMarkdown, /<!-- 旧文档备注 -->/);
    assert.doesNotMatch(savedMarkdown, /／代码/);
    await importedMarkdown.locator('page-editor affine-code rich-text')
      .filter({ hasText: 'const answer = 42;' }).waitFor();
    console.log('Workspace export and migration into an empty profile passed.');

    await second.getByRole('textbox', { name: '搜索资料' }).fill('准备插入代码');
    await second.getByRole('button', { name: '高级检索', exact: true }).click();
    await second.getByLabel('资料类型').selectOption('markdown');
    await second.getByLabel('搜索关键词时同时检索 Markdown 正文').check();
    await second.getByRole('button', { name: '应用', exact: true }).click();
    await second.getByRole('button', { name: '附件乙', exact: true }).waitFor();
    assert.equal(await second.locator('.file-row').count(), 1);
    await second.getByRole('button', { name: '为附件乙添加任务', exact: true }).click();
    await second.getByLabel('任务名称', { exact: true }).fill('检索结果任务');
    await second.getByRole('checkbox', { name: '重要', exact: true }).check();
    await second.getByRole('checkbox', { name: '紧急', exact: true }).check();
    await second.getByRole('button', { name: '保存任务' }).click();
    await second.getByRole('button', { name: /^任务/ }).click();
    const newer = second.locator('.task-row').filter({ hasText: '检索结果任务' });
    const older = second.locator('.task-row').filter({ hasText: '核实这一页的数据来源' });
    await newer.getByRole('button', { name: '排序 检索结果任务' }).waitFor();
    await second.getByRole('combobox', { name: '筛选重要程度' }).selectOption('yes');
    assert.equal(await second.locator('.task-row').count(), 1);
    await second.getByRole('combobox', { name: '筛选紧急程度' }).selectOption('no');
    assert.equal(await second.locator('.task-row').count(), 0);
    await second.getByRole('combobox', { name: '筛选紧急程度' }).selectOption('all');
    await second.getByRole('combobox', { name: '筛选重要程度' }).selectOption('all');
    await newer.getByRole('button', { name: '排序 检索结果任务' }).dragTo(older, { targetPosition: { x: 90, y: 8 } });
    await second.locator('.task-row').first().getByRole('button', { name: '检索结果任务', exact: true }).waitFor();
    await second.getByRole('button', { name: '删除任务 检索结果任务' }).click();
    await second.getByRole('dialog', { name: '删除任务' }).getByRole('button', { name: '删除', exact: true }).click();
    await newer.waitFor({ state: 'detached' });
    await second.getByRole('button', { name: '产品设计', exact: true }).click();
    await second.getByRole('button', { name: '删除项目 产品设计' }).click();
    await second.getByRole('dialog', { name: '删除项目' }).getByRole('button', { name: '删除', exact: true }).click();
    await second.getByRole('heading', { name: '空间', exact: true }).waitFor();
    await second.getByRole('button', { name: '附件乙', exact: true }).waitFor();
    await second.getByRole('button', { name: '删除资料 附件乙' }).click();
    await second.getByRole('dialog', { name: '删除资料' }).getByRole('button', { name: '删除', exact: true }).click();
    await second.getByRole('button', { name: '附件乙', exact: true }).waitFor({ state: 'detached' });
    console.log('In-window chat, advanced retrieval, linked task creation, task classification and drag sorting, and deletions passed.');
  } finally {
    if (app) await app.close().catch(() => {});
    await rm(folder, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }).catch(() => {});
  }
}

async function openTaskSource(app, main, title) {
  const task = main.locator('.task-row').filter({ hasText: title });
  const opened = nextDocumentWindow(app);
  await task.getByRole('button', { name: '调研报告', exact: true }).click();
  return opened;
}

verify().catch((error) => { console.error(error); process.exitCode = 1; });
