import { z } from 'zod';

export const markdownLayout = z.object({
  fontSize: z.int().min(13).max(22),
  lineHeight: z.number().min(1.35).max(2.4),
  paragraphGap: z.int().min(0).max(28),
  indentParagraphs: z.boolean(),
});

export const id = z.uuid();
export const date = z.iso.datetime();
export const name = z.string().trim().min(1).max(150);
export const markdown = z.string().max(8_000_000);
export const note = z.string().trim().min(1).max(12_000);
const kind = z.enum(['markdown', 'pdf', 'image']);
export const documentSearch = z.object({
  query: z.string().trim().max(250), includeBody: z.boolean(), projectId: id.nullable(), kind: kind.nullable(),
  tagIds: z.array(id).max(100), updatedFrom: date.nullable(), updatedBefore: date.nullable(),
}).refine((filter) => !filter.updatedFrom || !filter.updatedBefore || filter.updatedFrom < filter.updatedBefore);
const proportion = z.number().min(0).max(1);
export const anchor = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('markdown'), quote: z.string().min(1).max(4000),
    prefix: z.string().max(80), suffix: z.string().max(80), offset: z.int().min(0),
  }),
  z.object({
    type: z.literal('pdf'), page: z.int().min(1),
    rect: z.object({ x: proportion, y: proportion, width: proportion, height: proportion })
      .refine((rect) => rect.x + rect.width <= 1.00001 && rect.y + rect.height <= 1.00001),
    quote: z.string().max(4000).optional(),
  }),
]);
export const source = z.object({ documentId: id, annotationId: id.optional(), anchor: anchor.optional() });
const taskBase = z.object({ title: name, deadline: date.nullable(), projectId: id.nullable(), source: source.optional() });
export const taskInput = taskBase.extend({ important: z.boolean(), urgent: z.boolean() });
const taskArchiveBase = { id, done: z.boolean(), createdAt: date };
export const chatMessages = z.array(z.object({
  role: z.enum(['user', 'assistant']), content: z.string().min(1).max(60_000),
})).min(1).max(80).refine((items) => items.reduce((sum, item) => sum + item.content.length, 0) <= 240_000);
export const mediaType = z.enum(['application/pdf', 'image/png', 'image/jpeg', 'image/webp', 'image/gif']);
export const storedDocument = z.object({
  id, title: name, projectId: id.nullable(), updatedAt: date, revision: z.int().min(0), tagsEdited: z.boolean(),
  kind, markdown: markdown.nullable(),
  mediaType: mediaType.nullable(), asset: id.nullable(),
}).refine((item) => item.kind === 'markdown'
  ? item.markdown !== null && item.mediaType === null && item.asset === null
  : item.markdown === null && item.asset !== null && (item.kind === 'pdf'
    ? item.mediaType === 'application/pdf'
    : item.mediaType?.startsWith('image/')));
const manifestBase = z.object({
  format: z.literal('ydw-workspace'),
  projects: z.array(z.object({ id, name })),
  documents: z.array(storedDocument),
  documentTags: z.array(z.object({ documentId: id, name })),
  versions: z.array(z.object({ id, documentId: id, createdAt: date, revision: z.int().min(0), markdown })),
  annotations: z.array(z.object({ id, documentId: id, anchor, text: note, createdAt: date })),
});
const manifestV2 = manifestBase.extend({
  version: z.literal(2),
  tasks: z.array(taskInput.extend({ ...taskArchiveBase, position: z.int().min(0).nullable() })),
});
const manifestV1 = manifestBase.extend({
  version: z.literal(1),
  tasks: z.array(taskBase.extend({ ...taskArchiveBase, priority: z.enum(['high', 'normal', 'low']) })),
});
export const manifestSchema = z.discriminatedUnion('version', [manifestV2, manifestV1]).transform((manifest): z.infer<typeof manifestV2> => {
  if (manifest.version === 2) return manifest;
  return {
    ...manifest, version: 2,
    tasks: manifest.tasks.map(({ priority, ...task }) => ({
      ...task, important: priority === 'high', urgent: false, position: null,
    })),
  };
});
export type Manifest = z.infer<typeof manifestSchema>;
export type StoredDocument = z.infer<typeof storedDocument>;
