// DOMAIN — JavaScript thuần: không import React, Firebase hay lớp khác, không dùng Canvas/Blob/File.
//
// Phân tích BYTE của file ảnh (JPEG / PNG / WebP) để quyết định theo NỘI DUNG, không tin tên file hay MIME.
// Việc đọc byte từ File/Blob nằm ở Infrastructure (browserImageProcessor, E3b); ở đây chỉ nhận
// Uint8Array / ArrayBuffer của TOÀN BỘ file (Domain đã giới hạn <= MAX_SIZE_BYTES nên đọc cả file là chấp nhận được).
//
// Mọi hàm: không ném lỗi với dữ liệu bất kỳ (kể cả byte ngẫu nhiên hay bị cắt cụt); trả kết quả mô tả.
//
// GIỚI HẠN (nói thẳng):
//   - Chỉ đọc cấu trúc/header và phần kết thúc. KHÔNG giải mã điểm ảnh, nên KHÔNG phát hiện được mọi file hỏng
//     (ví dụ dữ liệu điểm ảnh bị lật bit mà cấu trúc vẫn đúng). Bước giải mã thật thuộc Infrastructure.
//   - Kiểm tra "kết thúc file" chỉ là best-effort: bắt file bị cắt cụt, và KHÔNG từ chối ảnh hợp lệ chỉ vì có
//     metadata/dữ liệu thừa phía sau phần kết thúc của ảnh.
//   - EXIF orientation đọc cho JPEG (APP1) và PNG (chunk eXIf, theo đúng quy tắc Chrome đã kiểm chứng ở E3c/E3d).
//     WebP luôn trả orientation = 1: Chrome bỏ qua EXIF của WebP, còn trình duyệt khác chưa kiểm chứng.

import { ERROR_REASON } from '../constants/imageStatus';
import { MAX_PIXELS } from '../constants/imageRules';

export const IMAGE_TYPE = Object.freeze({
  JPEG: 'image/jpeg',
  PNG: 'image/png',
  WEBP: 'image/webp',
});

/**
 * Mã chi tiết (chỉ để chẩn đoán/kiểm thử). KHÔNG phải ERROR_REASON và KHÔNG thuộc schema chung:
 * mọi lỗi vẫn quy về ERROR_REASON.INVALID_IMAGE hoặc ERROR_REASON.TOO_LARGE.
 */
export const IMAGE_CHECK_CODE = Object.freeze({
  NO_DATA: 'NO_DATA',
  UNSUPPORTED_SIGNATURE: 'UNSUPPORTED_SIGNATURE',
  MALFORMED_HEADER: 'MALFORMED_HEADER',
  ANIMATED: 'ANIMATED',
  TOO_MANY_PIXELS: 'TOO_MANY_PIXELS',
  SIDE_TOO_LONG: 'SIDE_TOO_LONG',
  TRUNCATED: 'TRUNCATED',
});

// ---------- tiện ích đọc byte (luôn kiểm tra biên, ngoài biên trả undefined) ----------

function toBytes(input) {
  if (input instanceof Uint8Array) return input;
  if (input instanceof ArrayBuffer) return new Uint8Array(input);
  if (ArrayBuffer.isView(input)) return new Uint8Array(input.buffer, input.byteOffset, input.byteLength);
  return null;
}

const u8 = (b, i) => (i >= 0 && i < b.length ? b[i] : undefined);

function u16(b, i, little) {
  if (i < 0 || i + 2 > b.length) return undefined;
  return little ? b[i] | (b[i + 1] << 8) : (b[i] << 8) | b[i + 1];
}

function u32(b, i, little) {
  if (i < 0 || i + 4 > b.length) return undefined;
  const v = little
    ? b[i] | (b[i + 1] << 8) | (b[i + 2] << 16) | (b[i + 3] << 24)
    : (b[i] << 24) | (b[i + 1] << 16) | (b[i + 2] << 8) | b[i + 3];
  return v >>> 0;
}

function ascii(b, i, length) {
  if (i < 0 || i + length > b.length) return '';
  let s = '';
  for (let k = 0; k < length; k += 1) s += String.fromCharCode(b[i + k]);
  return s;
}

const startsWith = (b, signature) => signature.every((value, k) => b[k] === value);

// CRC-32 của PNG (chỉ dùng để kiểm tra chunk eXIf nhỏ; bảng được tạo lười).
let crcTable = null;
function crc32(b, from, to) {
  if (!crcTable) {
    crcTable = new Uint32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
      crcTable[n] = c >>> 0;
    }
  }
  let crc = 0xffffffff;
  for (let i = from; i < to; i += 1) crc = crcTable[(crc ^ b[i]) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];

