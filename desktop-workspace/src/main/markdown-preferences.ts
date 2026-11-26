import { randomUUID } from 'node:crypto';
import { readFile, rename, rm, writeFile } from 'node:fs/promises';
import { defaultMarkdownLayout, type MarkdownLayout } from '../shared/contracts';
import { markdownLayout } from '../shared/validation';

export class MarkdownPreferences {
  private value = defaultMarkdownLayout;
  private pending: Promise<unknown> = Promise.resolve();

  constructor(private readonly path: string) {}

  async load() {
    try {
      this.value = markdownLayout.parse(JSON.parse(await readFile(this.path, 'utf8')));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') console.error('Unable to read Markdown layout:', error);
    }
  }

  current() { return this.value; }

  save(input: MarkdownLayout) {
    const value = markdownLayout.parse(input);
    const commit = this.pending.catch(() => {}).then(async () => {
      const temp = this.path + '.' + randomUUID() + '.tmp';
      try {
        await writeFile(temp, JSON.stringify(value), { flag: 'wx' });
        await rename(temp, this.path);
      } finally {
        await rm(temp, { force: true });
      }
      this.value = value;
      return value;
    });
    this.pending = commit;
    return commit;
  }
}
