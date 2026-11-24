// INFRASTRUCTURE — bộ xử lý ảnh THẬT chạy trong trình duyệt (Canvas API thuần, không thêm thư viện).
// Cài port `imageProcessor` (application/ports.js): process(source: File|Blob) -> { blobs, width, height, processingMs }.
//
// Luồng (dừng ở lỗi đầu tiên; mọi lỗi mang `errorReason` thuộc ERROR_REASON):
//   1. dung lượng (<= 10MB, TRƯỚC khi đọc nội dung)      -> TOO_LARGE | INVALID_IMAGE (rỗng)
//   2. đọc byte, rồi Domain `inspectImageBytes`: chữ ký, header, ảnh động, cạnh <= 16383, <= MAX_PIXELS,
//      phần kết thúc file (best-effort)                   -> INVALID_IMAGE | TOO_LARGE   (CHƯA giải mã gì)
//   3. giải mã MỘT lần bằng createImageBitmap(imageOrientation: 'from-image')
//        - kích thước bitmap phải đúng bằng kích thước kỳ vọng sau EXIF (Domain `displaySize`)  -> COMPRESS_FAIL
//   4. lần lượt thumbnail -> medium -> full: vẽ lên canvas, mã hóa WebP, giải phóng canvas, XÁC MINH đầu ra
//        (type, magic RIFF/WEBP, không rỗng, header + giải mã lại đúng kích thước)            -> COMPRESS_FAIL
//   5. đóng ImageBitmap (luôn, trong finally)
//
// KHÔNG BAO GIỜ tự thu nhỏ full.webp để lách giới hạn: nếu không giữ được kích thước gốc thì báo lỗi.
// Các lời gọi process() được xếp hàng tuần tự (không bao giờ có hai ảnh lớn cùng nằm trong bộ nhớ);
// một lần lỗi không làm kẹt hàng đợi.
//
// CHƯA KIỂM CHỨNG TRÊN TRÌNH DUYỆT THẬT ở E3b: toàn bộ test dùng đối tượng giả lập. Việc Chrome thực sự
// mã hóa WebP, xoay EXIF 1–8, giới hạn Canvas/bộ nhớ... thuộc E3c.

import { ERROR_REASON } from '../../domain/constants/imageStatus';
import { ALLOWED_TYPES, IMAGE_VARIANTS, MAX_PIXELS } from '../../domain/constants/imageRules';
import { calcVariantSize } from '../../domain/models/image';
import { validateImageFile } from '../../domain/validators/validateImageFile';
import {
  IMAGE_TYPE,
  detectImageType,
  displaySize,
  inspectImageBytes,
  readImageHeader,
} from '../../domain/validators/imageSignature';

/** Giới hạn KỸ THUẬT của encoder WebP: mỗi cạnh tối đa 16383px (chuẩn WebP). Không phải chính sách của ứng dụng. */
export const WEBP_MAX_DIMENSION = 16383;

/**
 * Chất lượng YÊU CẦU gửi cho encoder (tham số, không đảm bảo mọi trình duyệt mã hóa giống hệt nhau).
 * Khóa trùng IMAGE_VARIANTS.
 */
export const WEBP_QUALITY = Object.freeze({ thumbnail: 0.75, medium: 0.8, webp: 0.85 });

const OUTPUT_TYPE = 'image/webp';
const HEADER_SLICE_BYTES = 64 * 1024; // đủ để đọc header WebP của đầu ra
const VARIANT_ORDER = Object.freeze(['thumbnail', 'medium', 'webp']); // nhỏ -> lớn: canvas lớn nhất chỉ tồn tại ở cuối

// ---------- lỗi ----------

const REASONS = new Set(Object.values(ERROR_REASON));

function fail(errorReason, message, { code, cause } = {}) {
  const error = new Error(message);
  error.errorReason = errorReason;
  if (code) error.code = code;
  if (cause !== undefined) error.cause = cause;
  return error;
}

const isTagged = (error) => Boolean(error) && REASONS.has(error.errorReason);

const errorName = (error) => (error && typeof error === 'object' ? error.name : undefined);

/** Lỗi khi giải mã ảnh nguồn: hết bộ nhớ/quá giới hạn -> COMPRESS_FAIL; còn lại coi là ảnh không giải mã được. */
function mapDecodeError(error) {
  const name = errorName(error);
  const text = String(error?.message ?? '');
  if (name === 'RangeError' || name === 'QuotaExceededError' || /memory|alloc/i.test(text)) {
    return fail(
      ERROR_REASON.COMPRESS_FAIL,
      'Trình duyệt không đủ bộ nhớ hoặc vượt giới hạn khi giải mã ảnh. Hãy thử ảnh nhỏ hơn.',
      { cause: error },
    );
  }
  return fail(ERROR_REASON.INVALID_IMAGE, 'Không giải mã được ảnh (file hỏng hoặc không phải ảnh hợp lệ).', {
    cause: error,
  });
}

