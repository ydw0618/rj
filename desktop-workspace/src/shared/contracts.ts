export type Kind = 'markdown' | 'pdf' | 'image';
export type Source = { documentId: string; annotationId?: string; anchor?: Anchor };
export type Rect = { x: number; y: number; width: number; height: number };
export type AffineStatus = 'loading' | 'ready' | 'timeout' | 'error';
export type Anchor =
  | { type: 'markdown'; quote: string; prefix: string; suffix: string; offset: number }
  | { type: 'pdf'; page: number; rect: Rect; quote?: string };
export type Project = { id: string; name: string };
export type Tag = { id: string; name: string };
export type DocumentSummary = {
  id: string; kind: Kind; title: string; projectId: string | null; tags: Tag[]; updatedAt: string;
};
export type WorkspaceDocument = DocumentSummary & {
  markdown: string | null; revision: number; mediaType: string | null;
};
export type DocumentSearch = {
  query: string; includeBody: boolean; projectId: string | null; kind: Kind | null;
  tagIds: string[]; updatedFrom: string | null; updatedBefore: string | null;
};
export type Annotation = { id: string; documentId: string; anchor: Anchor; text: string; createdAt: string };
export type Version = { id: string; createdAt: string; revision: number; markdown: string };
export type Task = {
  id: string; title: string; deadline: string | null; important: boolean; urgent: boolean; done: boolean; position: number | null;
  projectId: string | null; source: Source | null; sourceTitle: string | null; createdAt: string;
};
export type TaskInput = Pick<Task, 'title' | 'deadline' | 'important' | 'urgent' | 'projectId'> & { source?: Source };
export type ChatRole = 'user' | 'assistant';
export type ChatMessage = { role: ChatRole; content: string };
export type ImportPreview = { token: string; counts: Record<'projects' | 'documents' | 'annotations' | 'tasks', number>; hasExisting: boolean };
export type DocumentFormat = 'md' | 'docx' | 'pdf' | 'annotated-pdf' | 'original';
export type MarkdownLayout = { fontSize: number; lineHeight: number; paragraphGap: number; indentParagraphs: boolean };
export const defaultMarkdownLayout: MarkdownLayout = { fontSize: 16, lineHeight: 1.7, paragraphGap: 12, indentParagraphs: false };

export interface WorkspaceApi {
  setAffineBounds(bounds: Rect | null): Promise<AffineStatus>;
  reloadAffine(): Promise<void>;
  openAffineInBrowser(): Promise<void>;
  onAffineStatus(callback: (status: AffineStatus) => void): () => void;
  overview(): Promise<{ projects: Project[]; documents: DocumentSummary[]; tags: Tag[] }>;
  searchDocuments(search: DocumentSearch): Promise<string[]>;
  createProject(name: string): Promise<Project>;
  deleteProject(id: string): Promise<void>;
  createDocument(title: string, projectId: string | null): Promise<WorkspaceDocument>;
  importDocuments(projectId: string | null): Promise<number>;
  document(id: string): Promise<WorkspaceDocument>;
  updateDocument(id: string, title: string, projectId: string | null): Promise<WorkspaceDocument>;
  deleteDocument(id: string): Promise<void>;
  saveMarkdown(id: string, markdown: string, revision: number): Promise<WorkspaceDocument>;
  setTags(id: string, names: string[]): Promise<DocumentSummary>;
  openDocument(source: Source): Promise<void>;
  asset(id: string): Promise<Uint8Array>;
  annotations(id: string): Promise<Annotation[]>;
  addAnnotation(id: string, anchor: Anchor, text: string): Promise<Annotation>;
  updateAnnotation(id: string, text: string): Promise<void>;
  deleteAnnotation(id: string): Promise<void>;
  history(id: string): Promise<Omit<Version, 'markdown'>[]>;
  version(id: string, versionId: string): Promise<Version>;
  restoreVersion(id: string, versionId: string, revision: number): Promise<WorkspaceDocument>;
  tasks(): Promise<Task[]>;
  createTask(input: TaskInput): Promise<Task>;
  updateTask(id: string, input: Omit<TaskInput, 'source'>): Promise<Task>;
  toggleTask(id: string, done: boolean): Promise<void>;
  deleteTask(id: string): Promise<void>;
  reorderTasks(ids: string[]): Promise<Task[]>;
  resetTaskOrder(): Promise<Task[]>;
  markdownLayout(): Promise<MarkdownLayout>;
  saveMarkdownLayout(layout: MarkdownLayout): Promise<MarkdownLayout>;
  exportDocument(id: string, format: DocumentFormat): Promise<boolean>;
  exportWorkspace(): Promise<boolean>;
  previewImport(): Promise<ImportPreview | null>;
  finishImport(token: string): Promise<void>;
  cancelImport(token: string): Promise<void>;
  chatSettings(): Promise<{ keyConfigured: boolean; model: string }>;
  saveChatSettings(model: string, key?: string): Promise<void>;
  sendChat(messages: ChatMessage[]): Promise<string>;
  onWorkspaceChange(callback: () => void): () => void;
  onMarkdownLayoutChange(callback: (layout: MarkdownLayout) => void): () => void;
  onOpenSource(callback: (source: Source) => void): () => void;
  onFlushDocument(callback: (ticket: string) => void): () => void;
  completeFlush(ticket: string, error?: string): void;
}
