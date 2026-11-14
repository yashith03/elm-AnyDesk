import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '../..');
const releaseDir = path.resolve(desktopDir, 'release');
const unpackedDir = path.resolve(releaseDir, 'win-unpacked');
const VERSION = '0.5.0';
const INSTALLER_NAME = `Elm-AnyDesk-Setup-${VERSION}-x64.exe`;
const installerExePath = path.resolve(releaseDir, INSTALLER_NAME);

function copyDirRecursive(src, dest, filterFn = () => true) {
  fs.mkdirSync(dest, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const srcPath = path.join(src, entry.name);
    const destPath = path.join(dest, entry.name);
    if (!filterFn(srcPath, entry)) continue;
    if (entry.isDirectory()) {
      copyDirRecursive(srcPath, destPath, filterFn);
    } else if (entry.isFile()) {
      fs.copyFileSync(srcPath, destPath);
    }
  }
}

console.log('1. Cleaning previous release directory...');
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(unpackedDir, { recursive: true });

const electronDistDir = path.resolve(repoRoot, 'node_modules/electron/dist');
if (!fs.existsSync(electronDistDir)) {
  throw new Error(`Electron runtime not found at ${electronDistDir}`);
}

console.log('2. Packaging standalone Windows x64 Electron runtime into release/win-unpacked...');
copyDirRecursive(electronDistDir, unpackedDir, (_srcPath, entry) => {
  // Exclude default_app.asar so Electron boots directly into resources/app
  if (entry.name === 'default_app.asar') return false;
  // Keep only en-US.pak locale to keep installer compact and fast
  if (_srcPath.includes(`${path.sep}locales${path.sep}`) && entry.name !== 'en-US.pak') {
    return false;
  }
  return true;
});

const rawElectronExe = path.join(unpackedDir, 'electron.exe');
const brandedExe = path.join(unpackedDir, 'Elm-AnyDesk.exe');
if (fs.existsSync(rawElectronExe)) {
  fs.renameSync(rawElectronExe, brandedExe);
}

console.log('3. Copying built @elm/desktop application bundle (strictly separate from @elm/api backend)...');
const appResourceDir = path.join(unpackedDir, 'resources', 'app');
fs.mkdirSync(appResourceDir, { recursive: true });

// Copy compiled dist (main, preload, renderer, native wasapi-loopback.exe)
copyDirRecursive(
  path.join(desktopDir, 'dist'),
  path.join(appResourceDir, 'dist'),
  (srcPath, entry) => {
    if (entry.name.endsWith('.map') || entry.name === 'prototype-suite-report.json') {
      return false;
    }
    return true;
  }
);

// Copy minimal runtime package.json for packaged Electron app (no devDependencies, no backend references, no auto-updater)
const packagedPkgJson = {
  name: 'elm-anydesk',
  productName: 'Elm-AnyDesk',
  version: VERSION,
  private: true,
  main: 'dist/main/index.cjs',
  description: 'Consent-based 1:1 screen sharing, optional audio, and private chat for Windows 11',
  elmPilotConfig: {
    stunOnly: true,
    turnEnabled: false,
    paidServicesEnabled: false,
    autoUpgradeEnabled: false,
    packagedSeparatelyFromBackend: true,
  },
};
fs.writeFileSync(
  path.join(appResourceDir, 'package.json'),
  JSON.stringify(packagedPkgJson, null, 2),
  'utf8'
);

// Copy only win32_x64 koffi runtime & @koromix/koffi-win32-x64 native addon required by Win11 DWM FFI
const koffiSrcDir = path.resolve(repoRoot, 'node_modules/koffi');
const koffiDestDir = path.join(appResourceDir, 'node_modules', 'koffi');
if (fs.existsSync(koffiSrcDir)) {
  copyDirRecursive(koffiSrcDir, koffiDestDir, (_src, entry) => {
    return entry.name !== 'doc' && entry.name !== 'vendor' && entry.name !== 'lib';
  });
}

const koromixSrcDir = path.resolve(
  repoRoot,
  'node_modules/@koromix/koffi-win32-x64'
);
const koromixDestDir = path.join(
  appResourceDir,
  'node_modules',
  '@koromix',
  'koffi-win32-x64'
);
if (fs.existsSync(koromixSrcDir)) {
  copyDirRecursive(koromixSrcDir, koromixDestDir);
}

console.log('4. Creating compressed payload archive and compiling Windows 11 Setup Installer (.exe)...');
const payloadZipPath = path.join(releaseDir, 'app-payload.zip');
const installerCsPath = path.join(releaseDir, 'ElmAnyDeskInstaller.cs');
const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const compressionDll =
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.IO.Compression.FileSystem.dll';
const compressionCoreDll =
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.IO.Compression.dll';