// ---------- Canvas: OffscreenCanvas nếu có, nếu không dùng <canvas> ----------

/**
 * Bề mặt vẽ + mã hóa. { context, toBlob(type, quality) -> Promise<Blob|null>, release() }.
 * Ném lỗi nếu trình duyệt không hỗ trợ Canvas.
 */
function defaultCreateCanvas(width, height) {
  let canvas;
  let encode;
  if (typeof globalThis.OffscreenCanvas === 'function') {
    canvas = new globalThis.OffscreenCanvas(width, height);
    encode = (type, quality) => canvas.convertToBlob({ type, quality });
  } else if (typeof globalThis.document?.createElement === 'function') {
    canvas = globalThis.document.createElement('canvas');
    canvas.width = width;
    canvas.height = height;
    encode = (type, quality) =>
      new Promise((resolve, reject) => {
        try {
          canvas.toBlob(resolve, type, quality);
        } catch (error) {
          reject(error);
        }
      });
  } else {
    throw new Error('Trình duyệt không hỗ trợ Canvas.');
  }
  return {
    context: canvas.getContext('2d'),
    toBlob: encode,
    release() {
      // Đặt kích thước về 0 để trình duyệt thu hồi bộ đệm điểm ảnh ngay.
      canvas.width = 0;
      canvas.height = 0;
    },
  };
}

function defaultCreateImageBitmap(...args) {
  if (typeof globalThis.createImageBitmap !== 'function') {
    throw fail(ERROR_REASON.COMPRESS_FAIL, 'Trình duyệt không hỗ trợ createImageBitmap.');
  }
  return globalThis.createImageBitmap(...args);
}

const defaultNow = () => globalThis.performance.now();

// ---------- bộ xử lý ----------

/**
 * @param {Object} [options]  Toàn bộ là điểm tiêm phụ thuộc để kiểm thử; mặc định dùng API của trình duyệt.
 * @param {(source: Blob, options?: object) => Promise<ImageBitmap>} [options.createImageBitmap]
 * @param {(width: number, height: number) => {context: object|null, toBlob: Function, release: Function}} [options.createCanvas]
 * @param {() => number} [options.now]  đồng hồ (ms)
 * @param {number} [options.maxPixels=MAX_PIXELS]
 * @param {number} [options.maxDimension=WEBP_MAX_DIMENSION]
 * @param {{thumbnail: number, medium: number, webp: number}} [options.quality=WEBP_QUALITY]
 * @returns {import('../../application/ports.js').ImageProcessor}
 */
