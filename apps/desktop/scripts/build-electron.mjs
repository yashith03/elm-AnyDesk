import { build } from 'vite';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { generateMultiResolutionElmIcon } from './generate-elm-icon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function copyIconAssets() {
  const icoInfo = generateMultiResolutionElmIcon();
  const distAssetsDir = path.resolve(rootDir, 'dist', 'assets');
  fs.mkdirSync(distAssetsDir, { recursive: true });
  fs.copyFileSync(icoInfo.icoPath, path.join(distAssetsDir, 'elm-icon.ico'));
  fs.copyFileSync(
    icoInfo.png256Path,
    path.join(distAssetsDir, 'elm-icon-256.png')
  );
  console.log(`✓ Staged custom Elm multi-resolution icon into ${distAssetsDir}`);
}

function buildWasapiNativeHelper() {
  if (process.platform !== 'win32') {
    return;
  }

  const cscPath =
    'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
  const sourceFile = path.resolve(rootDir, 'native', 'WasapiLoopbackHelper.cs');
  const outDir = path.resolve(rootDir, 'dist', 'native');
  const outExe = path.resolve(outDir, 'wasapi-loopback.exe');

  fs.mkdirSync(outDir, { recursive: true });

  execFileSync(
    cscPath,
    ['-nologo', '-optimize+', `-out:${outExe}`, sourceFile],
    { stdio: 'inherit' }
  );
  console.log(`✓ Built Windows WASAPI loopback helper: ${outExe}`);
}

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
        external: ['electron', 'koffi', /^node:/],
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

copyIconAssets();
buildWasapiNativeHelper();
await buildEntry('src/main/index.ts', 'dist/main');
await buildEntry('src/preload/index.ts', 'dist/preload');