// ---------- 1. nhận dạng theo chữ ký (magic bytes) ----------

/**
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {'image/jpeg'|'image/png'|'image/webp'|null}  null = không phải 3 định dạng được hỗ trợ
 */
export function detectImageType(input) {
  const b = toBytes(input);
  if (!b || b.length < 12) return null;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return IMAGE_TYPE.JPEG;
  if (startsWith(b, PNG_SIGNATURE)) return IMAGE_TYPE.PNG;
  if (ascii(b, 0, 4) === 'RIFF' && ascii(b, 8, 4) === 'WEBP') return IMAGE_TYPE.WEBP;
  return null;
}

// ---------- 2. đọc header: kích thước, EXIF orientation, ảnh động ----------

const ok = (type, width, height, orientation, animated) => ({
  ok: true,
  type,
  width,
  height,
  orientation,
  animated,
});
const bad = (code) => ({ ok: false, code });

// JPEG: các marker SOFn mang kích thước (trừ C4 = DHT, C8 = JPG, CC = DAC).
const isSofMarker = (m) => m >= 0xc0 && m <= 0xcf && m !== 0xc4 && m !== 0xc8 && m !== 0xcc;
const isStandaloneMarker = (m) => m === 0x01 || (m >= 0xd0 && m <= 0xd8);

/**
 * Đọc orientation (1..8) từ khối TIFF bắt đầu tại `tiff` (header "II"/"MM"), chỉ đọc trong [tiff, end).
 * Dùng chung cho JPEG (sau tiền tố "Exif\0\0" của APP1) và PNG (nội dung chunk eXIf là TIFF thô).
 * Không có/không hợp lệ/ngoài biên/không phải SHORT -> undefined.
 */
function readTiffOrientation(b, tiff, end) {
  const order = ascii(b, tiff, 2);
  if (order !== 'II' && order !== 'MM') return undefined;
  const little = order === 'II';
  if (u16(b, tiff + 2, little) !== 42) return undefined;
  const ifd = u32(b, tiff + 4, little);
  if (ifd === undefined) return undefined;
  const base = tiff + ifd;
  const count = u16(b, base, little);
  if (count === undefined) return undefined;
  for (let k = 0; k < count; k += 1) {
    const entry = base + 2 + k * 12;
    if (entry + 12 > end) return undefined;
    if (u16(b, entry, little) === 0x0112) {
      if (u16(b, entry + 2, little) !== 3) return undefined; // phải là SHORT
      const value = u16(b, entry + 8, little);
      return value >= 1 && value <= 8 ? value : undefined;
    }
  }
  return undefined;
}

/** Đọc orientation (1..8) từ nội dung segment APP1 của JPEG; không có/không hợp lệ -> undefined. */
function readExifOrientation(b, start, end) {
  if (ascii(b, start, 6) !== 'Exif\0\0') return undefined;
  return readTiffOrientation(b, start + 6, end);
}

/**
 * Duyệt các segment của JPEG tới SOS. Trả { width, height, orientation, sosAt } hoặc null nếu cấu trúc sai.
 * `sosAt` = vị trí byte 0xFF của marker SOS (đầu dữ liệu quét).
 */
function walkJpeg(b) {
  let i = 2; // sau SOI
  let width;
  let height;
  let orientation;
  for (let guard = 0; guard < 100000; guard += 1) {
    // tìm marker kế tiếp (cho phép byte đệm 0xFF)
    if (u8(b, i) !== 0xff) return null;
    while (u8(b, i + 1) === 0xff) i += 1;
    const marker = u8(b, i + 1);
    if (marker === undefined || marker === 0x00) return null;
    if (isStandaloneMarker(marker)) {
      i += 2;
      continue;
    }
    if (marker === 0xd9) return null; // EOI trước khi có dữ liệu ảnh
    const length = u16(b, i + 2, false);
    if (length === undefined || length < 2 || i + 2 + length > b.length) return null;
    const dataStart = i + 4;
    const segmentEnd = i + 2 + length;

    if (isSofMarker(marker)) {
      if (length < 8) return null;
      const h = u16(b, i + 5, false);
      const w = u16(b, i + 7, false);
      if (width === undefined) {
        width = w;
        height = h;
      }
    } else if (marker === 0xe1 && orientation === undefined) {
      orientation = readExifOrientation(b, dataStart, segmentEnd);
    } else if (marker === 0xda) {
      if (width === undefined) return null; // SOS mà chưa có SOF
      return { width, height, orientation: orientation ?? 1, sosAt: i };
    }
    i = segmentEnd;
  }
  return null;
}