// Use a small .NET helper orZipFile via PowerShell/csc to create app-payload.zip deterministically
const zipBuilderCs = path.join(releaseDir, 'ZipBuilder.cs');
fs.writeFileSync(
  zipBuilderCs,
  `
using System;
using System.IO;
using System.IO.Compression;
class Program {
  static int Main(string[] args) {
    if (File.Exists(args[1])) File.Delete(args[1]);
    ZipFile.CreateFromDirectory(args[0], args[1], CompressionLevel.Fastest, false);
    return 0;
  }
}
`,
  'utf8'
);
const zipBuilderExe = path.join(releaseDir, 'ZipBuilder.exe');
execFileSync(
  cscPath,
  [
    '-nologo',
    `-r:${compressionDll}`,
    `-r:${compressionCoreDll}`,
    `-out:${zipBuilderExe}`,
    zipBuilderCs,
  ],
  { stdio: 'inherit' }
);
execFileSync(zipBuilderExe, [unpackedDir, payloadZipPath], { stdio: 'inherit' });
fs.rmSync(zipBuilderCs, { force: true });
fs.rmSync(zipBuilderExe, { force: true });

// Write the self-contained Windows Setup Installer source (supports --silent, --install-dir=<path>, and interactive GUI prompt)
fs.writeFileSync(
  installerCsPath,
  `
using System;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using Microsoft.Win32;

namespace ElmAnyDeskSetup {
  class Program {
    static int Main(string[] args) {
      bool silent = false;
      string targetDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs",
        "Elm-AnyDesk"
      );
      bool skipRegistry = false;

      foreach (string arg in args) {
        if (arg.Equals("--silent", StringComparison.OrdinalIgnoreCase) ||
            arg.Equals("/S", StringComparison.OrdinalIgnoreCase)) {
          silent = true;
        } else if (arg.StartsWith("--install-dir=", StringComparison.OrdinalIgnoreCase)) {
          targetDir = arg.Substring("--install-dir=".Length).Trim('"');
          skipRegistry = true;
        }
      }

      try {
        if (!silent) {
          Console.WriteLine("============================================================");
          Console.WriteLine(" Elm-AnyDesk Windows 11 Setup Installer (v${VERSION} x64)");
          Console.WriteLine(" Zero-Bill STUN-Only Pilot | Auto-Upgrade Disabled");
          Console.WriteLine("============================================================");
          Console.WriteLine("Target Directory: " + targetDir);
        }

        if (Directory.Exists(targetDir)) {
          Directory.Delete(targetDir, true);
        }
        Directory.CreateDirectory(targetDir);

        Assembly asm = Assembly.GetExecutingAssembly();
        using (Stream payloadStream = asm.GetManifestResourceStream("ElmAnyDesk.Payload.zip")) {
          if (payloadStream == null) {
            Console.Error.WriteLine("Embedded payload resource not found.");
            return 2;
          }
          string tempZip = Path.Combine(Path.GetTempPath(), "elm-anydesk-setup-" + Guid.NewGuid().ToString("N") + ".zip");
          try {
            using (FileStream fs = new FileStream(tempZip, FileMode.Create, FileAccess.Write)) {
              payloadStream.CopyTo(fs);
            }
            ZipFile.ExtractToDirectory(tempZip, targetDir);
          } finally {
            if (File.Exists(tempZip)) File.Delete(tempZip);
          }
        }

        string receiptJson = "{\\n" +
          "  \\"appName\\": \\"Elm-AnyDesk\\",\\n" +
          "  \\"version\\": \\"${VERSION}\\",\\n" +
          "  \\"installedAt\\": \\"" + DateTime.UtcNow.ToString("o") + "\\",\\n" +
          "  \\"installDir\\": \\"" + targetDir.Replace("\\\\", "\\\\\\\\") + "\\",\\n" +
          "  \\"stunOnlyPilot\\": true,\\n" +
          "  \\"turnEnabled\\": false,\\n" +
          "  \\"autoUpgradeEnabled\\": false,\\n" +
          "  \\"packagedSeparatelyFromBackend\\": true\\n" +
          "}";
        File.WriteAllText(Path.Combine(targetDir, "install-receipt.json"), receiptJson);

        string uninstallCmd = "@echo off\\r\\n" +
          "echo Uninstalling Elm-AnyDesk...\\r\\n" +
          "reg delete \\"HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Elm-AnyDesk\\" /f >nul 2>&1\\r\\n" +
          "cd /d \\"%TEMP%\\"\\r\\n" +
          "rmdir /s /q \\"" + targetDir + "\\"\\r\\n";
        File.WriteAllText(Path.Combine(targetDir, "Uninstall-Elm-AnyDesk.cmd"), uninstallCmd);

        if (!skipRegistry) {
          using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Elm-AnyDesk")) {
            if (key != null) {
              key.SetValue("DisplayName", "Elm-AnyDesk (Windows 11 Pilot)");
              key.SetValue("DisplayVersion", "${VERSION}");
              key.SetValue("Publisher", "Elm-AnyDesk Pilot");
              key.SetValue("InstallLocation", targetDir);
              key.SetValue("DisplayIcon", Path.Combine(targetDir, "Elm-AnyDesk.exe"));
              key.SetValue("UninstallString", Path.Combine(targetDir, "Uninstall-Elm-AnyDesk.cmd"));
              key.SetValue("NoModify", 1, RegistryValueKind.DWord);
              key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
          }
        }

        if (!silent) {
          Console.WriteLine("Installation completed successfully: " + Path.Combine(targetDir, "Elm-AnyDesk.exe"));
        }
        return 0;
      } catch (Exception ex) {
        Console.Error.WriteLine("Installer failed: " + ex.Message);
        return 1;
      }
    }
  }
}
`,
  'utf8'
);

