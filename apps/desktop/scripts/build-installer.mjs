import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import koffi from 'koffi';
import { generateMultiResolutionElmIcon } from './generate-elm-icon.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const repoRoot = path.resolve(desktopDir, '../..');
const releaseDir = path.resolve(desktopDir, 'release');
const unpackedDir = path.resolve(releaseDir, 'win-unpacked');
const VERSION = '1.0.1';
const APP_ID = 'com.elm.anydesk';
const APP_NAME = 'Elm-AnyDesk';
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

/**
 * Replaces the Win32 PE RT_GROUP_ICON (14) and RT_ICON (3) resources inside targetExePath
 * with the multi-resolution icon frames from icoFilePath using kernel32 UpdateResourceW.
 */
function embedMultiResolutionIcoIntoPeExecutable(targetExePath, icoFilePath) {
  const icoBuf = fs.readFileSync(icoFilePath);
  const reserved = icoBuf.readUInt16LE(0);
  const type = icoBuf.readUInt16LE(2);
  const count = icoBuf.readUInt16LE(4);
  if (reserved !== 0 || type !== 1 || count < 1) {
    throw new Error(`Invalid .ico file header in ${icoFilePath}`);
  }

  // Build GRPICONDIR (6-byte header + count * 14-byte GRPICONDIRENTRY)
  const grpIconDir = Buffer.alloc(6 + count * 14);
  icoBuf.copy(grpIconDir, 0, 0, 6);

  const iconFrames = [];
  for (let i = 0; i < count; i++) {
    const entryOffset = 6 + i * 16;
    const grpOffset = 6 + i * 14;
    // Copy first 12 bytes of ICONDIRENTRY (width, height, colorCount, reserved, planes, bitCount, bytesInRes)
    icoBuf.copy(grpIconDir, grpOffset, entryOffset, entryOffset + 12);
    const bytesInRes = icoBuf.readUInt32LE(entryOffset + 8);
    const imageOffset = icoBuf.readUInt32LE(entryOffset + 12);
    const resourceId = i + 1;
    grpIconDir.writeUInt16LE(resourceId, grpOffset + 12);
    iconFrames.push({
      id: resourceId,
      data: icoBuf.subarray(imageOffset, imageOffset + bytesInRes),
    });
  }

  const kernel32 = koffi.load('kernel32.dll');
  const BeginUpdateResourceW = kernel32.func(
    'uintptr_t __stdcall BeginUpdateResourceW(str16 pFileName, int32 bDeleteExistingResources)'
  );
  const UpdateResourceW = kernel32.func(
    'int32 __stdcall UpdateResourceW(uintptr_t hUpdate, uintptr_t lpType, uintptr_t lpName, uint16 wLanguage, const void* lpData, uint32 cb)'
  );
  const EndUpdateResourceW = kernel32.func(
    'int32 __stdcall EndUpdateResourceW(uintptr_t hUpdate, int32 fDiscard)'
  );

  const RT_ICON = 3n;
  const RT_GROUP_ICON = 14n;
  const LANG_EN_US = 1033;

  const hUpdate = BeginUpdateResourceW(targetExePath, 0);
  if (!hUpdate) {
    throw new Error(`BeginUpdateResourceW failed for ${targetExePath}`);
  }

  for (const frame of iconFrames) {
    const ok = UpdateResourceW(
      hUpdate,
      RT_ICON,
      BigInt(frame.id),
      LANG_EN_US,
      frame.data,
      frame.data.length
    );
    if (!ok) {
      EndUpdateResourceW(hUpdate, 1);
      throw new Error(`UpdateResourceW(RT_ICON, ${frame.id}) failed`);
    }
  }

  // Update group icon ID 1 (the primary application icon in Electron's PE binary)
  const okGroup = UpdateResourceW(
    hUpdate,
    RT_GROUP_ICON,
    1n,
    LANG_EN_US,
    grpIconDir,
    grpIconDir.length
  );
  if (!okGroup) {
    EndUpdateResourceW(hUpdate, 1);
    throw new Error('UpdateResourceW(RT_GROUP_ICON, 1) failed');
  }

  const committed = EndUpdateResourceW(hUpdate, 0);
  if (!committed) {
    throw new Error(`EndUpdateResourceW failed for ${targetExePath}`);
  }
}

