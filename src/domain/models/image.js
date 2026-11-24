// DOMAIN — JavaScript thuần: không import React, Firebase hay lớp khác.

import { ERROR_REASON, IMAGE_STATUS } from '../constants/imageStatus';
import { IMAGE_VARIANTS } from '../constants/imageRules';

// ---------- Quy tắc chuyển trạng thái ----------

// PENDING    -> PROCESSING : nén xong, bắt đầu upload
// PENDING    -> FAILED     : lỗi khi nén / xử lý ảnh
// PROCESSING -> DONE       : upload đủ tất cả file cần thiết
// PROCESSING -> FAILED     : upload thất bại
// FAILED     -> PENDING    : người dùng bấm thử lại (retryCount + 1)
// DONE là trạng thái cuối.
const STATUS_TRANSITIONS = Object.freeze({
  [IMAGE_STATUS.PENDING]: Object.freeze([IMAGE_STATUS.PROCESSING, IMAGE_STATUS.FAILED]),
  [IMAGE_STATUS.PROCESSING]: Object.freeze([IMAGE_STATUS.DONE, IMAGE_STATUS.FAILED]),
  [IMAGE_STATUS.FAILED]: Object.freeze([IMAGE_STATUS.PENDING]),
  [IMAGE_STATUS.DONE]: Object.freeze([]),
});

/** Chuyển từ trạng thái `from` sang `to` có hợp lệ không? Trạng thái lạ -> false. */
export function canTransition(from, to) {
  const allowed = Object.hasOwn(STATUS_TRANSITIONS, from) ? STATUS_TRANSITIONS[from] : null;
  return allowed ? allowed.includes(to) : false;
}

// ---------- Phép tính dung lượng ----------

/**
 * % tiết kiệm theo TEST-PLAN.md: (1 - processedSize / originalSize) x 100.
 * Trả về số (có thể âm nếu ảnh sau xử lý lớn hơn ảnh gốc), hoặc null nếu thiếu dữ liệu.
 */
export function calcSavedPercent(originalSize, processedSize) {
  if (!originalSize || typeof processedSize !== 'number') return null;
  return (1 - processedSize / originalSize) * 100;
}

/**
 * Tổng dung lượng 3 file sau nén (SCHEMA.md: processedSize).
 * `sizes` = { thumbnail, medium, webp } (byte). Thiếu hoặc sai kiểu ở bất kỳ biến thể nào -> null.
 */
export function sumProcessedSize(sizes) {
  if (!sizes) return null;
  let total = 0;
  for (const key of Object.keys(IMAGE_VARIANTS)) {
    const size = sizes[key];
    if (typeof size !== 'number' || !Number.isFinite(size) || size < 0) return null;
    total += size;
  }
  return total;
}

// ---------- Kích thước biến thể ----------

/**
 * Kích thước (px) của một biến thể từ kích thước ảnh nguồn (đã xoay theo EXIF).
 *   - maxSize = null            -> giữ nguyên kích thước (biến thể full.webp, KHÔNG tự thu nhỏ)
 *   - cạnh dài <= maxSize       -> giữ nguyên (không phóng to ảnh nhỏ)
 *   - cạnh dài > maxSize        -> cạnh dài = đúng maxSize, cạnh ngắn theo tỉ lệ, làm tròn, tối thiểu 1px
 * Ném lỗi khi width/height không phải số nguyên dương hoặc maxSize không hợp lệ (lỗi lập trình, không phải lỗi người dùng).
 * @returns {{ width: number, height: number }}
 */
export function calcVariantSize(width, height, maxSize) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < 1 || height < 1) {
    throw new RangeError('width và height phải là số nguyên dương.');
  }
  if (maxSize === null) return { width, height };
  if (!Number.isInteger(maxSize) || maxSize < 1) {
    throw new RangeError('maxSize phải là số nguyên dương hoặc null.');
  }
  const longSide = Math.max(width, height);
  if (longSide <= maxSize) return { width, height };
  const scale = (side) => Math.max(1, Math.round((side * maxSize) / longSide));
  return width >= height
    ? { width: maxSize, height: scale(height) }
    : { width: scale(width), height: maxSize };
}

// ---------- Quy ước đường dẫn Storage (CONTRACT.md mục 4) ----------

/** "uploads/<uid>/<imageId>/anh-bien.jpg" -> "anh-bien.jpg" ('' nếu không có đường dẫn). */
export function fileNameFromPath(path) {
  if (!path) return '';
  return path.split('/').pop();
}

