import type { BrowserWindow } from 'electron';
import koffi from 'koffi';
import type {
  TaskbarDwmTelemetry,
  TaskbarTransitionEvent,
} from '../shared/bridge';

// Win32 / DWM Constants
const GWL_EXSTYLE = -20;
const WS_EX_TOOLWINDOW = 0x00000080n;
const WS_EX_APPWINDOW = 0x00040000n;

const WM_DWMSENDICONICTHUMBNAIL = 0x0323;
const WM_DWMSENDICONICLIVEPREVIEWBITMAP = 0x0326;

const DWMWA_FORCE_ICONIC_REPRESENTATION = 7;
const DWMWA_HAS_ICONIC_BITMAP = 10;
const DWMWA_DISALLOW_PEEK = 11;
const DWMWA_EXCLUDED_FROM_PEEK = 12;

const DIB_RGB_COLORS = 0;
const BI_RGB = 0;

interface Win32Apis {
  DwmSetWindowAttribute: (
    hwnd: bigint,
    dwAttribute: number,
    pvAttribute: Buffer,
    cbAttribute: number
  ) => number;
  DwmSetIconicThumbnail: (
    hwnd: bigint,
    hbmp: bigint,
    dwSITFlags: number
  ) => number;
  DwmSetIconicLivePreviewBitmap: (
    hwnd: bigint,
    hbmp: bigint,
    pptClient: Buffer | null,
    dwSITFlags: number
  ) => number;
  DwmInvalidateIconicBitmaps: (hwnd: bigint) => number;
  CreateDIBSection: (
    hdc: bigint,
    pbmi: Buffer,
    usage: number,
    ppvBits: Buffer,
    hSection: bigint,
    offset: number
  ) => bigint;
  DeleteObject: (ho: bigint) => number;
  GetWindowLongPtrW: (hwnd: bigint, nIndex: number) => bigint;
  IsIconic: (hwnd: bigint) => number;
  IsWindowVisible: (hwnd: bigint) => number;
  SendMessageW: (
    hwnd: bigint,
    msg: number,
    wParam: bigint,
    lParam: bigint
  ) => bigint;
}

let cachedApis: Win32Apis | null = null;