export function createBrowserImageProcessor({
  createImageBitmap = defaultCreateImageBitmap,
  createCanvas = defaultCreateCanvas,
  now = defaultNow,
  maxPixels = MAX_PIXELS,
  maxDimension = WEBP_MAX_DIMENSION,
  quality = WEBP_QUALITY,
} = {}) {
  // ----- 1-2. nguồn: dung lượng, đọc byte, kiểm tra nội dung -----
  async function readAndInspect(source) {
    if (!source || typeof source !== 'object' || typeof source.size !== 'number') {
      throw fail(ERROR_REASON.INVALID_IMAGE, 'Không có file ảnh để xử lý.');
    }
    // Chỉ dùng phần KIỂM TRA DUNG LƯỢNG của validateImageFile (type luôn hợp lệ ở đây): loại do NỘI DUNG quyết định,
    // không tin MIME/tên file. Không đọc byte nào trước khi qua bước này.
    const sizeCheck = validateImageFile({ type: ALLOWED_TYPES[0], size: source.size });
    if (!sizeCheck.valid) throw fail(sizeCheck.errorReason, sizeCheck.message);

    if (typeof source.arrayBuffer !== 'function') {
      throw fail(ERROR_REASON.INVALID_IMAGE, 'Không đọc được nội dung file.');
    }
    let bytes;
    try {
      bytes = new Uint8Array(await source.arrayBuffer());
    } catch (cause) {
      throw fail(ERROR_REASON.INVALID_IMAGE, 'Không đọc được nội dung file (file bị xóa hoặc thay đổi?).', { cause });
    }
    if (bytes.byteLength !== source.size) {
      throw fail(ERROR_REASON.INVALID_IMAGE, 'File đã thay đổi trong lúc đọc. Hãy chọn lại file.');
    }

    const inspected = inspectImageBytes(bytes, { maxPixels, maxDimension });
    if (!inspected.valid) {
      throw fail(inspected.errorReason, inspected.message, { code: inspected.code });
    }
    return { bytes, info: inspected.info };
  }

  // ----- 3. giải mã một lần, theo EXIF -----
  async function decodeSource(bytes, info) {
    // Giải mã chính những byte đã kiểm tra, gắn đúng MIME theo nội dung (không theo MIME khai báo của File).
    const blob = new Blob([bytes], { type: info.type });
    let bitmap;
    try {
      bitmap = await createImageBitmap(blob, { imageOrientation: 'from-image' });
    } catch (error) {
      if (isTagged(error)) throw error;
      if (errorName(error) !== 'TypeError') throw mapDecodeError(error);
      // Trình duyệt không nhận tùy chọn imageOrientation. Ảnh orientation 1 không cần xoay nên vẫn xử lý được;
      // ảnh cần xoay/lật thì KHÔNG đảm bảo đúng hướng -> báo lỗi thay vì xuất ảnh sai.
      if (info.orientation !== 1) {
        throw fail(
          ERROR_REASON.COMPRESS_FAIL,
          'Trình duyệt không hỗ trợ xoay ảnh theo EXIF (imageOrientation); không thể bảo đảm ảnh đúng hướng.',
          { cause: error },
        );
      }
      try {
        bitmap = await createImageBitmap(blob);
      } catch (retryError) {
        throw mapDecodeError(retryError);
      }
    }

    // Phòng trường hợp trình duyệt bỏ qua/áp dụng sai orientation: kích thước bitmap phải đúng như kỳ vọng.
    // (Lưu ý: kiểm tra này chỉ bắt được xoay 90°, orientation 2–4 chỉ kiểm chứng bằng bộ test E3c.)
    const expected = displaySize(info);
    if (bitmap.width !== expected.width || bitmap.height !== expected.height) {
      const got = `${bitmap.width}×${bitmap.height}`;
      const want = `${expected.width}×${expected.height}`;
      closeQuietly(bitmap);
      throw fail(
        ERROR_REASON.COMPRESS_FAIL,
        `Kích thước sau giải mã (${got}) khác kích thước kỳ vọng (${want}) khi xử lý EXIF orientation ${info.orientation}. ` +
          'Không thể bảo đảm ảnh đúng hướng.',
        { code: 'ORIENTATION_MISMATCH' },
      );
    }
    return bitmap;
  }

  // ----- 4. một biến thể: vẽ + mã hóa (canvas luôn được giải phóng) -----
  async function encodeVariant(bitmap, size, variantQuality) {
    let surface = null;
    try {
      try {
        surface = createCanvas(size.width, size.height);
      } catch (cause) {
        throw fail(
          ERROR_REASON.COMPRESS_FAIL,
          `Không tạo được Canvas ${size.width}×${size.height} (hết bộ nhớ hoặc vượt giới hạn trình duyệt).`,
          { cause },
        );
      }
      const context = surface?.context;
      if (!context) {
        throw fail(
          ERROR_REASON.COMPRESS_FAIL,
          `Trình duyệt không cấp Canvas 2D cho ảnh ${size.width}×${size.height} (có thể vượt giới hạn Canvas).`,
        );
      }
      context.imageSmoothingEnabled = true;
      context.imageSmoothingQuality = 'high';
      context.drawImage(bitmap, 0, 0, size.width, size.height);

      let blob;
      try {
        blob = await surface.toBlob(OUTPUT_TYPE, variantQuality);
      } catch (cause) {
        throw fail(ERROR_REASON.COMPRESS_FAIL, 'Trình duyệt không mã hóa được WebP.', { cause });
      }
      if (!blob) {
        throw fail(ERROR_REASON.COMPRESS_FAIL, 'Trình duyệt không trả về dữ liệu khi mã hóa WebP.');
      }
      return blob;
    } finally {
      try {
        surface?.release();
      } catch {
        // giải phóng là best-effort; không che lỗi gốc
      }
    }
  }

  // ----- xác minh đầu ra: KHÔNG coi việc truyền type:'image/webp' là bằng chứng đã mã hóa thành công -----
  async function verifyOutput(blob, size, label) {
    const bad = (message, extra) => fail(ERROR_REASON.COMPRESS_FAIL, `${label}: ${message}`, extra);
    if (typeof blob.size !== 'number' || !(blob.size > 0)) throw bad('đầu ra rỗng.');
    if (blob.type !== OUTPUT_TYPE) {
      throw bad(`trình duyệt không mã hóa được WebP (nhận được "${blob.type || 'không rõ'}", không phải ${OUTPUT_TYPE}).`);
    }

    let head;
    try {
      head = new Uint8Array(await blob.slice(0, HEADER_SLICE_BYTES).arrayBuffer());
    } catch (cause) {
      throw bad('không đọc được dữ liệu đầu ra.', { cause });
    }
    if (detectImageType(head) !== IMAGE_TYPE.WEBP) throw bad('dữ liệu đầu ra không có chữ ký RIFF/WEBP.');
    const header = readImageHeader(head);
    if (!header.ok || header.animated || header.width !== size.width || header.height !== size.height) {
      const got = header.ok ? `${header.width}×${header.height}` : `không đọc được (${header.code})`;
      throw bad(`header WebP đầu ra ${got}, kỳ vọng ${size.width}×${size.height}.`);
    }

    let decoded;
    try {
      decoded = await createImageBitmap(blob);
    } catch (cause) {
      throw bad('không giải mã lại được WebP vừa tạo.', { cause });
    }
    try {
      if (decoded.width !== size.width || decoded.height !== size.height) {
        throw bad(`giải mã lại ra ${decoded.width}×${decoded.height}, kỳ vọng ${size.width}×${size.height}.`);
      }
    } finally {
      closeQuietly(decoded);
    }
  }

  // ----- một lần xử lý -----
  async function run(source) {
    const startedAt = now(); // tính từ lúc BẮT ĐẦU xử lý, không gồm thời gian chờ trong hàng đợi
    let bitmap = null;
    try {
      const inspected = await readAndInspect(source);
      const { info } = inspected;
      const readMs = now() - startedAt;

      const decodeStart = now();
      bitmap = await decodeSource(inspected.bytes, info);
      const decodeMs = now() - decodeStart;
      inspected.bytes = null; // không còn cần: bỏ tham chiếu để trình duyệt thu hồi sớm (tối đa 10MB)

      const width = info.displayWidth;
      const height = info.displayHeight;
      const blobs = {};
      const variants = {};

      for (let index = 0; index < VARIANT_ORDER.length; index += 1) {
        const key = VARIANT_ORDER[index];
        const rule = IMAGE_VARIANTS[key];
        const size = calcVariantSize(width, height, rule.maxSize);

        const encodeStart = now();
        const blob = await encodeVariant(bitmap, size, quality[key]);
        const encodeMs = now() - encodeStart;

        // Biến thể cuối (full-size): đóng bitmap nguồn TRƯỚC khi giải mã lại đầu ra, để không giữ hai bitmap lớn cùng lúc.
        if (index === VARIANT_ORDER.length - 1) {
          closeQuietly(bitmap);
          bitmap = null;
        }

        const verifyStart = now();
        await verifyOutput(blob, size, rule.fileName);
        const verifyMs = now() - verifyStart;

        blobs[key] = blob;
        variants[key] = { width: size.width, height: size.height, bytes: blob.size, quality: quality[key], encodeMs, verifyMs };
      }

      return {
        blobs,
        width,
        height,
        processingMs: Math.max(0, Math.round(now() - startedAt)),
        // Thông tin chẩn đoán/đo đạc (ngoài hợp đồng port; Application bỏ qua).
        stats: { sourceType: info.type, orientation: info.orientation, readMs, decodeMs, variants },
      };
    } catch (error) {
      if (isTagged(error)) throw error;
      throw fail(ERROR_REASON.COMPRESS_FAIL, `Xử lý ảnh thất bại: ${error?.message || 'lỗi không rõ'}.`, {
        cause: error,
      });
    } finally {
      closeQuietly(bitmap); // luôn đóng, kể cả khi lỗi
    }
  }

  // Hàng đợi tuần tự. `tail` luôn là promise đã được "nuốt lỗi" nên một ảnh lỗi không làm kẹt ảnh sau.
  let tail = Promise.resolve();

  return {
    process(source) {
      const result = tail.then(() => run(source));
      tail = result.then(
        () => undefined,
        () => undefined,
      );
      return result;
    },
  };
}

function closeQuietly(bitmap) {
  try {
    bitmap?.close?.();
  } catch {
    // đóng là best-effort
  }
}

/** Bộ xử lý mặc định dùng API thật của trình duyệt. Chỉ dùng được trong trình duyệt (chưa kiểm chứng ở E3b). */
export const browserImageProcessor = createBrowserImageProcessor();