/**
 * Trả về { original, thumbnail, medium, webp } — 4 object cho mỗi ảnh:
 *   original  : uploads/{uid}/{imageId}/{fileNameGoc}
 *   thumbnail : processed/{uid}/{imageId}/thumb.webp
 *   medium    : processed/{uid}/{imageId}/medium.webp
 *   webp      : processed/{uid}/{imageId}/full.webp
 * Ký tự '/' và '\' trong tên file gốc bị thay bằng '_' để tên file không thể thoát khỏi thư mục ảnh.
 * Tên file là '.' hoặc '..' bị từ chối.
 */
export function buildStoragePaths(uid, imageId, originalFileName) {
  if (!uid || !imageId || !originalFileName) {
    throw new Error('buildStoragePaths cần đủ uid, imageId và tên file gốc.');
  }

  const safeName = String(originalFileName).replace(/[\\/]/g, '_');
  if (safeName === '.' || safeName === '..') {
    throw new Error('Tên file gốc không hợp lệ.');
  }

  const paths = { original: `uploads/${uid}/${imageId}/${safeName}` };
  for (const [key, variant] of Object.entries(IMAGE_VARIANTS)) {
    paths[key] = `processed/${uid}/${imageId}/${variant.fileName}`;
  }
  return paths;
}

// ---------- Dựng document `images/{imageId}` (SCHEMA.md, trường phẳng) ----------
// createdAt / updatedAt KHÔNG nằm ở đây: do repository (Infrastructure) gán (serverTimestamp).
// Giá trị `null` trong bản cập nhật nghĩa là "xóa trường" (xem application/ports.js).

/** Document ban đầu khi vừa nhận file hợp lệ: status PENDING, retryCount 0. */
export function createPendingImage({ imageId, ownerId, originalPath, originalSize }) {
  if (!imageId || !ownerId || !originalPath) {
    throw new Error('createPendingImage cần imageId, ownerId và originalPath.');
  }
  if (typeof originalSize !== 'number' || !Number.isFinite(originalSize) || originalSize <= 0) {
    throw new Error('createPendingImage cần originalSize là số dương.');
  }
  return {
    imageId,
    ownerId,
    status: IMAGE_STATUS.PENDING,
    originalPath,
    originalSize,
    retryCount: 0,
  };
}

/**
 * Bản cập nhật khi ĐÃ upload đủ file: chỉ dùng cho bước PROCESSING -> DONE.
 *   paths : kết quả buildStoragePaths (variants lưu ĐƯỜNG DẪN, không lưu URL)
 *   sizes : { thumbnail, medium, webp } dung lượng từng file sau nén (byte)
 */
export function buildDoneUpdate({ paths, sizes, width, height, processingMs }) {
  const processedSize = sumProcessedSize(sizes);
  if (processedSize === null) {
    throw new Error('buildDoneUpdate: dung lượng các biến thể không hợp lệ.');
  }
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) {
    throw new Error('buildDoneUpdate: kích thước ảnh gốc không hợp lệ.');
  }
  if (!Number.isFinite(processingMs) || processingMs < 0) {
    throw new Error('buildDoneUpdate: processingMs không hợp lệ.');
  }

  const variants = {};
  for (const key of Object.keys(IMAGE_VARIANTS)) {
    if (!paths?.[key]) throw new Error(`buildDoneUpdate: thiếu đường dẫn biến thể "${key}".`);
    variants[key] = paths[key];
  }

  return {
    status: IMAGE_STATUS.DONE,
    variants,
    processedSize,
    originalWidth: width,
    originalHeight: height,
    processingMs,
    errorReason: null,
  };
}

/** Bản cập nhật khi lỗi (PENDING/PROCESSING -> FAILED). `errorReason` phải thuộc ERROR_REASON. */
export function buildFailedUpdate(errorReason) {
  if (!Object.values(ERROR_REASON).includes(errorReason)) {
    throw new Error(`buildFailedUpdate: errorReason không hợp lệ: ${String(errorReason)}`);
  }
  return { status: IMAGE_STATUS.FAILED, errorReason };
}

/** Bản cập nhật khi thử lại (FAILED -> PENDING): retryCount + 1, xóa errorReason. */
export function buildRetryUpdate(retryCount) {
  const current = Number.isInteger(retryCount) && retryCount >= 0 ? retryCount : 0;
  return { status: IMAGE_STATUS.PENDING, retryCount: current + 1, errorReason: null };
}