function readJpegHeader(b) {
  const walked = walkJpeg(b);
  if (!walked) return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
  if (!(walked.width > 0) || !(walked.height > 0)) return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
  return ok(IMAGE_TYPE.JPEG, walked.width, walked.height, walked.orientation, false);
}

// Chunk eXIf lớn bất thường coi như không dùng được (EXIF thật chỉ vài chục byte đến vài KB).
const MAX_PNG_EXIF_BYTES = 1024 * 1024;

/**
 * Orientation từ chunk eXIf tại `pos` (đầu chunk: độ dài, tên, dữ liệu, CRC). Khớp hành vi Chrome đã kiểm chứng (E3d):
 *   - nội dung phải là TIFF THÔ ("II"/"MM"); tiền tố "Exif\0\0" kiểu JPEG KHÔNG được Chrome áp dụng;
 *   - CRC sai thì Chrome bỏ chunk -> ở đây cũng bỏ (undefined);
 *   - chunk eXIf nằm sau IDAT không được Chrome áp dụng (hàm duyệt dừng ở IDAT nên không tới đây).
 */
function readPngExifOrientation(b, pos, length) {
  if (length > MAX_PNG_EXIF_BYTES) return undefined;
  const dataStart = pos + 8;
  const dataEnd = dataStart + length;
  const stored = u32(b, dataEnd, false);
  if (stored === undefined) return undefined; // chunk bị cắt cụt
  if (crc32(b, pos + 4, dataEnd) !== stored) return undefined;
  return readTiffOrientation(b, dataStart, dataEnd);
}

function readPngHeader(b) {
  // IHDR phải là chunk đầu tiên: độ dài 13, rồi tên "IHDR".
  if (u32(b, 8, false) !== 13 || ascii(b, 12, 4) !== 'IHDR') return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
  const width = u32(b, 16, false);
  const height = u32(b, 20, false);
  if (!(width > 0) || !(height > 0)) return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);

  // Duyệt các chunk TRƯỚC IDAT đầu tiên: acTL (APNG) và eXIf (orientation).
  let animated = false;
  let orientation = 1;
  let seenExif = false;
  let pos = 8;
  for (let guard = 0; guard < 100000; guard += 1) {
    const length = u32(b, pos, false);
    const name = ascii(b, pos + 4, 4);
    if (length === undefined || name === '') break;
    if (name === 'acTL') {
      animated = true;
      break;
    }
    if (name === 'eXIf' && !seenExif) {
      seenExif = true; // chunk eXIf ĐẦU TIÊN quyết định (Chrome bỏ qua chunk trùng)
      orientation = readPngExifOrientation(b, pos, length) ?? 1;
    }
    if (name === 'IDAT' || name === 'IEND') break;
    pos += 12 + length;
  }
  return ok(IMAGE_TYPE.PNG, width, height, orientation, animated);
}

function readWebpHeader(b) {
  let width;
  let height;
  let animated = false;
  let pos = 12;
  for (let guard = 0; guard < 100000; guard += 1) {
    const name = ascii(b, pos, 4);
    const size = u32(b, pos + 4, true);
    if (name === '' || size === undefined) break;
    const data = pos + 8;
    if (name === 'VP8X') {
      const flags = u8(b, data);
      const w = u32(b, data + 4, true);
      const h = u32(b, data + 7, true);
      if (flags === undefined || w === undefined || h === undefined) return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
      if (flags & 0x02) animated = true; // bit Animation
      width = (w & 0xffffff) + 1;
      height = (h & 0xffffff) + 1;
    } else if (name === 'ANIM' || name === 'ANMF') {
      animated = true;
    } else if (name === 'VP8 ') {
      if (u8(b, data + 3) !== 0x9d || u8(b, data + 4) !== 0x01 || u8(b, data + 5) !== 0x2a) {
        return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
      }
      if (width === undefined) {
        const w = u16(b, data + 6, true);
        const h = u16(b, data + 8, true);
        if (w === undefined || h === undefined) return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
        width = w & 0x3fff;
        height = h & 0x3fff;
      }
      break;
    } else if (name === 'VP8L') {
      if (u8(b, data) !== 0x2f) return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
      const bits = u32(b, data + 1, true);
      if (bits === undefined) return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
      if (width === undefined) {
        width = (bits & 0x3fff) + 1;
        height = ((bits >>> 14) & 0x3fff) + 1;
      }
      break;
    }
    if (name === 'ANMF') break;
    pos = data + size + (size % 2); // chunk được đệm cho chẵn
  }
  if (!(width > 0) || !(height > 0)) return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER);
  return ok(IMAGE_TYPE.WEBP, width, height, 1, animated);
}

