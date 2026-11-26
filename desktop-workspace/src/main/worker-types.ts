import type { Annotation, MarkdownLayout } from '../shared/contracts';
import type { Manifest } from '../shared/validation';

export type Job =
  | { type: 'remove-asset'; path: string }
  | { type: 'tags'; title: string; markdown: string }
  | { type: 'export-workspace'; manifest: Manifest; assetsDir: string; destination: string }
  | { type: 'stage-workspace'; source: string; staging: string }
  | { type: 'pdf-notes'; source: string; destination: string; annotations: Annotation[] }
  | { type: 'docx'; title: string; markdown: string; layout: MarkdownLayout; destination: string }
  | { type: 'print-html'; title: string; markdown: string; layout: MarkdownLayout };
