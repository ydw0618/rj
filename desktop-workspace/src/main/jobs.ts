import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import type { Job } from './worker-types';

let queue: Promise<unknown> = Promise.resolve();

export function runJob<T = void>(data: Job): Promise<T> {
  function launch() {
    return new Promise<T>((resolve, reject) => {
      const worker = new Worker(join(__dirname, 'worker.js'), { workerData: data });
      worker.once('message', (message: { ok: boolean; result: T; message?: string }) => {
        if (message.ok) resolve(message.result);
        else reject(new Error(message.message ?? '后台任务失败。'));
      });
      worker.once('error', reject);
      worker.once('exit', (code) => reject(new Error('后台任务提前结束（' + code + '）。')));
    });
  }
  if (data.type === 'tags') return launch();
  const job = queue.then(launch, launch);
  queue = job;
  return job;
}
