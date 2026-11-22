import { execSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const SOURCE_DIRS = [
  path.join(repoRoot, 'packages/protocol/src'),
  path.join(repoRoot, 'apps/api/src'),
  path.join(repoRoot, 'apps/desktop/src'),
];

const FORBIDDEN_PATTERNS = [
  {
    regex: /\bsetContentProtection\b/,
    allowInFile: 'capture-protection.ts',
    reason: 'BrowserWindow.setContentProtection must be centralized in apps/desktop/src/main/capture-protection.ts',
  },
  {
    regex: /\bWDA_EXCLUDEFROMCAPTURE\b/,
    reason: 'Raw WDA_EXCLUDEFROMCAPTURE stealth hooks are prohibited by PROJECT_BRIEF.md',
  },
  {
    regex: /\belectron-updater\b|\bautoUpdater\b/,
    reason: 'Automatic upgrades must not be enabled in the pilot phase',
  },
  {
    regex: /urls:\s*['"`]turns?:[a-z0-9.-]/i,
    allowInFile: 'webrtc-session.ts',
    reason: 'Paid TURN relay servers must not be enabled in the STUN-only zero-bill pilot',
  },
  {
    regex: /fonts\.googleapis\.com|fonts\.gstatic\.com|use\.typekit\.net/i,
    reason: 'Fonts must be bundled locally; loading fonts from a CDN at runtime is prohibited',
  },
];

function collectFiles(dir, out = []) {
  if (!fs.existsSync(dir)) return out;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      collectFiles(full, out);
    } else if (/\.(ts|tsx|js|mjs|cjs|css|html)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

let filesChecked = 0;
for (const dir of SOURCE_DIRS) {
  for (const file of collectFiles(dir)) {
    filesChecked += 1;
    const content = fs.readFileSync(file, 'utf8');
    for (const rule of FORBIDDEN_PATTERNS) {
      if (rule.allowInFile && file.endsWith(rule.allowInFile)) continue;
      if (rule.regex.test(content)) {
        throw new Error(
          `Policy lint failure in ${path.relative(repoRoot, file)}: ${rule.reason}`
        );
      }
    }
  }
}

// Verify no secret files (.env or .dev.vars) are tracked in git
const trackedFiles = execSync('git ls-files', {
  cwd: repoRoot,
  encoding: 'utf8',
})
  .split(/\r?\n/)
  .filter(Boolean);

for (const tracked of trackedFiles) {
  const base = path.basename(tracked);
  if (
    (base === '.env' || base === '.dev.vars' || base.startsWith('.env.')) &&
    !base.endsWith('.example')
  ) {
    throw new Error(`Secret file must never be tracked in git: ${tracked}`);
  }
}

console.log(
  `✓ Lint & policy verification passed across ${filesChecked} source files (STUN-only, no TURN, no auto-updater, no capture evasion, no tracked secrets).`
);