function getWin32Apis(): Win32Apis {
  if (cachedApis) {
    return cachedApis;
  }

  const dwmapi = koffi.load('dwmapi.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const user32 = koffi.load('user32.dll');

  cachedApis = {
    DwmSetWindowAttribute: dwmapi.func(
      'int32 __stdcall DwmSetWindowAttribute(uintptr_t hwnd, uint32 dwAttribute, const void* pvAttribute, uint32 cbAttribute)'
    ),
    DwmSetIconicThumbnail: dwmapi.func(
      'int32 __stdcall DwmSetIconicThumbnail(uintptr_t hwnd, uintptr_t hbmp, uint32 dwSITFlags)'
    ),
    DwmSetIconicLivePreviewBitmap: dwmapi.func(
      'int32 __stdcall DwmSetIconicLivePreviewBitmap(uintptr_t hwnd, uintptr_t hbmp, const void* pptClient, uint32 dwSITFlags)'
    ),
    DwmInvalidateIconicBitmaps: dwmapi.func(
      'int32 __stdcall DwmInvalidateIconicBitmaps(uintptr_t hwnd)'
    ),
    CreateDIBSection: gdi32.func(
      'uintptr_t __stdcall CreateDIBSection(uintptr_t hdc, const void* pbmi, uint32 usage, void* ppvBits, uintptr_t hSection, uint32 offset)'
    ),
    DeleteObject: gdi32.func('int32 __stdcall DeleteObject(uintptr_t ho)'),
    GetWindowLongPtrW: user32.func(
      'intptr_t __stdcall GetWindowLongPtrW(uintptr_t hWnd, int32 nIndex)'
    ),
    IsIconic: user32.func('int32 __stdcall IsIconic(uintptr_t hWnd)'),
    IsWindowVisible: user32.func(
      'int32 __stdcall IsWindowVisible(uintptr_t hWnd)'
    ),
    SendMessageW: user32.func(
      'intptr_t __stdcall SendMessageW(uintptr_t hWnd, uint32 Msg, uintptr_t wParam, intptr_t lParam)'
    ),
  };

  return cachedApis;
}

function formatHResult(hr: number): string {
  const unsigned = hr >>> 0;
  return `0x${unsigned.toString(16).padStart(8, '0').toUpperCase()}`;
}

/**
 * Creates a 32-bit bottom-up BGRA DIB section containing a static Elm-AnyDesk
 * shield logo graphic (never real window content).
 */
function createStaticLogoBitmap(
  apis: Win32Apis,
  requestedWidth: number,
  requestedHeight: number
): { hBitmap: bigint; width: number; height: number } {
  const width = Math.max(32, Math.min(360, requestedWidth || 200));
  const height = Math.max(24, Math.min(240, requestedHeight || 120));

  // BITMAPINFOHEADER (40 bytes)
  const bmi = Buffer.alloc(40);
  bmi.writeUInt32LE(40, 0); // biSize
  bmi.writeInt32LE(width, 4); // biWidth
  bmi.writeInt32LE(height, 8); // biHeight > 0 (bottom-up DIB required by DwmSetIconicThumbnail)
  bmi.writeUInt16LE(1, 12); // biPlanes = 1
  bmi.writeUInt16LE(32, 14); // biBitCount = 32 (BGRA)
  bmi.writeUInt32LE(BI_RGB, 16); // biCompression = BI_RGB
  bmi.writeUInt32LE(width * height * 4, 20); // biSizeImage

  const ppvBits = Buffer.alloc(8);
  const hBitmap = apis.CreateDIBSection(0n, bmi, DIB_RGB_COLORS, ppvBits, 0n, 0);
  const bitsPtr = ppvBits.readBigUInt64LE(0);

  if (hBitmap !== 0n && bitsPtr !== 0n) {
    // Render static logo pixels in memory and copy into the DIB section
    const pixelBuf = Buffer.alloc(width * height * 4);
    const cx = Math.floor(width / 2);
    const cy = Math.floor(height / 2);
    const shieldRadius = Math.max(12, Math.floor(Math.min(width, height) * 0.28));

    for (let y = 0; y < height; y++) {
      // Bottom-up row index
      const dibRow = height - 1 - y;
      const isBorder =
        y < 3 || y >= height - 3 || false;

      for (let x = 0; x < width; x++) {
        const offset = (dibRow * width + x) * 4;
        const borderEdge =
          isBorder || x < 3 || x >= width - 3;

        const dx = x - cx;
        const dy = y - cy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        let r = 15;
        let g = 23;
        let b = 42; // Dark slate #0f172a

        if (borderEdge) {
          // Royal blue outer frame #2563eb
          r = 37;
          g = 99;
          b = 235;
        } else if (dist <= shieldRadius) {
          if (dist >= shieldRadius - 3) {
            // Cyan-blue shield ring #38bdf8
            r = 56;
            g = 189;
            b = 248;
          } else if (Math.abs(dx) <= 4 || Math.abs(dy) <= 4) {
            // Inner emblem cross #f8fafc
            r = 248;
            g = 250;
            b = 252;
          } else {
            // Shield fill #1d4ed8
            r = 29;
            g = 78;
            b = 216;
          }
        }

        pixelBuf[offset + 0] = b; // Blue
        pixelBuf[offset + 1] = g; // Green
        pixelBuf[offset + 2] = r; // Red
        pixelBuf[offset + 3] = 255; // Alpha (opaque)
      }
    }

    // Copy pixelBuf into the native DIB section memory via koffi
    const destArray = koffi.view(bitsPtr, pixelBuf.byteLength);
    new Uint8Array(destArray).set(pixelBuf);
  }

  return { hBitmap, width, height };
}

export class Win11TaskbarDwmController {
  private readonly win: BrowserWindow;
  private readonly hwnd: bigint;
  private skipTaskbarActive = true;

  private forceIconicHResult = -1;
  private hasIconicBitmapHResult = -1;
  private disallowPeekHResult = -1;
  private excludedFromPeekHResult = -1;
  private invalidateBitmapsHResult = -1;

  private thumbnailCallbackCount = 0;
  private lastThumbnailHResult = -1;
  private lastThumbnailSize = { width: 0, height: 0 };

  private livePreviewCallbackCount = 0;
  private lastLivePreviewHResult = -1;

  private readonly transitions: TaskbarTransitionEvent[] = [];

  constructor(win: BrowserWindow) {
    this.win = win;
    const handleBuf = win.getNativeWindowHandle();
    this.hwnd =
      handleBuf.byteLength >= 8
        ? handleBuf.readBigUInt64LE(0)
        : BigInt(handleBuf.readUInt32LE(0));
  }

  public initialize(): void {
    if (process.platform !== 'win32') {
      return;
    }

    const apis = getWin32Apis();

    // 1. Register Windows message hooks BEFORE setting DWM attributes
    this.win.hookWindowMessage(
      WM_DWMSENDICONICTHUMBNAIL,
      (_wParam: Buffer, lParam: Buffer) => {
        const lParamVal =
          lParam.byteLength >= 8
            ? Number(lParam.readBigUInt64LE(0) & 0xffffffffn)
            : lParam.readUInt32LE(0);
        const maxWidth = (lParamVal >>> 16) & 0xffff;
        const maxHeight = lParamVal & 0xffff;
        this.supplyStaticThumbnail(maxWidth, maxHeight, 'WM_DWMSENDICONICTHUMBNAIL');
      }
    );

    this.win.hookWindowMessage(
      WM_DWMSENDICONICLIVEPREVIEWBITMAP,
      () => {
        this.supplyStaticLivePreview('WM_DWMSENDICONICLIVEPREVIEWBITMAP');
      }
    );

    // 2. Apply DWM attributes:
    // - DWMWA_FORCE_ICONIC_REPRESENTATION (7) = TRUE: Never show live window content in thumbnail
    // - DWMWA_HAS_ICONIC_BITMAP (10) = TRUE: Use custom static bitmap provided via DwmSetIconicThumbnail
    // - DWMWA_DISALLOW_PEEK (11) = TRUE: Disable full-size Aero Peek on hover
    // - DWMWA_EXCLUDED_FROM_PEEK (12) = TRUE: Exclude window from Aero Peek fade
    const boolTrue = Buffer.alloc(4);
    boolTrue.writeInt32LE(1, 0);

    this.forceIconicHResult = apis.DwmSetWindowAttribute(
      this.hwnd,
      DWMWA_FORCE_ICONIC_REPRESENTATION,
      boolTrue,
      4
    );
    this.hasIconicBitmapHResult = apis.DwmSetWindowAttribute(
      this.hwnd,
      DWMWA_HAS_ICONIC_BITMAP,
      boolTrue,
      4
    );
    this.disallowPeekHResult = apis.DwmSetWindowAttribute(
      this.hwnd,
      DWMWA_DISALLOW_PEEK,
      boolTrue,
      4
    );
    this.excludedFromPeekHResult = apis.DwmSetWindowAttribute(
      this.hwnd,
      DWMWA_EXCLUDED_FROM_PEEK,
      boolTrue,
      4
    );
    this.invalidateBitmapsHResult = apis.DwmInvalidateIconicBitmaps(this.hwnd);

    // 3. Configure unpinned Windows 11 taskbar visibility:
    // Hide running taskbar icon while open/restored, show while minimized
    this.applySkipTaskbar(true, 'initial_open_hide_taskbar');

    this.win.on('minimize', () => {
      // Show taskbar icon while minimized so the user can see it and click-to-restore
      this.applySkipTaskbar(false, 'window_minimized_show_taskbar');
      this.invalidateBitmapsHResult = apis.DwmInvalidateIconicBitmaps(this.hwnd);
    });

    this.win.on('restore', () => {
      // Wait briefly for Windows restore transition to complete, then hide taskbar icon again
      setTimeout(() => {
        if (!this.win.isDestroyed() && !this.win.isMinimized()) {
          this.applySkipTaskbar(true, 'window_restored_hide_taskbar');
          this.invalidateBitmapsHResult = apis.DwmInvalidateIconicBitmaps(
            this.hwnd
          );
        }
      }, 60);
    });

    this.win.on('show', () => {
      if (!this.win.isMinimized()) {
        this.applySkipTaskbar(true, 'window_shown_hide_taskbar');
      }
    });
  }

  private applySkipTaskbar(skip: boolean, reason: string): void {
    if (this.win.isDestroyed()) return;
    this.win.setSkipTaskbar(skip);
    this.skipTaskbarActive = skip;
    this.recordTransition(reason);
  }

  private supplyStaticThumbnail(
    maxWidth: number,
    maxHeight: number,
    trigger: string
  ): void {
    const apis = getWin32Apis();
    const { hBitmap, width, height } = createStaticLogoBitmap(
      apis,
      maxWidth,
      maxHeight
    );

    if (hBitmap !== 0n) {
      this.lastThumbnailHResult = apis.DwmSetIconicThumbnail(
        this.hwnd,
        hBitmap,
        0
      );
      this.thumbnailCallbackCount += 1;
      this.lastThumbnailSize = { width, height };
      apis.DeleteObject(hBitmap);
    }

    this.recordTransition(
      `${trigger}(${width}x${height}) -> ${formatHResult(this.lastThumbnailHResult)}`
    );
  }

  private supplyStaticLivePreview(trigger: string): void {
    const apis = getWin32Apis();
    const bounds = this.win.getBounds();
    const { hBitmap } = createStaticLogoBitmap(
      apis,
      Math.min(360, bounds.width),
      Math.min(240, bounds.height)
    );

    if (hBitmap !== 0n) {
      this.lastLivePreviewHResult = apis.DwmSetIconicLivePreviewBitmap(
        this.hwnd,
        hBitmap,
        null,
        0
      );
      this.livePreviewCallbackCount += 1;
      apis.DeleteObject(hBitmap);
    }

    this.recordTransition(
      `${trigger} -> ${formatHResult(this.lastLivePreviewHResult)}`
    );
  }

  public triggerIconicThumbnailVerification(): TaskbarDwmTelemetry {
    if (process.platform === 'win32' && !this.win.isDestroyed()) {
      const apis = getWin32Apis();
      this.invalidateBitmapsHResult = apis.DwmInvalidateIconicBitmaps(this.hwnd);
      // Send WM_DWMSENDICONICTHUMBNAIL with lParam = MAKELPARAM(120, 200) (maxWidth=200, maxHeight=120)
      const lParam = (200n << 16n) | 120n;
      apis.SendMessageW(this.hwnd, WM_DWMSENDICONICTHUMBNAIL, 0n, lParam);
      apis.SendMessageW(this.hwnd, WM_DWMSENDICONICLIVEPREVIEWBITMAP, 0n, 0n);
    }
    return this.getTelemetry();
  }

  public recordTransition(action: string): void {
    if (this.win.isDestroyed()) return;
    const apis = getWin32Apis();
    const exStyle = BigInt(apis.GetWindowLongPtrW(this.hwnd, GWL_EXSTYLE));
    const event: TaskbarTransitionEvent = {
      timestamp: new Date().toISOString(),
      action,
      isMinimized: this.win.isMinimized(),
      win32IsIconic: apis.IsIconic(this.hwnd) !== 0,
      skipTaskbarApplied: this.skipTaskbarActive,
      wsExAppWindow: (exStyle & WS_EX_APPWINDOW) !== 0n,
      wsExToolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0n,
    };
    this.transitions.push(event);
    if (this.transitions.length > 30) {
      this.transitions.shift();
    }
  }

  public getTelemetry(): TaskbarDwmTelemetry {
    const apis = getWin32Apis();
    const exStyle = BigInt(apis.GetWindowLongPtrW(this.hwnd, GWL_EXSTYLE));

    return {
      hwndHex: `0x${this.hwnd.toString(16).toUpperCase()}`,
      isMinimized: this.win.isMinimized(),
      win32IsIconic: apis.IsIconic(this.hwnd) !== 0,
      win32IsVisible: apis.IsWindowVisible(this.hwnd) !== 0,
      skipTaskbarApplied: this.skipTaskbarActive,
      wsExAppWindow: (exStyle & WS_EX_APPWINDOW) !== 0n,
      wsExToolWindow: (exStyle & WS_EX_TOOLWINDOW) !== 0n,
      dwmAttributes: {
        forceIconicRepresentation: formatHResult(this.forceIconicHResult),
        hasIconicBitmap: formatHResult(this.hasIconicBitmapHResult),
        disallowPeek: formatHResult(this.disallowPeekHResult),
        excludedFromPeek: formatHResult(this.excludedFromPeekHResult),
        invalidateIconicBitmaps: formatHResult(this.invalidateBitmapsHResult),
      },
      iconicThumbnail: {
        callbackCount: this.thumbnailCallbackCount,
        lastHResult: formatHResult(this.lastThumbnailHResult),
        lastWidth: this.lastThumbnailSize.width,
        lastHeight: this.lastThumbnailSize.height,
      },
      livePreview: {
        callbackCount: this.livePreviewCallbackCount,
        lastHResult: formatHResult(this.lastLivePreviewHResult),
      },
      transitions: [...this.transitions],
    };
  }
}
