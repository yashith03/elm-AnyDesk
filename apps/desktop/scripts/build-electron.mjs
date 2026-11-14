import { build } from 'vite';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

async function buildEntry(entryRelPath, outDirRelPath) {
  await build({
    configFile: false,
    root: rootDir,
    build: {
      ssr: path.resolve(rootDir, entryRelPath),
      outDir: path.resolve(rootDir, outDirRelPath),
      emptyOutDir: true,
      sourcemap: true,
      target: 'node20',
      rollupOptions: {
        external: ['electron', /^node:/],
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
    ssr: {
      noExternal: ['@elm/protocol'],
    },
    logLevel: 'info',
  });
}

await buildEntry('src/main/index.ts', 'dist/main');
await buildEntry('src/preload/index.ts', 'dist/preload');