/**
 * Đọc header của ảnh (đã biết là JPEG/PNG/WebP theo chữ ký).
 * @param {Uint8Array|ArrayBuffer} input
 * @returns {{ ok: true, type: string, width: number, height: number, orientation: number, animated: boolean }
 *   | { ok: false, code: string }}
 *   width/height là kích thước GHI TRONG FILE (chưa xoay theo EXIF). Dùng `displaySize` để có kích thước sau khi xoay.
 */
export function readImageHeader(input) {
  const b = toBytes(input);
  if (!b || b.length === 0) return bad(IMAGE_CHECK_CODE.NO_DATA);
  const type = detectImageType(b);
  if (!type) return bad(IMAGE_CHECK_CODE.UNSUPPORTED_SIGNATURE);
  try {
    if (type === IMAGE_TYPE.JPEG) return readJpegHeader(b);
    if (type === IMAGE_TYPE.PNG) return readPngHeader(b);
    return readWebpHeader(b);
  } catch {
    return bad(IMAGE_CHECK_CODE.MALFORMED_HEADER); // phòng thủ: không bao giờ ném lỗi ra ngoài
  }
}

/** Kích thước hiển thị sau khi xoay theo EXIF: orientation 5–8 hoán đổi chiều rộng và chiều cao. */
export function displaySize({ width, height, orientation }) {
  return orientation >= 5 && orientation <= 8 ? { width: height, height: width } : { width, height };
}

// ---------- 3. phần kết thúc file (best-effort, phát hiện file bị cắt cụt) ----------

function isJpegComplete(b) {
  const walked = walkJpeg(b);
  if (!walked) return false;
  // Từ SOS đi tiếp: bỏ qua phần header của từng marker, quét dữ liệu nén cho tới EOI (FFD9).
  // Dữ liệu SAU EOI (metadata, ảnh MPF, ...) được bỏ qua, không bị coi là lỗi.
  let i = walked.sosAt;
  for (let guard = 0; guard < 10_000_000; guard += 1) {
    const at = b.indexOf(0xff, i);
    if (at === -1) return false;
    const marker = u8(b, at + 1);
    if (marker === undefined) return false;
    if (marker === 0x00 || (marker >= 0xd0 && marker <= 0xd7)) {
      i = at + 2; // byte 0xFF được đệm / marker khởi động lại: vẫn là dữ liệu nén
    } else if (marker === 0xff) {
      i = at + 1; // byte đệm
    } else if (marker === 0xd9) {
      return true;
    } else if (marker === 0x01 || marker === 0xd8) {
      i = at + 2;
    } else {
      const length = u16(b, at + 2, false);
      if (length === undefined || length < 2 || at + 2 + length > b.length) return false;
      i = at + 2 + length; // SOS/DHT/DQT/DNL/COM... kế tiếp
    }
  }
  return false;
}

function isPngComplete(b) {
  let pos = 8;
  for (let guard = 0; guard < 10_000_000; guard += 1) {
    const length = u32(b, pos, false);
    if (length === undefined) return false;
    const name = ascii(b, pos + 4, 4);
    const end = pos + 12 + length; // độ dài + tên + dữ liệu + CRC
    if (end > b.length) return false;
    if (name === 'IEND') return true; // dữ liệu thừa sau IEND được bỏ qua
    pos = end;
  }
  return false;
}

function isWebpComplete(b) {
  const riffSize = u32(b, 4, true);
  if (riffSize === undefined || riffSize < 4) return false;
  const riffEnd = riffSize + 8;
  if (riffEnd > b.length) return false; // file ngắn hơn độ dài khai báo => bị cắt
  let pos = 12;
  while (pos + 8 <= riffEnd) {
    const size = u32(b, pos + 4, true);
    if (pos + 8 + size > riffEnd) return false; // một chunk vượt ra ngoài vùng RIFF
    pos += 8 + size + (size % 2);
  }
  return true;
}

