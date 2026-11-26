# 工作空间

为 Windows 新建的本地桌面应用。项目、资料、批注与任务互相交叉引用，资料可以在独立窗口中并排打开。

主窗口默认打开 [AFFiNE 官方网页应用](https://app.affine.pro/)。切换到其他页面后，可以点击左上角的「工作空间」标题返回 AFFiNE。页面加载需要网络连接。AFFiNE 自行管理账号和数据，原有资料可从侧栏的「空间」打开。

## 运行与验证

使用 Node.js 24 和 npm。

```powershell
npm.cmd ci
npm.cmd run dev
npm.cmd test
npm.cmd run test:desktop
npm.cmd run package:win
```

桌面测试会使用临时用户数据目录，验证 PDF 批注和任务回跳、Markdown 编辑历史与批注定位，以及工作空间迁移。安装包输出到 `release`。AI 聊天使用自行配置的 DeepSeek API 密钥，密钥由 Windows 加密保存，独立于迁移包。

## 代码结构

- `src/main` 管理窗口、SQLite、资料文件、导出和迁移。桌面后台线程处理 ZIP、Word、PDF 批注导出和标签计算。
- `src/preload` 提供类型化的窗口接口。渲染窗口没有 Node 权限。
- `src/renderer` 包含空间、任务、聊天和资料窗口。AFFiNE 的 BlockSuite 页面编辑器与 PDF.js 在对应资料打开时加载。
- `src/shared` 是跨窗口的数据契约与运行时校验。

工作空间迁移包包含资料、项目、标签、Markdown 历史、批注和任务。在非空工作空间导入时，新增一套关联完整的副本。当前迁移包解压上限为 512 MiB，单份附件上限为 120 MiB。

Markdown 每次自动保存产生一条历史记录。PDF 支持选择文字或框选区域，导出的副本使用原生 PDF 注释。自动标签使用本地文本与文件名，首版不对扫描件或图片执行 OCR。
