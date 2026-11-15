import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const desktopDir = path.resolve(__dirname, '..');
const assetsDir = path.resolve(desktopDir, 'assets');

/**
 * Renders the original square Elm mark at (width x height) into an RGBA buffer:
 * - Near-black background (#111111)
 * - Action blue outer square border (#2563EB)
 * - Accent blue inner frame (#60A5FA)
 * - Crisp white geometric 'E' / Elm emblem (#FFFFFF) in the center
 */
function renderElmSquareIconRgba(size) {
  const buf = Buffer.alloc(size * size * 4);
  const outerBorder = Math.max(1, Math.round(size * 0.08));
  const innerPad = Math.max(2, Math.round(size * 0.18));
  const innerBorder = Math.max(1, Math.round(size * 0.04));

  // Geometric 'E' bounds inside the square
  const eLeft = Math.round(size * 0.30);
  const eRight = Math.round(size * 0.72);
  const eTop = Math.round(size * 0.27);
  const eBottom = Math.round(size * 0.73);
  const stroke = Math.max(2, Math.round(size * 0.10));
  const midYStart = Math.round(size * 0.50 - stroke / 2);
  const midYEnd = midYStart + stroke;
  const midRight = Math.round(size * 0.65);

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const idx = (y * size + x) * 4;

      // Default: near-black surface (#111111)
      let r = 0x11;
      let g = 0x11;
      let b = 0x11;
      const a = 0xff;

      const isOuterBorder =
        x < outerBorder ||
        x >= size - outerBorder ||
        y < outerBorder ||
        y >= size - outerBorder;

      const inInnerBox =
        x >= innerPad &&
        x < size - innerPad &&
        y >= innerPad &&
        y < size - innerPad;

      const isInnerBorder =
        inInnerBox &&
        (x < innerPad + innerBorder ||
          x >= size - innerPad - innerBorder ||
          y < innerPad + innerBorder ||
          y >= size - innerPad - innerBorder);

      // White 'E' emblem geometry
      const inVerticalStem =
        x >= eLeft && x < eLeft + stroke && y >= eTop && y < eBottom;
      const inTopBar =
        x >= eLeft && x < eRight && y >= eTop && y < eTop + stroke;
      const inMidBar =
        x >= eLeft && x < midRight && y >= midYStart && y < midYEnd;
      const inBottomBar =
        x >= eLeft && x < eRight && y >= eBottom - stroke && y < eBottom;

      // Blue node accent dot at bottom-right of the E frame
      const dotSize = Math.max(2, Math.round(size * 0.08));
      const inAccentNode =
        x >= eRight - dotSize &&
        x < eRight &&
        y >= midYStart &&
        y < midYStart + dotSize;

      if (isOuterBorder) {
        // Primary action blue (#2563EB)
        r = 0x25;
        g = 0x63;
        b = 0xeb;
      } else if (isInnerBorder) {
        // Subtle blue frame (#1D4ED8)
        r = 0x1d;
        g = 0x4e;
        b = 0xd8;
      } else if (inVerticalStem || inTopBar || inMidBar || inBottomBar) {
        // Pure white 'E' (#FFFFFF)
        r = 0xff;
        g = 0xff;
        b = 0xff;
      } else if (inAccentNode) {
        // Light blue accent (#60A5FA)
        r = 0x60;
        g = 0xa5;
        b = 0xfa;
      }

      buf[idx + 0] = r;
      buf[idx + 1] = g;
      buf[idx + 2] = b;
      buf[idx + 3] = a;
    }
  }

  return buf;
}

/**
 * Encodes an RGBA pixel buffer (size x size) as a 32-bit bottom-up Windows ICO DIB entry.
 */
function createIcoDibEntry(size, rgbaBuf) {
  const xorSize = size * size * 4;
  const andRowStride = Math.ceil(size / 32) * 4;
  const andSize = andRowStride * size;
  const headerSize = 40;
  const out = Buffer.alloc(headerSize + xorSize + andSize);

  // BITMAPINFOHEADER
  out.writeUInt32LE(40, 0); // biSize
  out.writeInt32LE(size, 4); // biWidth
  out.writeInt32LE(size * 2, 8); // biHeight (doubled for XOR + AND mask)
  out.writeUInt16LE(1, 12); // biPlanes
  out.writeUInt16LE(32, 14); // biBitCount
  out.writeUInt32LE(0, 16); // biCompression = BI_RGB
  out.writeUInt32LE(xorSize + andSize, 20); // biSizeImage

  // Write bottom-up BGRA pixels
  for (let y = 0; y < size; y++) {
    const srcRow = size - 1 - y;
    for (let x = 0; x < size; x++) {
      const srcIdx = (srcRow * size + x) * 4;
      const dstIdx = headerSize + (y * size + x) * 4;
      out[dstIdx + 0] = rgbaBuf[srcIdx + 2]; // B
      out[dstIdx + 1] = rgbaBuf[srcIdx + 1]; // G
      out[dstIdx + 2] = rgbaBuf[srcIdx + 0]; // R
      out[dstIdx + 3] = rgbaBuf[srcIdx + 3]; // A
    }
  }
  // AND mask remains 0 (opaque)
  return out;
}

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) {
    c ^= buf[i];
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
  }
  return (c ^ 0xffffffff) >>> 0;
}

function makePngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcInput = Buffer.concat([typeBuf, data]);
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(crcInput), 0);
  return Buffer.concat([len, typeBuf, data, crcBuf]);
}

function encodeRgbaToPng(size, rgbaBuf) {
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // color type RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const rawScanlines = Buffer.alloc(size * (size * 4 + 1));
  for (let y = 0; y < size; y++) {
    const rowStart = y * (size * 4 + 1);
    rawScanlines[rowStart] = 0; // filter type None
    rgbaBuf.copy(rawScanlines, rowStart + 1, y * size * 4, (y + 1) * size * 4);
  }
  const compressed = zlib.deflateSync(rawScanlines, { level: 9 });

  return Buffer.concat([
    signature,
    makePngChunk('IHDR', ihdr),
    makePngChunk('IDAT', compressed),
    makePngChunk('IEND', Buffer.alloc(0)),
  ]);
}

export function generateMultiResolutionElmIcon() {
  fs.mkdirSync(assetsDir, { recursive: true });

  const sizes = [16, 24, 32, 48, 64, 256];
  const entries = sizes.map((size) => {
    const rgba = renderElmSquareIconRgba(size);
    // Use standard DIB for 16..64 and PNG for 256x256
    const data =
      size === 256 ? encodeRgbaToPng(size, rgba) : createIcoDibEntry(size, rgba);
    return { size, data, rgba };
  });

  const count = entries.length;
  const headerSize = 6;
  const dirSize = count * 16;
  let offset = headerSize + dirSize;

  const header = Buffer.alloc(headerSize);
  header.writeUInt16LE(0, 0); // Reserved
  header.writeUInt16LE(1, 2); // Type = 1 (ICO)
  header.writeUInt16LE(count, 4); // Image count

  const dirBuf = Buffer.alloc(dirSize);
  const payloads = [];

  entries.forEach((entry, idx) => {
    const base = idx * 16;
    dirBuf[base + 0] = entry.size === 256 ? 0 : entry.size; // Width
    dirBuf[base + 1] = entry.size === 256 ? 0 : entry.size; // Height
    dirBuf[base + 2] = 0; // Palette count
    dirBuf[base + 3] = 0; // Reserved
    dirBuf.writeUInt16LE(1, base + 4); // Color planes
    dirBuf.writeUInt16LE(32, base + 6); // Bits per pixel
    dirBuf.writeUInt32LE(entry.data.length, base + 8); // Size of image data
    dirBuf.writeUInt32LE(offset, base + 12); // Offset of image data
    offset += entry.data.length;
    payloads.push(entry.data);
  });

  const icoBuffer = Buffer.concat([header, dirBuf, ...payloads]);
  const icoPath = path.join(assetsDir, 'elm-icon.ico');
  fs.writeFileSync(icoPath, icoBuffer);

  // Also write 256x256 PNG and SVG vector source for documentation/reference
  const png256Path = path.join(assetsDir, 'elm-icon-256.png');
  fs.writeFileSync(
    png256Path,
    encodeRgbaToPng(256, entries[entries.length - 1].rgba)
  );

  const svgContent = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256">
  <!-- Near-black square canvas (#111111) with Action Blue outer border (#2563EB) -->
  <rect x="0" y="0" width="256" height="256" fill="#2563EB" />
  <rect x="20" y="20" width="216" height="216" fill="#111111" />
  <!-- Inner frame (#1D4ED8) -->
  <rect x="46" y="46" width="164" height="164" fill="none" stroke="#1D4ED8" stroke-width="10" />
  <!-- Crisp White Elm 'E' mark (#FFFFFF) -->
  <path d="M77 69 H184 V95 H103 V115 H166 V141 H103 V161 H184 V187 H77 Z" fill="#FFFFFF" />
  <!-- Accent Blue connection node (#60A5FA) -->
  <rect x="164" y="115" width="20" height="20" fill="#60A5FA" />
</svg>
`;
  const svgPath = path.join(assetsDir, 'elm-icon.svg');
  fs.writeFileSync(svgPath, svgContent, 'utf8');

  return {
    icoPath,
    png256Path,
    svgPath,
    sizes,
    byteLength: icoBuffer.length,
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const info = generateMultiResolutionElmIcon();
  console.log(
    `✓ Generated multi-resolution Elm icon (${info.sizes.join('x, ')}x): ${info.icoPath} (${info.byteLength} bytes)`
  );
}