/**
 * Kiểm tra BEST-EFFORT file có kết thúc đúng cấu trúc (phát hiện file bị cắt cụt).
 * true = cấu trúc đầy đủ; false = nhiều khả năng bị cắt/hỏng. KHÔNG khẳng định điểm ảnh còn nguyên vẹn.
 * @param {Uint8Array|ArrayBuffer} input
 * @param {string} [type]  nếu bỏ qua sẽ tự nhận dạng
 */
export function isImageEndingComplete(input, type) {
  const b = toBytes(input);
  if (!b) return false;
  const kind = type ?? detectImageType(b);
  try {
    if (kind === IMAGE_TYPE.JPEG) return isJpegComplete(b);
    if (kind === IMAGE_TYPE.PNG) return isPngComplete(b);
    if (kind === IMAGE_TYPE.WEBP) return isWebpComplete(b);
  } catch {
    return false;
  }
  return false;
}

// ---------- 4. chính sách tổng hợp ----------

const MEGAPIXEL = 1_000_000;

const invalid = (errorReason, code, message) => ({ valid: false, errorReason, code, message });

/**
 * Kiểm tra nội dung ảnh theo thứ tự rẻ -> đắt, dừng ở lỗi đầu tiên:
 *   chữ ký -> header -> ảnh động -> giới hạn cạnh/pixel (TRƯỚC khi tạo Canvas) -> phần kết thúc.
 *
 * @param {Uint8Array|ArrayBuffer} input  toàn bộ byte của file (<= MAX_SIZE_BYTES, đã kiểm tra ở validateImageFile)
 * @param {Object} [options]
 * @param {number} [options.maxPixels=MAX_PIXELS]   giới hạn chính sách của ứng dụng
 * @param {number} [options.maxDimension]           giới hạn một cạnh do encoder (WebP: 16383, đặt ở Infrastructure)
 * @returns {{ valid: true, info: { type, width, height, orientation, displayWidth, displayHeight } }
 *   | { valid: false, errorReason: string, code: string, message: string }}
 *   errorReason thuộc ERROR_REASON (INVALID_IMAGE | TOO_LARGE); `code` là mã chẩn đoán IMAGE_CHECK_CODE.
 */
export function inspectImageBytes(input, { maxPixels = MAX_PIXELS, maxDimension = Infinity } = {}) {
  const header = readImageHeader(input);
  if (!header.ok) {
    const message =
      header.code === IMAGE_CHECK_CODE.UNSUPPORTED_SIGNATURE || header.code === IMAGE_CHECK_CODE.NO_DATA
        ? 'Nội dung file không phải ảnh JPG, PNG hoặc WebP hợp lệ.'
        : 'Header của ảnh bị hỏng hoặc không đọc được kích thước.';
    return invalid(ERROR_REASON.INVALID_IMAGE, header.code, message);
  }

  if (header.animated) {
    return invalid(
      ERROR_REASON.INVALID_IMAGE,
      IMAGE_CHECK_CODE.ANIMATED,
      'Ảnh động (WebP/PNG động) chưa được hỗ trợ. Hãy chọn ảnh tĩnh.',
    );
  }

  const { width, height } = header;
  if (width > maxDimension || height > maxDimension) {
    return invalid(
      ERROR_REASON.TOO_LARGE,
      IMAGE_CHECK_CODE.SIDE_TOO_LONG,
      `Kích thước ảnh ${width}×${height} vượt giới hạn ${maxDimension}px mỗi cạnh.`,
    );
  }
  if (width * height > maxPixels) {
    return invalid(
      ERROR_REASON.TOO_LARGE,
      IMAGE_CHECK_CODE.TOO_MANY_PIXELS,
      `Ảnh ${width}×${height} (${(width * height / MEGAPIXEL).toFixed(1)} triệu điểm ảnh) vượt giới hạn ` +
        `${maxPixels / MEGAPIXEL} triệu điểm ảnh của ứng dụng.`,
    );
  }

  if (!isImageEndingComplete(input, header.type)) {
    return invalid(
      ERROR_REASON.INVALID_IMAGE,
      IMAGE_CHECK_CODE.TRUNCATED,
      'Ảnh có vẻ bị cắt cụt hoặc hỏng (thiếu phần kết thúc file).',
    );
  }

  const shown = displaySize(header);
  return {
    valid: true,
    info: {
      type: header.type,
      width,
      height,
      orientation: header.orientation,
      displayWidth: shown.width,
      displayHeight: shown.height,
    },
  };
}
