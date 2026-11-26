import { randomUUID } from 'node:crypto';
import { unzipSync, zipSync, strFromU8, strToU8 } from 'fflate';
import { manifestSchema, type Manifest } from '../shared/validation';

export const MAX_ASSET = 120 * 1024 * 1024;
export const MAX_ARCHIVE = 512 * 1024 * 1024;
const MAX_MANIFEST = 128 * 1024 * 1024;
const assetEntry = (id: string) => 'assets/' + id;

function assertUnique(values: string[]) {
  if (new Set(values).size !== values.length) throw new Error('工作空间内存在重复标识。');
}

export function validateManifest(manifest: Manifest) {
  const projects = new Set(manifest.projects.map((item) => item.id));
  const documents = new Map(manifest.documents.map((item) => [item.id, item]));
  const annotations = new Map(manifest.annotations.map((item) => [item.id, item]));
  assertUnique(manifest.projects.map((item) => item.id));
  assertUnique(manifest.documents.map((item) => item.id));
  assertUnique(manifest.documents.flatMap((item) => item.asset ? [item.asset] : []));
  assertUnique(manifest.versions.map((item) => item.id));
  assertUnique(manifest.versions.map((item) => item.documentId + ':' + item.revision));
  assertUnique(manifest.annotations.map((item) => item.id));
  assertUnique(manifest.tasks.map((item) => item.id));
  const valid = manifest.documents.every((item) => !item.projectId || projects.has(item.projectId))
    && manifest.documentTags.every((item) => documents.has(item.documentId))
    && manifest.versions.every((item) => {
      const parent = documents.get(item.documentId);
      return parent?.kind === 'markdown' && item.revision <= parent.revision;
    })
    && manifest.annotations.every((item) => documents.get(item.documentId)?.kind === item.anchor.type)
    && manifest.tasks.every((item) => (!item.projectId || projects.has(item.projectId)) && (!item.source
      || (documents.has(item.source.documentId) && (!item.source.anchor || documents.get(item.source.documentId)?.kind === item.source.anchor.type) && (!item.source.annotationId
        || annotations.get(item.source.annotationId)?.documentId === item.source.documentId))));
  if (!valid) throw new Error('工作空间内存在找不到原资料的记录。');
  return manifest;
}

export function packWorkspace(manifest: Manifest, assets: Map<string, Uint8Array>) {
  const json = strToU8(JSON.stringify(manifest));
  let total = json.length;
  if (total > MAX_MANIFEST) throw new Error('编辑历史超出当前迁移包的大小限制。');
  const entries: Record<string, Uint8Array | [Uint8Array, { level: 0 }]> = { 'workspace.json': json };
  for (const item of manifest.documents) {
    if (!item.asset) continue;
    const bytes = assets.get(item.asset);
    if (!bytes) throw new Error('迁移包缺少一份原始资料。');
    total += bytes.length;
    if (total > MAX_ARCHIVE) throw new Error('工作空间超出当前迁移包的大小限制。');
    entries[assetEntry(item.asset)] = [bytes, { level: 0 }];
  }
  return zipSync(entries, { level: 6 });
}

export function unpackWorkspace(bytes: Uint8Array) {
  if (bytes.length > MAX_ARCHIVE + 1024 * 1024) throw new Error('迁移包过大。');
  const seen = new Set<string>();
  let total = 0;
  const entries = unzipSync(bytes, {
    filter({ name, originalSize }) {
      const manifest = name === 'workspace.json';
      if ((!manifest && !/^assets\/[0-9a-f-]{36}$/i.test(name)) || seen.has(name)
        || originalSize > (manifest ? MAX_MANIFEST : MAX_ASSET) || seen.size > 20_000) {
        throw new Error('迁移包中含有无效或超限的文件。');
      }
      seen.add(name);
      total += originalSize;
      if (total > MAX_ARCHIVE) throw new Error('迁移包解压后超出大小限制。');
      return true;
    },
  });
  if (!entries['workspace.json']) throw new Error('文件不是有效的工作空间迁移包。');
  const manifest = validateManifest(manifestSchema.parse(JSON.parse(strFromU8(entries['workspace.json']))));
  const assets = new Map<string, Uint8Array>();
  for (const document of manifest.documents) {
    if (!document.asset) continue;
    const entry = entries[assetEntry(document.asset)];
    if (!entry) throw new Error('迁移包缺少一份原始资料。');
    assets.set(document.asset, entry);
  }
  if (assets.size + 1 !== seen.size) throw new Error('迁移包含有未关联的资料。');
  return { manifest, assets };
}

export function remapWorkspace(manifest: Manifest, copy: boolean): Manifest {
  const ids = new Map<string, string>();
  const remap = (value: string) => {
    if (!copy) return value;
    const mapped = ids.get(value) ?? randomUUID();
    ids.set(value, mapped);
    return mapped;
  };
  const nullable = (value: string | null) => value ? remap(value) : null;
  return {
    ...manifest,
    projects: manifest.projects.map((item) => ({ ...item, id: remap(item.id) })),
    documents: manifest.documents.map((item) => ({ ...item, id: remap(item.id), projectId: nullable(item.projectId), asset: nullable(item.asset) })),
    documentTags: manifest.documentTags.map((item) => ({ ...item, documentId: remap(item.documentId) })),
    versions: manifest.versions.map((item) => ({ ...item, id: remap(item.id), documentId: remap(item.documentId) })),
    annotations: manifest.annotations.map((item) => ({ ...item, id: remap(item.id), documentId: remap(item.documentId) })),
    tasks: manifest.tasks.map((item) => ({
      ...item,
      id: remap(item.id),
      projectId: nullable(item.projectId),
      source: item.source && { ...item.source, documentId: remap(item.source.documentId), annotationId: item.source.annotationId ? remap(item.source.annotationId) : undefined },
    })),
  };
}
