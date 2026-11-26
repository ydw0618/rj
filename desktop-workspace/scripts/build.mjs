// BlockSuite's editor and syntax grammars require more memory when all cores minify in parallel.
process.env.RAYON_NUM_THREADS ??= '2';

const { build } = await import('electron-vite');
await build();