console.log('1. Generating & verifying multi-resolution Elm icon (.ico)...');
const iconInfo = generateMultiResolutionElmIcon();
console.log(
  `   Icon source: ${iconInfo.icoPath} (resolutions: ${iconInfo.sizes.map((s) => `${s}x${s}`).join(', ')})`
);

console.log('2. Cleaning previous release directory...');
fs.rmSync(releaseDir, { recursive: true, force: true });
fs.mkdirSync(unpackedDir, { recursive: true });

const electronDistDir = path.resolve(repoRoot, 'node_modules/electron/dist');
if (!fs.existsSync(electronDistDir)) {
  throw new Error(`Electron runtime not found at ${electronDistDir}`);
}

console.log('3. Packaging standalone Windows x64 Electron runtime into release/win-unpacked...');
copyDirRecursive(electronDistDir, unpackedDir, (_srcPath, entry) => {
  if (entry.name === 'default_app.asar') return false;
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

// Embed our custom multi-resolution elm-icon.ico directly into Elm-AnyDesk.exe PE resources
embedMultiResolutionIcoIntoPeExecutable(brandedExe, iconInfo.icoPath);
// Also copy elm-icon.ico into the root of the installed directory as an installed icon resource
fs.copyFileSync(iconInfo.icoPath, path.join(unpackedDir, 'elm-icon.ico'));

console.log('4. Copying built @elm/desktop application bundle (strictly separate from @elm/api backend)...');
const appResourceDir = path.join(unpackedDir, 'resources', 'app');
fs.mkdirSync(appResourceDir, { recursive: true });

// Copy compiled dist (main, preload, renderer, assets/elm-icon.ico, native/wasapi-loopback.exe)
copyDirRecursive(
  path.join(desktopDir, 'dist'),
  path.join(appResourceDir, 'dist'),
  (_srcPath, entry) => {
    if (entry.name.endsWith('.map') || entry.name === 'prototype-suite-report.json') {
      return false;
    }
    return true;
  }
);

// Write minimal runtime package.json for packaged Electron app
const packagedPkgJson = {
  name: 'elm-anydesk',
  productName: APP_NAME,
  appId: APP_ID,
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

// Copy win32_x64 koffi runtime & @koromix/koffi-win32-x64 native addon required by Win11 DWM FFI
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

console.log('5. Creating compressed payload archive and compiling Windows 11 Setup Installer (.exe)...');
const payloadZipPath = path.join(releaseDir, 'app-payload.zip');
const installerCsPath = path.join(releaseDir, 'ElmAnyDeskInstaller.cs');
const cscPath = 'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\csc.exe';
const compressionDll =
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.IO.Compression.FileSystem.dll';
const compressionCoreDll =
  'C:\\Windows\\Microsoft.NET\\Framework64\\v4.0.30319\\System.IO.Compression.dll';

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

// Write the Windows 11 Setup Installer source:
// - Extracts Elm-AnyDesk.exe, elm-icon.ico, WASAPI helper, DWM Koffi addon, and renderer bundle
// - Automatically creates Desktop shortcut ("Elm-AnyDesk.lnk") and Start Menu shortcut ("Elm-AnyDesk.lnk")
// - Never pins the app to the taskbar
// - Points shortcut IconLocation to the installed Elm-AnyDesk.exe,0 (never inside the source repo)
// - Supports --uninstall and generates Uninstall-Elm-AnyDesk.cmd that removes shortcuts, registry entry, and install directory
fs.writeFileSync(
  installerCsPath,
  `
using System;
using System.Diagnostics;
using System.IO;
using System.IO.Compression;
using System.Reflection;
using System.Runtime.InteropServices;
using System.Runtime.InteropServices.ComTypes;
using System.Text;
using System.Threading;
using Microsoft.Win32;

namespace ElmAnyDeskSetup {
  [ComImport]
  [Guid("00021401-0000-0000-C000-000000000046")]
  internal class ShellLink {}

  [ComImport]
  [InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  [Guid("000214F9-0000-0000-C000-000000000046")]
  internal interface IShellLinkW {
    void GetPath([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszFile, int cchMaxPath, IntPtr pfd, int fFlags);
    void GetIDList(out IntPtr ppidl);
    void SetIDList(IntPtr pidl);
    void GetDescription([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszName, int cchMaxName);
    void SetDescription([MarshalAs(UnmanagedType.LPWStr)] string pszName);
    void GetWorkingDirectory([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszDir, int cchMaxPath);
    void SetWorkingDirectory([MarshalAs(UnmanagedType.LPWStr)] string pszDir);
    void GetArguments([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszArgs, int cchMaxPath);
    void SetArguments([MarshalAs(UnmanagedType.LPWStr)] string pszArgs);
    void GetHotkey(out short pwHotkey);
    void SetHotkey(short wHotkey);
    void GetShowCmd(out int piShowCmd);
    void SetShowCmd(int iShowCmd);
    void GetIconLocation([Out, MarshalAs(UnmanagedType.LPWStr)] StringBuilder pszIconPath, int cchIconPath, out int piIcon);
    void SetIconLocation([MarshalAs(UnmanagedType.LPWStr)] string pszIconPath, int iIcon);
    void SetRelativePath([MarshalAs(UnmanagedType.LPWStr)] string pszPathRel, int dwReserved);
    void Resolve(IntPtr hwnd, int fFlags);
    void SetPath([MarshalAs(UnmanagedType.LPWStr)] string pszFile);
  }

  class Program {
    static void StopRunningAppProcesses() {
      try {
        Process[] procs = Process.GetProcessesByName("Elm-AnyDesk");
        foreach (Process p in procs) {
          try {
            if (!p.HasExited) {
              p.Kill();
              p.WaitForExit(3000);
            }
          } catch {}
        }
        if (procs.Length > 0) {
          Thread.Sleep(250);
        }
      } catch {}
    }

    static void CreateWindowsShortcut(string shortcutPath, string targetExePath, string workingDir, string iconLocationPath, string description) {
      string parent = Path.GetDirectoryName(shortcutPath);
      if (!string.IsNullOrEmpty(parent) && !Directory.Exists(parent)) {
        Directory.CreateDirectory(parent);
      }
      IShellLinkW link = (IShellLinkW)new ShellLink();
      link.SetPath(targetExePath);
      link.SetWorkingDirectory(workingDir);
      link.SetDescription(description);
      link.SetIconLocation(iconLocationPath, 0);
      IPersistFile file = (IPersistFile)link;
      file.Save(shortcutPath, false);
    }

    static string EscapeJson(string s) {
      return (s ?? "").Replace("\\\\", "\\\\\\\\").Replace("\\"", "\\\\\\"");
    }

    static int InspectShortcut(string lnkPath) {
      if (!File.Exists(lnkPath)) {
        Console.Error.WriteLine("Shortcut not found: " + lnkPath);
        return 2;
      }
      IShellLinkW link = (IShellLinkW)new ShellLink();
      ((IPersistFile)link).Load(lnkPath, 0);
      StringBuilder targetSb = new StringBuilder(1024);
      link.GetPath(targetSb, targetSb.Capacity, IntPtr.Zero, 0);
      StringBuilder workDirSb = new StringBuilder(1024);
      link.GetWorkingDirectory(workDirSb, workDirSb.Capacity);
      StringBuilder iconSb = new StringBuilder(1024);
      int iconIdx = 0;
      link.GetIconLocation(iconSb, iconSb.Capacity, out iconIdx);

      Console.WriteLine("{");
      Console.WriteLine("  \\"shortcutPath\\": \\"" + EscapeJson(lnkPath) + "\\",");
      Console.WriteLine("  \\"targetPath\\": \\"" + EscapeJson(targetSb.ToString()) + "\\",");
      Console.WriteLine("  \\"workingDirectory\\": \\"" + EscapeJson(workDirSb.ToString()) + "\\",");
      Console.WriteLine("  \\"iconLocation\\": \\"" + EscapeJson(iconSb.ToString()) + "\\",");
      Console.WriteLine("  \\"iconIndex\\": " + iconIdx);
      Console.WriteLine("}");
      return 0;
    }

    static int Main(string[] args) {
      bool silent = false;
      bool uninstall = false;
      string inspectLnk = null;
      string targetDir = Path.Combine(
        Environment.GetFolderPath(Environment.SpecialFolder.LocalApplicationData),
        "Programs",
        "Elm-AnyDesk"
      );
      string desktopDir = Environment.GetFolderPath(Environment.SpecialFolder.DesktopDirectory);
      string startMenuDir = Environment.GetFolderPath(Environment.SpecialFolder.Programs);
      bool skipRegistry = false;

      foreach (string arg in args) {
        if (arg.Equals("--silent", StringComparison.OrdinalIgnoreCase) ||
            arg.Equals("/S", StringComparison.OrdinalIgnoreCase)) {
          silent = true;
        } else if (arg.Equals("--uninstall", StringComparison.OrdinalIgnoreCase) ||
                   arg.Equals("/U", StringComparison.OrdinalIgnoreCase)) {
          uninstall = true;
        } else if (arg.StartsWith("--inspect-shortcut=", StringComparison.OrdinalIgnoreCase)) {
          inspectLnk = arg.Substring("--inspect-shortcut=".Length).Trim('"');
        } else if (arg.StartsWith("--install-dir=", StringComparison.OrdinalIgnoreCase)) {
          targetDir = arg.Substring("--install-dir=".Length).Trim('"');
          skipRegistry = true;
        } else if (arg.StartsWith("--desktop-dir=", StringComparison.OrdinalIgnoreCase)) {
          desktopDir = arg.Substring("--desktop-dir=".Length).Trim('"');
        } else if (arg.StartsWith("--start-menu-dir=", StringComparison.OrdinalIgnoreCase)) {
          startMenuDir = arg.Substring("--start-menu-dir=".Length).Trim('"');
        }
      }

      if (!string.IsNullOrEmpty(inspectLnk)) {
        return InspectShortcut(inspectLnk);
      }

      string desktopShortcutPath = Path.Combine(desktopDir, "Elm-AnyDesk.lnk");
      string startMenuShortcutPath = Path.Combine(startMenuDir, "Elm-AnyDesk.lnk");

      if (uninstall) {
        try {
          StopRunningAppProcesses();
          if (File.Exists(desktopShortcutPath)) File.Delete(desktopShortcutPath);
          if (File.Exists(startMenuShortcutPath)) File.Delete(startMenuShortcutPath);
          if (!skipRegistry) {
            Registry.CurrentUser.DeleteSubKeyTree(@"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Elm-AnyDesk", false);
          }
          if (Directory.Exists(targetDir)) {
            Directory.Delete(targetDir, true);
          }
          return 0;
        } catch (Exception ex) {
          Console.Error.WriteLine("Uninstall failed: " + ex.Message);
          return 1;
        }
      }

      try {
        StopRunningAppProcesses();
        if (!silent) {
          Console.WriteLine("============================================================");
          Console.WriteLine(" Elm-AnyDesk Windows 11 Setup Installer (v${VERSION} x64)");
          Console.WriteLine(" App ID: ${APP_ID} | STUN-Only Pilot");
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

        string installedExePath = Path.Combine(targetDir, "Elm-AnyDesk.exe");
        string installedIcoPath = Path.Combine(targetDir, "elm-icon.ico");

        // Create Desktop and Start Menu shortcuts named "Elm-AnyDesk" (Elm-AnyDesk.lnk)
        // Use the installed executable's embedded multi-resolution icon (never a source repo path).
        // Never pin the app to the taskbar.
        CreateWindowsShortcut(
          desktopShortcutPath,
          installedExePath,
          targetDir,
          installedExePath,
          "Elm-AnyDesk — Consent-Based 1:1 Screen Sharing"
        );
        CreateWindowsShortcut(
          startMenuShortcutPath,
          installedExePath,
          targetDir,
          installedExePath,
          "Elm-AnyDesk — Consent-Based 1:1 Screen Sharing"
        );

        string receiptJson = "{\\n" +
          "  \\"appName\\": \\"Elm-AnyDesk\\",\\n" +
          "  \\"appId\\": \\"${APP_ID}\\",\\n" +
          "  \\"version\\": \\"${VERSION}\\",\\n" +
          "  \\"installedAt\\": \\"" + DateTime.UtcNow.ToString("o") + "\\",\\n" +
          "  \\"installDir\\": \\"" + EscapeJson(targetDir) + "\\",\\n" +
          "  \\"installedExePath\\": \\"" + EscapeJson(installedExePath) + "\\",\\n" +
          "  \\"installedIconPath\\": \\"" + EscapeJson(installedIcoPath) + "\\",\\n" +
          "  \\"desktopShortcutPath\\": \\"" + EscapeJson(desktopShortcutPath) + "\\",\\n" +
          "  \\"startMenuShortcutPath\\": \\"" + EscapeJson(startMenuShortcutPath) + "\\",\\n" +
          "  \\"pinnedToTaskbar\\": false,\\n" +
          "  \\"stunOnlyPilot\\": true,\\n" +
          "  \\"turnEnabled\\": false,\\n" +
          "  \\"autoUpgradeEnabled\\": false,\\n" +
          "  \\"packagedSeparatelyFromBackend\\": true\\n" +
          "}";
        File.WriteAllText(Path.Combine(targetDir, "install-receipt.json"), receiptJson);

        string uninstallCmd = "@echo off\\r\\n" +
          "echo Uninstalling Elm-AnyDesk...\\r\\n" +
          "taskkill /F /IM Elm-AnyDesk.exe >nul 2>&1\\r\\n" +
          "taskkill /F /IM wasapi-loopback.exe >nul 2>&1\\r\\n" +
          "if exist \\"" + desktopShortcutPath + "\\" del /f /q \\"" + desktopShortcutPath + "\\"\\r\\n" +
          "if exist \\"" + startMenuShortcutPath + "\\" del /f /q \\"" + startMenuShortcutPath + "\\"\\r\\n" +
          "reg delete \\"HKCU\\\\Software\\\\Microsoft\\\\Windows\\\\CurrentVersion\\\\Uninstall\\\\Elm-AnyDesk\\" /f >nul 2>&1\\r\\n" +
          "cd /d \\"%TEMP%\\"\\r\\n" +
          "rmdir /s /q \\"" + targetDir + "\\"\\r\\n";
        File.WriteAllText(Path.Combine(targetDir, "Uninstall-Elm-AnyDesk.cmd"), uninstallCmd);

        if (!skipRegistry) {
          using (RegistryKey key = Registry.CurrentUser.CreateSubKey(@"Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\Elm-AnyDesk")) {
            if (key != null) {
              key.SetValue("DisplayName", "Elm-AnyDesk");
              key.SetValue("DisplayVersion", "${VERSION}");
              key.SetValue("Publisher", "Elm-AnyDesk");
              key.SetValue("InstallLocation", targetDir);
              key.SetValue("DisplayIcon", installedExePath + ",0");
              key.SetValue("UninstallString", "\\"" + Path.Combine(targetDir, "Uninstall-Elm-AnyDesk.cmd") + "\\"");
              key.SetValue("NoModify", 1, RegistryValueKind.DWord);
              key.SetValue("NoRepair", 1, RegistryValueKind.DWord);
            }
          }
        }

        if (!silent) {
          Console.WriteLine("Installed Executable: " + installedExePath);
          Console.WriteLine("Desktop Shortcut:     " + desktopShortcutPath);
          Console.WriteLine("Start Menu Shortcut:  " + startMenuShortcutPath);
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
    `-win32icon:${iconInfo.icoPath}`,
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

console.log('6. Running Windows 11 install, shortcut, icon, out-of-repo launch, and uninstall verification...');
const tempRoot = path.join(
  os.tmpdir(),
  `elm-anydesk-clean-install-test-${Date.now()}`
);
const tempInstallDir = path.join(tempRoot, 'Programs', 'Elm-AnyDesk');
const tempDesktopDir = path.join(tempRoot, 'Desktop');
const tempStartMenuDir = path.join(tempRoot, 'StartMenu', 'Programs');

let cleanInstallVerified = false;
let verifiedFiles = [];
let desktopShortcutProps = null;
let startMenuShortcutProps = null;
let installedLaunchVerification = null;
let uninstallRemovedShortcutsAndDir = false;

try {
  execFileSync(
    installerExePath,
    [
      '--silent',
      `--install-dir=${tempInstallDir}`,
      `--desktop-dir=${tempDesktopDir}`,
      `--start-menu-dir=${tempStartMenuDir}`,
    ],
    { stdio: 'inherit' }
  );

  const requiredRelativePaths = [
    'Elm-AnyDesk.exe',
    'elm-icon.ico',
    'install-receipt.json',
    'Uninstall-Elm-AnyDesk.cmd',
    'resources/app/package.json',
    'resources/app/dist/main/index.cjs',
    'resources/app/dist/preload/index.cjs',
    'resources/app/dist/renderer/index.html',
    'resources/app/dist/assets/elm-icon.ico',
    'resources/app/dist/native/wasapi-loopback.exe',
    'resources/app/node_modules/@koromix/koffi-win32-x64/win32_x64/koffi.node',
  ];

  verifiedFiles = requiredRelativePaths.map((rel) => {
    const abs = path.join(tempInstallDir, rel);
    if (!fs.existsSync(abs)) {
      throw new Error(`Clean install verification missing required file: ${rel}`);
    }
    return rel;
  });

  // 1. Verify Desktop and Start Menu shortcuts ("Elm-AnyDesk.lnk") exist
  const desktopLnkPath = path.join(tempDesktopDir, 'Elm-AnyDesk.lnk');
  const startMenuLnkPath = path.join(tempStartMenuDir, 'Elm-AnyDesk.lnk');
  if (!fs.existsSync(desktopLnkPath)) {
    throw new Error(`Desktop shortcut was not created at ${desktopLnkPath}`);
  }
  if (!fs.existsSync(startMenuLnkPath)) {
    throw new Error(`Start Menu shortcut was not created at ${startMenuLnkPath}`);
  }

  // 2. Inspect shortcut targets and icon locations via IShellLinkW
  const desktopJsonRaw = execFileSync(
    installerExePath,
    [`--inspect-shortcut=${desktopLnkPath}`],
    { encoding: 'utf8' }
  );
  const startMenuJsonRaw = execFileSync(
    installerExePath,
    [`--inspect-shortcut=${startMenuLnkPath}`],
    { encoding: 'utf8' }
  );
  desktopShortcutProps = JSON.parse(desktopJsonRaw);
  startMenuShortcutProps = JSON.parse(startMenuJsonRaw);

  const expectedExePath = path.join(tempInstallDir, 'Elm-AnyDesk.exe');
  if (
    desktopShortcutProps.targetPath.toLowerCase() !== expectedExePath.toLowerCase()
  ) {
    throw new Error(
      `Desktop shortcut target mismatch: expected ${expectedExePath}, got ${desktopShortcutProps.targetPath}`
    );
  }
  if (
    desktopShortcutProps.iconLocation.toLowerCase() !==
    expectedExePath.toLowerCase()
  ) {
    throw new Error(
      `Desktop shortcut iconLocation must point to installed exe (${expectedExePath}), got ${desktopShortcutProps.iconLocation}`
    );
  }
  if (
    desktopShortcutProps.iconLocation
      .toLowerCase()
      .startsWith(repoRoot.toLowerCase())
  ) {
    throw new Error(
      `Desktop shortcut iconLocation must NEVER point inside source repo (${repoRoot})`
    );
  }

  // 3. Launch the installed executable via the shortcut's targetPath outside the source folder
  //    and verify WASAPI helper, DWM Koffi FFI, renderer, and icon asset resolution
  const launchVerifyPath = path.join(tempRoot, 'launch-verification.json');
  execFileSync(
    desktopShortcutProps.targetPath,
    [`--verify-installed-launch=${launchVerifyPath}`],
    {
      cwd: desktopShortcutProps.workingDirectory,
      stdio: 'inherit',
    }
  );
  installedLaunchVerification = JSON.parse(
    fs.readFileSync(launchVerifyPath, 'utf8')
  );
  if (
    !installedLaunchVerification.ok ||
    !installedLaunchVerification.rendererReady ||
    !installedLaunchVerification.dwmInitialized ||
    !installedLaunchVerification.wasapiHelperExists ||
    !installedLaunchVerification.iconExists
  ) {
    throw new Error(
      `Installed launch verification failed: ${JSON.stringify(installedLaunchVerification)}`
    );
  }

  // 4. Verify uninstall removes both shortcuts and the installation directory
  execFileSync(
    installerExePath,
    [
      '--uninstall',
      '--silent',
      `--install-dir=${tempInstallDir}`,
      `--desktop-dir=${tempDesktopDir}`,
      `--start-menu-dir=${tempStartMenuDir}`,
    ],
    { stdio: 'inherit' }
  );

  uninstallRemovedShortcutsAndDir =
    !fs.existsSync(desktopLnkPath) &&
    !fs.existsSync(startMenuLnkPath) &&
    !fs.existsSync(tempInstallDir);

  if (!uninstallRemovedShortcutsAndDir) {
    throw new Error('Uninstall failed to remove shortcuts or install directory');
  }

  cleanInstallVerified = true;
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

const manifest = {
  appName: APP_NAME,
  appId: APP_ID,
  version: VERSION,
  installerFilename: INSTALLER_NAME,
  installerPath: installerExePath,
  installerSizeBytes: installerStat.size,
  installerSha256: sha256,
  unpackedExePath: brandedExe,
  iconSourcePath: iconInfo.icoPath,
  iconResolutions: iconInfo.sizes,
  packagedSeparatelyFromBackend: true,
  autoUpgradeEnabled: false,
  stunOnlyPilot: true,
  turnEnabled: false,
  paidServicesEnabled: false,
  cleanInstallSmokeTestPassed: cleanInstallVerified,
  cleanInstallVerifiedFiles: verifiedFiles,
  shortcutVerification: {
    desktopShortcutName: 'Elm-AnyDesk.lnk',
    startMenuShortcutName: 'Elm-AnyDesk.lnk',
    pinnedToTaskbar: false,
    desktopShortcutProps,
    startMenuShortcutProps,
    uninstallRemovedShortcutsAndDir,
  },
  installedLaunchVerification,
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
console.log(`✓ Clean-install, shortcut, icon, launch & uninstall verification passed: ${cleanInstallVerified}`);
