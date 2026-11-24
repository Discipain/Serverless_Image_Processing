// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Upload 3 biến thể WebP bằng quyền upload CÓ CHỮ KÝ (kết quả của authorizeCloudinaryUpload) qua port `signedCloudinaryUploader`.
// CHỈ làm việc upload: KHÔNG gọi Backend, KHÔNG ghi Firestore, KHÔNG xóa gì trên Cloudinary, KHÔNG tự retry.
//
//  - Thứ tự CỐ ĐỊNH thumbnail -> medium -> webp, tuần tự, dừng ở lỗi đầu tiên. Chỉ nhận ĐÚNG 3 Blob.
//  - Tiếp tục dở dang: `uploaded` là các biến thể ĐÃ upload ở lần trước (cùng imageId). Biến thể nào đã có và khớp public_id được
//    cấp thì KHÔNG upload lại; chỉ upload phần còn thiếu.
//  - Grant hết hạn (theo hạn Backend cấp, trừ một biên an toàn) => KHÔNG bắt đầu upload biến thể mới (kind GRANT_EXPIRED,
//    newSessionRequired). Frontend không gia hạn grant. Biến thể đã lên Cloudinary không bị xóa (có thể thành asset mồ côi).
//  - Thất bại giữa chừng: AppError giữ `code` của lỗi gốc, kèm details { failedVariant, uploaded (gồm cả phần đã có từ trước),
//    notAttempted, partial, orphanedPublicIds, kind, retryable, newSessionRequired, cause }.

import { IMAGE_VARIANTS } from '../../domain/constants/imageRules';
import { AppError, ERROR_CODE } from '../errors';
import { SIGNED_UPLOAD_KIND } from '../signedUploadErrors';

const VARIANT_KEYS = Object.freeze(Object.keys(IMAGE_VARIANTS));
const KNOWN_CODES = new Set(Object.values(ERROR_CODE));
/** Không bắt đầu một upload mới khi grant chỉ còn ít hơn khoảng này (confirm còn phải hoàn tất trước hạn). */
export const EXPIRY_MARGIN_MS = 5_000;

/**
 * @param {Object} deps
 * @param {{upload: Function}} deps.signedUploader
 * @param {() => number} [deps.now]  mặc định Date.now (tiêm để kiểm thử)
 */
export function createUploadVariantsSigned({ signedUploader, now = Date.now }) {
  /**
   * @param {Object} args
   * @param {{thumbnail: Blob, medium: Blob, webp: Blob}} args.blobs
   * @param {object} args.authorization  kết quả authorizeCloudinaryUpload (uploadUrl, uploads, declared, expiresAtMs)
   * @param {Record<string, object>} [args.uploaded]  biến thể đã upload ở lần trước
   * @param {(p: {variant: string, variantIndex: number, variantPercent: number, overallPercent: number}) => void} [args.onProgress]
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{thumbnail: object, medium: object, webp: object}>}
   */
  return async function uploadVariantsSigned({ blobs, authorization, uploaded: previous = {}, onProgress, signal } = {}) {
    const given = blobs && typeof blobs === 'object' ? Object.keys(blobs) : [];
    const extra = given.filter((key) => !VARIANT_KEYS.includes(key));
    const missing = VARIANT_KEYS.filter((key) => !blobs?.[key]);
    if (extra.length > 0 || missing.length > 0) {
      const parts = [];
      if (missing.length > 0) parts.push(`thiếu ${missing.join(', ')}`);
      if (extra.length > 0) parts.push(`thừa ${extra.join(', ')} (không upload ảnh gốc hay ảnh ngoài 3 biến thể)`);
      throw new AppError(ERROR_CODE.VALIDATION, `Chỉ upload đúng 3 biến thể ${VARIANT_KEYS.join(', ')}: ${parts.join('; ')}.`, { retryable: false });
    }
    if (!authorization?.uploads || !authorization.declared?.variants) {
      throw new AppError(ERROR_CODE.VALIDATION, 'Thiếu quyền upload có chữ ký để upload.', { kind: SIGNED_UPLOAD_KIND.INVALID_AUTHORIZATION, retryable: false });
    }

    const totalBytes = VARIANT_KEYS.reduce((sum, key) => sum + blobs[key].size, 0);
    const uploaded = {};
    let doneBytes = 0;
    // Giữ lại phần đã có từ trước CHỈ khi khớp public_id được cấp (không tin một asset lạ).
    for (const key of VARIANT_KEYS) {
      const asset = previous?.[key];
      if (asset && asset.publicId === authorization.uploads[key].fields.public_id) {
        uploaded[key] = asset;
        doneBytes += blobs[key].size;
      }
    }

    for (const [index, variant] of VARIANT_KEYS.entries()) {
      if (uploaded[variant]) continue;
      const blob = blobs[variant];
      const notAttempted = VARIANT_KEYS.slice(index + 1).filter((key) => !uploaded[key]);
      const failWith = (error, extraDetails = {}) => {
        const code = KNOWN_CODES.has(error?.code) ? error.code : ERROR_CODE.UPLOAD_FAILED;
        const done = Object.keys(uploaded);
        let message = `Upload biến thể "${variant}" thất bại: ${error?.message || 'lỗi không rõ'}`;
        if (done.length > 0) {
          message += ` ${done.length} biến thể đã upload (${done.join(', ')}) KHÔNG bị tự xóa trên Cloudinary và chưa được xác nhận với Backend.`;
        }
        if (notAttempted.length > 0) message += ` Chưa thử: ${notAttempted.join(', ')}.`;
        return new AppError(code, message, {
          failedVariant: variant,
          uploaded: { ...uploaded },
          notAttempted,
          partial: done.length > 0,
          orphanedPublicIds: Object.values(uploaded).map((asset) => asset.publicId),
          kind: error?.details?.kind,
          httpStatus: error?.details?.httpStatus,
          retryable: error?.details?.retryable === true,
          newSessionRequired: error?.details?.newSessionRequired === true,
          cause: error,
          ...extraDetails,
        });
      };

      if (signal?.aborted) throw failWith(new AppError(ERROR_CODE.CANCELLED, 'Đã hủy upload.', { kind: 'CANCELLED' }));
      if (now() >= authorization.expiresAtMs - EXPIRY_MARGIN_MS) {
        throw failWith(
          new AppError(ERROR_CODE.UPLOAD_FAILED, 'Quyền upload đã hết hạn nên không upload thêm. Hãy bắt đầu lại với phiên upload mới.', {
            kind: SIGNED_UPLOAD_KIND.GRANT_EXPIRED,
          }),
          { kind: SIGNED_UPLOAD_KIND.GRANT_EXPIRED, retryable: false, newSessionRequired: true },
        );
      }

      try {
        uploaded[variant] = await signedUploader.upload({
          blob,
          variant,
          uploadUrl: authorization.uploadUrl,
          fields: authorization.uploads[variant].fields,
          expected: authorization.declared.variants[variant],
          signal,
          onProgress: (percent) => {
            if (typeof onProgress !== 'function') return;
            const overall = totalBytes > 0 ? ((doneBytes + (blob.size * percent) / 100) / totalBytes) * 100 : 0;
            try {
              onProgress({ variant, variantIndex: index, variantPercent: percent, overallPercent: Math.min(100, Math.floor(overall)) });
            } catch {
              // lỗi của callback không được làm hỏng upload
            }
          },
        });
        doneBytes += blob.size;
      } catch (error) {
        throw failWith(error);
      }
    }

    return Object.freeze({ thumbnail: uploaded.thumbnail, medium: uploaded.medium, webp: uploaded.webp });
  };
}
