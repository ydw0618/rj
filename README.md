# 工作空间

为 Windows 开发的本地桌面应用。项目、资料、批注与任务互相交叉引用，资料可以在独立窗口中并排打开。资料文件保存在本机，工作空间可导出为迁移包，在另一台机器导入。

## 目录结构

```text
.
├── desktop-workspace/   桌面应用主工程（Electron + React + TypeScript）
│   ├── src/main         窗口、SQLite、资料文件、导出与迁移；后台线程处理 ZIP、Word、PDF 批注导出和标签计算
│   ├── src/preload      类型化的窗口接口，渲染窗口没有 Node 权限
│   ├── src/renderer     空间、任务、聊天和资料窗口；AFFiNE 页面编辑器与 PDF.js 按需加载
│   ├── src/shared       跨窗口的数据契约与运行时校验
│   └── test             工作空间逻辑测试与桌面冒烟测试
└── tmp/                 临时文件
```

## 快速开始

需要 Node.js 24 和 npm，在 `desktop-workspace` 目录下执行：

```powershell
npm.cmd ci
npm.cmd run dev          # 开发模式
npm.cmd test             # 逻辑测试
npm.cmd run test:desktop # 桌面冒烟测试
npm.cmd run package:win  # 打包 Windows 安装包，输出到 release
```

AI 聊天使用自行配置的 DeepSeek API 密钥，密钥由 Windows 加密保存，独立于迁移包。

## 功能要点

- Markdown 每次自动保存产生一条历史记录；PDF 支持选择文字或框选区域，导出的副本使用原生 PDF 注释
- 自动标签使用本地文本与文件名，首版不对扫描件或图片执行 OCR
- 迁移包包含资料、项目、标签、Markdown 历史、批注和任务；在非空工作空间导入时，新增一套关联完整的副本
- 主窗口默认打开 [AFFiNE 官方网页应用](https://app.affine.pro/)，页面加载需要网络连接

更多细节见 [desktop-workspace/README.md](desktop-workspace/README.md)。
