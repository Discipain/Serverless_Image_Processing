// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Upload 3 biến thể WebP (thumbnail, medium, webp) lên Cloudinary qua port `cloudinaryUploader`.
// CHỈ làm việc upload: KHÔNG gọi Backend confirm, KHÔNG ghi Firestore, KHÔNG xóa gì trên Cloudinary, KHÔNG tự retry.
//
//  - Thứ tự CỐ ĐỊNH: thumbnail -> medium -> webp (tuần tự). Dừng ở lỗi đầu tiên (các biến thể sau không được thử).
//  - Chỉ nhận ĐÚNG 3 Blob: không upload ảnh gốc, không có ảnh thứ tư.
//  - Thành công: trả { thumbnail, medium, webp }, mỗi phần là CloudinaryAsset (secureUrl, publicId, ...).
//    Đây là cấu trúc nội bộ, KHÔNG phải payload chính thức của API confirm.
//  - Thất bại giữa chừng: ném AppError giữ `code` của lỗi gốc (CANCELLED, NETWORK, CONFIG, UPLOAD_FAILED...), kèm
//    details { failedVariant, uploaded, notAttempted, partial, orphanedPublicIds, kind, cause }.
//    Các ảnh đã upload KHÔNG bị tự xóa => có nguy cơ ảnh mồ côi trên Cloudinary (Backend/H3 sẽ xử lý).

import { IMAGE_VARIANTS } from '../../domain/constants/imageRules';
import { AppError, ERROR_CODE } from '../errors';

const VARIANT_KEYS = Object.freeze(Object.keys(IMAGE_VARIANTS)); // thứ tự khai báo: thumbnail, medium, webp
const KNOWN_CODES = new Set(Object.values(ERROR_CODE));

function describeFailure({ variant, error, uploaded, notAttempted }) {
  const uploadedNames = Object.keys(uploaded);
  let message = `Upload biến thể "${variant}" thất bại: ${error?.message || 'lỗi không rõ'}`;
  if (uploadedNames.length > 0) {
    message +=
      ` ${uploadedNames.length} biến thể đã upload (${uploadedNames.join(', ')}) KHÔNG bị tự xóa trên Cloudinary` +
      ' và chưa được xác nhận với Backend.';
  }
  if (notAttempted.length > 0) message += ` Chưa thử: ${notAttempted.join(', ')}.`;
  return message;
}

/**
 * @param {Object} deps
 * @param {import('../ports.js').CloudinaryUploader} deps.cloudinaryUploader
 */
export function createUploadVariantsToCloudinary({ cloudinaryUploader }) {
  /**
   * @param {Object} args
   * @param {{thumbnail: Blob, medium: Blob, webp: Blob}} args.blobs  đúng 3 khóa, không hơn không kém
   * @param {(p: {variant: string, variantIndex: number, variantPercent: number, overallPercent: number}) => void} [args.onProgress]
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{thumbnail: object, medium: object, webp: object}>}
   */
  return async function uploadVariantsToCloudinary({ blobs, onProgress, signal } = {}) {
    const given = blobs && typeof blobs === 'object' ? Object.keys(blobs) : [];
    const extra = given.filter((key) => !VARIANT_KEYS.includes(key));
    const missing = VARIANT_KEYS.filter((key) => !blobs?.[key]);
    if (extra.length > 0 || missing.length > 0) {
      const parts = [];
      if (missing.length > 0) parts.push(`thiếu ${missing.join(', ')}`);
      if (extra.length > 0) parts.push(`thừa ${extra.join(', ')} (không upload ảnh gốc hay ảnh ngoài 3 biến thể)`);
      throw new AppError(
        ERROR_CODE.VALIDATION,
        `Chỉ upload đúng 3 biến thể ${VARIANT_KEYS.join(', ')}: ${parts.join('; ')}.`,
      );
    }

    const totalBytes = VARIANT_KEYS.reduce((sum, key) => sum + blobs[key].size, 0);
    const uploaded = {};
    let doneBytes = 0;

    for (const [index, variant] of VARIANT_KEYS.entries()) {
      const blob = blobs[variant];
      try {
        // Đã hủy giữa các lần upload: không bắt đầu file kế tiếp.
        if (signal?.aborted) {
          throw new AppError(ERROR_CODE.CANCELLED, 'Đã hủy upload.', { kind: 'CANCELLED' });
        }
        uploaded[variant] = await cloudinaryUploader.upload({
          blob,
          variant,
          signal,
          onProgress: (percent) => {
            if (typeof onProgress !== 'function') return;
            const overall = totalBytes > 0 ? ((doneBytes + (blob.size * percent) / 100) / totalBytes) * 100 : 0;
            try {
              onProgress({
                variant,
                variantIndex: index,
                variantPercent: percent,
                overallPercent: Math.min(100, Math.floor(overall)),
              });
            } catch {
              // lỗi của callback không được làm hỏng upload
            }
          },
        });
        doneBytes += blob.size;
      } catch (error) {
        const notAttempted = VARIANT_KEYS.slice(index + 1);
        const code = KNOWN_CODES.has(error?.code) ? error.code : ERROR_CODE.UPLOAD_FAILED;
        throw new AppError(code, describeFailure({ variant, error, uploaded, notAttempted }), {
          failedVariant: variant,
          uploaded: { ...uploaded },
          notAttempted,
          partial: Object.keys(uploaded).length > 0,
          orphanedPublicIds: Object.values(uploaded).map((asset) => asset.publicId),
          kind: error?.details?.kind,
          cause: error,
        });
      }
    }

    return Object.freeze({ ...uploaded });
  };
}
