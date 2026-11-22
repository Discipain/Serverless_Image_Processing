// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Xác nhận với Backend rằng 3 biến thể đã được upload lên Cloudinary (POST /images/cloudinary/confirm).
// CHỈ điều phối: dựng + kiểm tra payload (Domain) -> gọi port `backendApi` -> kiểm tra kết quả.
// KHÔNG gọi uploader Cloudinary, KHÔNG gọi Firestore/Firebase, KHÔNG xóa gì, KHÔNG tự retry.
//
//  - DONE CHỈ có khi backendApi trả kết quả hợp lệ (status 'DONE' và imageId khớp). Upload xong 3 WebP chưa phải DONE.
//  - Nếu confirm thất bại SAU khi đã upload: lỗi giữ code của lỗi gốc và mang theo `details.assets` (kết quả upload)
//    + `details.confirmPayload`, để luồng tích hợp sau này có thể thử lại CHỈ bước confirm (không upload lại).
//    H3A chưa lưu bền vững các thông tin này.
//  - imageId do FRONTEND tạo bằng crypto.randomUUID() MỘT LẦN trước khi nén (CONTRACT 72ee441; dùng lại hàm generateId
//    có sẵn khi tích hợp H4) và do nơi gọi truyền vào. Use case này KHÔNG sinh imageId, và khi thử lại confirm
//    nơi gọi phải truyền lại CÙNG imageId (Backend dùng nó làm khóa chống trùng: nhận trùng thì trả bản cũ).
//  - Request: 6 field bắt buộc + các field tùy chọn hợp lệ (xem domain/models/confirmPayload.js), gồm processedSize =
//    tổng kích thước 3 Blob THẬT của kết quả nén (processed.blobs.*.size) mà luồng luôn truyền xuống. contentType KHÔNG được gửi.

import { buildConfirmPayload, ConfirmPayloadError } from '../../domain/models/confirmPayload';
import { AppError, ERROR_CODE } from '../errors';

const KNOWN_CODES = new Set(Object.values(ERROR_CODE));

/**
 * @param {Object} deps
 * @param {import('../ports.js').BackendApi} deps.backendApi
 */
export function createConfirmCloudinaryUpload({ backendApi }) {
  /**
   * @param {Object} args
   * @param {string} args.imageId
   * @param {{name?: string, size: number}} args.file  file GỐC người dùng chọn (size bắt buộc; name tùy chọn)
   * @param {{width?: number, height?: number, processingMs: number, blobs?: {thumbnail: Blob, medium: Blob, webp: Blob}}} args.processed
   *        kết quả của imageProcessor; kích thước 3 Blob thật được dùng để tính processedSize
   * @param {{thumbnail: object, medium: object, webp: object}} args.assets  kết quả upload (uploadVariantsToCloudinary);
   *        mỗi asset cần secureUrl, và publicId (nếu có) sẽ thành thumbnailId/mediumId/webpId
   * @param {AbortSignal} [args.signal]
   * @returns {Promise<{imageId: string, status: 'DONE', ownerId: string|null, variants: object, processingMs: number|null, savedPercent: number|null, isMock: boolean}>}
   */
  return async function confirmCloudinaryUpload({ imageId, file, processed, assets, signal } = {}) {
    let payload;
    try {
      // file.type vẫn ở file gốc để dùng cục bộ, KHÔNG đưa vào request. processedSize được tính trong Domain từ
      // kích thước THẬT của 3 Blob (không suy từ URL, không ước đoán).
      payload = buildConfirmPayload({
        imageId,
        originalSize: file?.size,
        processingMs: processed?.processingMs,
        assets,
        fileName: file?.name,
        width: processed?.width,
        height: processed?.height,
        variantSizes: {
          thumbnail: processed?.blobs?.thumbnail?.size,
          medium: processed?.blobs?.medium?.size,
          webp: processed?.blobs?.webp?.size,
        },
      });
    } catch (error) {
      if (error instanceof ConfirmPayloadError) {
        throw new AppError(ERROR_CODE.VALIDATION, error.message, {
          kind: 'INVALID_PAYLOAD',
          problems: error.problems,
          assets,
        });
      }
      throw error;
    }

    let result;
    try {
      result = await backendApi.confirmCloudinaryUpload(payload, { signal });
    } catch (error) {
      const code = KNOWN_CODES.has(error?.code) ? error.code : ERROR_CODE.UNKNOWN;
      throw new AppError(
        code,
        `Backend chưa xác nhận ảnh: ${error?.message || 'lỗi không rõ'} Các ảnh đã upload lên Cloudinary được giữ lại để thử xác nhận lại (không cần upload lại).`,
        {
          imageId: payload.imageId,
          kind: error?.details?.kind,
          httpStatus: error?.details?.httpStatus,
          retryable: error?.details?.retryable === true,
          assets,
          confirmPayload: payload,
          cause: error,
        },
      );
    }

    // Kiểm tra lần nữa ở Application: không tin tuyệt đối vào adapter.
    if (!result || result.status !== 'DONE' || result.imageId !== payload.imageId) {
      throw new AppError(
        ERROR_CODE.UNKNOWN,
        'Backend trả về kết quả xác nhận không hợp lệ (không phải DONE hoặc imageId không khớp). Ảnh chưa được coi là hoàn tất.',
        { imageId: payload.imageId, kind: 'INVALID_RESPONSE', retryable: false, assets, confirmPayload: payload },
      );
    }

    return Object.freeze({
      imageId: result.imageId,
      status: 'DONE',
      ownerId: result.ownerId ?? null,
      variants: result.variants,
      processingMs: result.processingMs ?? null,
      savedPercent: result.savedPercent ?? null,
      isMock: result.isMock === true,
    });
  };
}
