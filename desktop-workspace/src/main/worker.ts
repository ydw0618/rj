import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { MAX_ARCHIVE, packWorkspace, unpackWorkspace } from './archive';
import { inferTags } from './tags';
import type { Job } from './worker-types';

async function atomicWrite(destination: string, bytes: Uint8Array) {
  const temporary = join(dirname(destination), '.' + basename(destination) + '.' + randomUUID() + '.tmp');
  try {
    await writeFile(temporary, bytes, { flag: 'wx' });
    await rename(temporary, destination);
  } finally {
    await rm(temporary, { force: true }).catch(() => {});
  }
}

async function run(job: Job) {
  switch (job.type) {
    case 'remove-asset': return rm(job.path, { force: true });
    case 'tags': return inferTags(job.title, job.markdown);
    case 'export-workspace': {
      const assets = new Map<string, Uint8Array>();
      let size = 0;
      for (const document of job.manifest.documents) {
        if (!document.asset) continue;
        const path = join(job.assetsDir, document.asset);
        size += (await stat(path)).size;
        if (size > MAX_ARCHIVE) throw new Error('工作空间超出当前迁移包的大小限制。');
        assets.set(document.asset, await readFile(path));
      }
      await atomicWrite(job.destination, packWorkspace(job.manifest, assets));
      return;
    }
    case 'stage-workspace': {
      if ((await stat(job.source)).size > MAX_ARCHIVE + 1024 * 1024) throw new Error('迁移包过大。');
      const { manifest, assets } = unpackWorkspace(await readFile(job.source));
      for (const [id, bytes] of assets) await writeFile(join(job.staging, id), bytes, { flag: 'wx' });
      return manifest;
    }
    case 'pdf-notes': {
      const { annotatedPdf } = await import('./exports');
      await atomicWrite(job.destination, await annotatedPdf(await readFile(job.source), job.annotations));
      return;
    }
    case 'docx': {
      const { markdownDocx } = await import('./exports');
      await atomicWrite(job.destination, await markdownDocx(job.title, job.markdown, job.layout));
      return;
    }
    case 'print-html': {
      const { markdownPrintHtml } = await import('./exports');
      return markdownPrintHtml(job.title, job.markdown, job.layout);
    }
  }
}

run(workerData as Job).then(
  (result) => parentPort?.postMessage({ ok: true, result }),
  (error: unknown) => parentPort?.postMessage({ ok: false, message: error instanceof Error ? error.message : String(error) }),
);
