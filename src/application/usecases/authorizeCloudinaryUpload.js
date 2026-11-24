// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Xin Backend cấp quyền upload có chữ ký (POST /images/cloudinary/authorize) cho ĐÚNG ba biến thể của một imageId.
//   dựng request từ kích thước/dung lượng THẬT của 3 Blob (Domain) -> gọi port `backendApi` -> KIỂM TRA response (Domain).
// KHÔNG gọi Cloudinary, KHÔNG ghi Firestore, KHÔNG tự retry, KHÔNG bao giờ gia hạn quyền (hạn do Backend quyết định).
// Gọi lại cho CÙNG imageId + CÙNG metadata khi grant còn hạn là hợp lệ: Backend trả lại cùng public_id với chữ ký mới
// (không tốn thêm lượt). Nếu grant đã hết hạn Backend trả 409 => phải bắt đầu phiên mới với imageId mới.
// Kết quả mang `declared` (đúng payload đã gửi) để uploader đối chiếu bytes/kích thước thật với response của Cloudinary.

import {
  UploadAuthorizationError,
  buildAuthorizePayload,
  parseAuthorizeResponse,
  CLOUD_NAME_PATTERN,
} from '../../domain/models/uploadAuthorization';
import { AppError, ERROR_CODE } from '../errors';
import { SIGNED_UPLOAD_KIND, describeBackendFailure, messageForKind } from '../signedUploadErrors';

/**
 * @param {Object} deps
 * @param {import('../ports.js').BackendApi} deps.backendApi
 * @param {string} deps.cloudName  cloud name PUBLIC đã cấu hình ở Frontend; uploadUrl của Backend phải trỏ đúng cloud này
 * @param {() => number} [deps.now]  điểm tiêm để kiểm thử (mặc định Date.now)
 */
export function createAuthorizeCloudinaryUpload({ backendApi, cloudName, now = Date.now }) {
  /**
   * @param {Object} args
   * @param {string} args.imageId
   * @param {{size: number}} args.file
   * @param {string|null} [args.fileName]  đã qua normalizeFileName; phải giống hệt giá trị dùng ở confirm
   * @param {import('../ports.js').ProcessedImage} args.processed
   * @param {AbortSignal} [args.signal]
   */
  return async function authorizeCloudinaryUpload({ imageId, file, fileName, processed, signal } = {}) {
    if (typeof cloudName !== 'string' || !CLOUD_NAME_PATTERN.test(cloudName)) {
      throw new AppError(ERROR_CODE.CONFIG, 'Thiếu hoặc sai cấu hình cloud name Cloudinary ở Frontend nên không thể kiểm tra quyền upload.', {
        kind: 'CONFIG',
        retryable: false,
      });
    }

    let payload;
    try {
      payload = buildAuthorizePayload({ imageId, file, fileName, processed });
    } catch (error) {
      if (error instanceof UploadAuthorizationError) {
        throw new AppError(ERROR_CODE.VALIDATION, error.message, { kind: 'INVALID_PAYLOAD', problems: error.problems, retryable: false });
      }
      throw error;
    }

    let body;
    try {
      body = await backendApi.authorizeCloudinaryUpload(payload, { signal });
    } catch (error) {
      const why = describeBackendFailure(error, { stage: 'AUTHORIZING' });
      throw new AppError(
        why.code,
        messageForKind(why.kind, { retryAfterSeconds: why.retryAfterSeconds }) ?? `Backend chưa cấp quyền upload: ${error?.message || 'lỗi không rõ'}`,
        {
          imageId: payload.imageId,
          kind: why.kind,
          httpStatus: error?.details?.httpStatus,
          detail: error?.details?.detail ?? null,
          retryable: why.retryable,
          newSessionRequired: why.newSessionRequired,
          retryAfterSeconds: why.retryAfterSeconds,
          cause: error,
        },
      );
    }

    let authorization;
    try {
      authorization = parseAuthorizeResponse(body, { expectedImageId: payload.imageId, cloudName, nowMs: now() });
    } catch (error) {
      if (error instanceof UploadAuthorizationError) {
        // Không đưa response (có chữ ký) vào lỗi; chỉ nêu các điểm sai.
        throw new AppError(
          ERROR_CODE.UNKNOWN,
          `Backend trả về quyền upload không hợp lệ nên Frontend từ chối dùng (${error.problems.join('; ')}).`,
          { imageId: payload.imageId, kind: SIGNED_UPLOAD_KIND.INVALID_AUTHORIZATION, problems: error.problems, retryable: false },
        );
      }
      throw error;
    }

    return Object.freeze({ ...authorization, declared: Object.freeze(payload) });
  };
}