execFileSync(
  cscPath,
  [
    '-nologo',
    '-optimize+',
    '-platform:x64',
    `-r:${compressionDll}`,
    `-r:${compressionCoreDll}`,
    `-resource:${payloadZipPath},ElmAnyDesk.Payload.zip`,
    `-out:${installerExePath}`,
    installerCsPath,
  ],
  { stdio: 'inherit' }
);

fs.rmSync(installerCsPath, { force: true });
fs.rmSync(payloadZipPath, { force: true });

// Compute SHA-256 checksum of the built installer .exe
const installerBytes = fs.readFileSync(installerExePath);
const sha256 = crypto.createHash('sha256').update(installerBytes).digest('hex');
const installerStat = fs.statSync(installerExePath);

fs.writeFileSync(
  `${installerExePath}.sha256`,
  `${sha256}  ${INSTALLER_NAME}\n`,
  'utf8'
);

console.log('5. Running clean-install verification test on Windows 11...');
const tempInstallDir = path.join(
  os.tmpdir(),
  `elm-anydesk-clean-install-test-${Date.now()}`
);
let cleanInstallVerified = false;
let verifiedFiles = [];
try {
  execFileSync(
    installerExePath,
    ['--silent', `--install-dir=${tempInstallDir}`],
    { stdio: 'inherit' }
  );

  const requiredRelativePaths = [
    'Elm-AnyDesk.exe',
    'install-receipt.json',
    'Uninstall-Elm-AnyDesk.cmd',
    'resources/app/package.json',
    'resources/app/dist/main/index.cjs',
    'resources/app/dist/preload/index.cjs',
    'resources/app/dist/renderer/index.html',
    'resources/app/dist/native/wasapi-loopback.exe',
    'resources/app/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
  ];

  verifiedFiles = requiredRelativePaths.map((rel) => {
    const abs = path.join(tempInstallDir, rel);
    const exists = fs.existsSync(abs);
    if (!exists) {
      throw new Error(`Clean install verification missing required file: ${rel}`);
    }
    return rel;
  });

  // Verify no backend files exist inside the installed desktop package
  const forbiddenBackendPaths = ['wrangler.jsonc', 'migrations', '.dev.vars'];
  for (const forbidden of forbiddenBackendPaths) {
    if (
      fs.existsSync(path.join(tempInstallDir, forbidden)) ||
      fs.existsSync(path.join(tempInstallDir, 'resources/app', forbidden))
    ) {
      throw new Error(`Backend file leaked into desktop installer: ${forbidden}`);
    }
  }

  cleanInstallVerified = true;
} finally {
  fs.rmSync(tempInstallDir, { recursive: true, force: true });
}

const manifest = {
  appName: 'Elm-AnyDesk',
  version: VERSION,
  installerFilename: INSTALLER_NAME,
  installerPath: installerExePath,
  installerSizeBytes: installerStat.size,
  installerSha256: sha256,
  unpackedExePath: brandedExe,
  packagedSeparatelyFromBackend: true,
  autoUpgradeEnabled: false,
  stunOnlyPilot: true,
  turnEnabled: false,
  paidServicesEnabled: false,
  cleanInstallSmokeTestPassed: cleanInstallVerified,
  cleanInstallVerifiedFiles: verifiedFiles,
  builtAt: new Date().toISOString(),
};

fs.writeFileSync(
  path.join(releaseDir, 'installer-manifest.json'),
  JSON.stringify(manifest, null, 2),
  'utf8'
);

console.log(`✓ Built Windows 11 Installer: ${installerExePath}`);
console.log(`✓ SHA-256: ${sha256}`);
console.log(`✓ Size: ${(installerStat.size / (1024 * 1024)).toFixed(2)} MB`);
console.log(`✓ Clean-install smoke test passed: ${cleanInstallVerified}`);
