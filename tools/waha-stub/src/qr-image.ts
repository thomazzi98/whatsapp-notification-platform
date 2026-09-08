import { createHash } from 'node:crypto';
import { crc32, deflateSync } from 'node:zlib';

/**
 * A QR-shaped image for a code nobody will ever scan.
 *
 * The stub has to return what the provider returns — a real PNG — because the
 * dashboard puts it straight into an `img`. Returning the pairing string
 * base64-encoded and labelled `image/png` type-checks, passes a test that only
 * asks whether an image element is present, and renders as a broken image in
 * front of anyone actually looking at the screen. That is exactly the class of
 * defect a stub is supposed to make visible rather than hide.
 *
 * The pattern is derived from the payload, so two connections look different
 * and a reissued code changes, but it encodes nothing. The scannable value is
 * available from the same endpoint with `?format=raw`, which is where anything
 * that needs the real string should read it.
 */

/** Version 2 dimensions. Cosmetic: the point is that it looks like a code. */
const MODULES = 25;
const QUIET_ZONE = 2;
const MODULE_PIXELS = 8;
const FINDER_SIZE = 7;

const CANVAS_MODULES = MODULES + QUIET_ZONE * 2;
const CANVAS_PIXELS = CANVAS_MODULES * MODULE_PIXELS;

/** The three corner squares that make a QR code recognisable at a glance. */
function isFinderModule(row: number, column: number): boolean {
  const isTopLeft = row < FINDER_SIZE && column < FINDER_SIZE;
  const isTopRight = row < FINDER_SIZE && column >= MODULES - FINDER_SIZE;
  const isBottomLeft = row >= MODULES - FINDER_SIZE && column < FINDER_SIZE;

  return isTopLeft || isTopRight || isBottomLeft;
}

function isFinderInk(row: number, column: number): boolean {
  const localRow = row < FINDER_SIZE ? row : row - (MODULES - FINDER_SIZE);
  const localColumn = column < FINDER_SIZE ? column : column - (MODULES - FINDER_SIZE);
  const ring = Math.max(Math.abs(localRow - 3), Math.abs(localColumn - 3));

  // A filled centre, a white ring around it, and a black border.
  return ring !== 2;
}

function buildModules(payload: string): boolean[][] {
  // One hash gives 32 bytes; the grid needs 625 bits, so the digest is extended
  // by hashing with a counter rather than by reusing the same bytes.
  const bits: boolean[] = [];
  for (let round = 0; bits.length < MODULES * MODULES; round += 1) {
    const digest = createHash('sha256')
      .update(`${payload}:${String(round)}`)
      .digest();
    for (const byte of digest) {
      for (let offset = 0; offset < 8; offset += 1) {
        bits.push((byte & (1 << offset)) !== 0);
      }
    }
  }

  return Array.from({ length: MODULES }, (_unusedRow, row) =>
    Array.from({ length: MODULES }, (_unusedColumn, column) => {
      if (isFinderModule(row, column)) {
        return isFinderInk(row, column);
      }
      return bits[row * MODULES + column] ?? false;
    }),
  );
}

/** Eight-bit greyscale, one filter byte per scanline, no interlacing. */
function buildScanlines(modules: boolean[][]): Buffer {
  const rows: Buffer[] = [];

  for (let pixelRow = 0; pixelRow < CANVAS_PIXELS; pixelRow += 1) {
    const scanline = Buffer.alloc(CANVAS_PIXELS + 1, 0xff);
    scanline[0] = 0;
    const moduleRow = Math.floor(pixelRow / MODULE_PIXELS) - QUIET_ZONE;

    for (let pixelColumn = 0; pixelColumn < CANVAS_PIXELS; pixelColumn += 1) {
      const moduleColumn = Math.floor(pixelColumn / MODULE_PIXELS) - QUIET_ZONE;
      const isInk = modules[moduleRow]?.[moduleColumn] === true;
      scanline[pixelColumn + 1] = isInk ? 0x00 : 0xff;
    }

    rows.push(scanline);
  }

  return Buffer.concat(rows);
}

function chunk(type: string, data: Buffer): Buffer {
  const length = Buffer.alloc(4);
  length.writeUInt32BE(data.length);

  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const checksum = Buffer.alloc(4);
  checksum.writeUInt32BE(crc32(body));

  return Buffer.concat([length, body, checksum]);
}

export function renderQrPlaceholderPng(payload: string): Buffer {
  const header = Buffer.alloc(13);
  header.writeUInt32BE(CANVAS_PIXELS, 0);
  header.writeUInt32BE(CANVAS_PIXELS, 4);
  header[8] = 8; // bit depth
  header[9] = 0; // greyscale
  header[10] = 0; // deflate
  header[11] = 0; // adaptive filtering
  header[12] = 0; // no interlacing

  const modules = buildModules(payload);
  const compressed = deflateSync(buildScanlines(modules));

  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', compressed),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}
