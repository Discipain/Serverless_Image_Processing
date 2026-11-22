// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Luồng upload Hybrid cho MỘT ảnh:
//   Validate -> tạo imageId (MỘT lần) -> Nén 3 WebP -> Upload 3 biến thể (port cloudinaryUploader)
//   -> Confirm với Backend (port backendApi) -> DONE.
// Mọi phụ thuộc được truyền vào (Dependency Injection): ở H4A là adapter MOCK; ở H3B/H4B sẽ là adapter thật.
//
//  - imageId do FRONTEND tạo (generateId = crypto.randomUUID) MỘT lần, SAU validate và TRƯỚC khi nén (CONTRACT 72ee441).
//    Nó được giữ trong `session` và dùng lại ở mọi lần thử lại. Không gọi API cấp imageId.
//  - DONE CHỈ khi bước confirm trả kết quả hợp lệ (confirmCloudinaryUpload đã kiểm tra status DONE + imageId khớp).
//    Nén/upload xong chưa phải DONE.
//  - Thử lại = chạy tiếp từ bước đã thất bại bằng `session` mà lỗi mang theo (error.details.session):
//      * confirm lỗi  -> CHỈ confirm lại (cùng imageId, cùng 3 asset đã upload; KHÔNG nén lại, KHÔNG upload lại);
//      * upload lỗi   -> upload lại 3 biến thể từ bản đã nén (cùng imageId); các asset đã lên trước đó
//                        (details.uploadedVariants) KHÔNG bị xóa nên có nguy cơ ảnh mồ côi, Backend/H3B xử lý;
//      * nén lỗi      -> nén lại (cùng imageId).
//  - Không tự retry, không gọi Firestore, không xóa gì trên Cloudinary.

import { validateImageFile } from '../../domain/validators/validateImageFile';
import { ERROR_REASON } from '../../domain/constants/imageStatus';
import { AppError, ERROR_CODE } from '../errors';

export const UPLOAD_STAGE = Object.freeze({
  VALIDATING: 'VALIDATING',
  COMPRESSING: 'COMPRESSING',
  UPLOADING: 'UPLOADING',
  CONFIRMING: 'CONFIRMING',
});

const KNOWN_CODES = new Set(Object.values(ERROR_CODE));
const RETRYABLE_CODES = new Set([ERROR_CODE.NETWORK, ERROR_CODE.QUOTA_EXCEEDED, ERROR_CODE.CANCELLED]);

function isRetryable(stage, code, error) {
  if (error?.details?.retryable === true) return true;
  if (RETRYABLE_CODES.has(code)) return true;
  // Cloudinary trả lỗi máy chủ (5xx) ở bước upload: thử lại hợp lý.
  if (stage === UPLOAD_STAGE.UPLOADING && error?.details?.kind === 'CLOUDINARY_REJECTED' && error.details.httpStatus >= 500) {
    return true;
  }
  // Nén lỗi do xử lý (không phải file hỏng/quá lớn): thử lại được.
  if (stage === UPLOAD_STAGE.COMPRESSING) return error?.errorReason === ERROR_REASON.COMPRESS_FAIL;
  return false;
}

/**
 * @param {Object} deps
 * @param {import('../ports.js').ImageProcessor} deps.imageProcessor
 * @param {(args: {blobs: object, signal?: AbortSignal, onProgress?: Function}) => Promise<object>} deps.uploadVariantsToCloudinary
 * @param {(args: object) => Promise<object>} deps.confirmCloudinaryUpload
 * @param {() => string} deps.generateId
 */
export function createUploadImageHybrid({ imageProcessor, uploadVariantsToCloudinary, confirmCloudinaryUpload, generateId }) {
  /**
   * @param {Object} args
   * @param {File} [args.file]       ảnh người dùng chọn (lần chạy đầu)
   * @param {Object} [args.session]  phiên từ error.details.session (thử lại); khi có thì bỏ qua `file`
   * @param {AbortSignal} [args.signal]
   * @param {(e: {stage: string, imageId: string|null}) => void} [args.onStage]
   * @param {(p: {variant: string, variantIndex: number, variantPercent: number, overallPercent: number}) => void} [args.onProgress]
   * @returns {Promise<{imageId: string, status: 'DONE', confirm: object, assets: object, processed: object, file: object}>}
   * @throws {AppError} details: { stage, imageId, retryable, session, uploadedVariants, errorReason, kind, cause }
   *         (kiểm tra file thất bại: chưa có imageId/session)
   */
  return async function uploadImageHybrid({ file, session, signal, onStage, onProgress } = {}) {
    const emit = (stage, imageId) => {
      try {
        onStage?.({ stage, imageId: imageId ?? null });
      } catch {
        // lỗi của callback không được làm hỏng luồng
      }
    };

    let state;
    if (session) {
      if (typeof session.imageId !== 'string' || !session.imageId || !session.file) {
        throw new AppError(ERROR_CODE.VALIDATION, 'Phiên upload không hợp lệ để thử lại.', { stage: UPLOAD_STAGE.VALIDATING, retryable: false });
      }
      state = { imageId: session.imageId, file: session.file, processed: session.processed ?? null, assets: session.assets ?? null };
    } else {
      emit(UPLOAD_STAGE.VALIDATING, null);
      const check = validateImageFile(file);
      if (!check.valid) {
        // Bị chặn TRƯỚC khi tạo imageId: không có gì để thử lại ngoài việc chọn file khác.
        throw new AppError(ERROR_CODE.VALIDATION, check.message, {
          stage: UPLOAD_STAGE.VALIDATING,
          errorReason: check.errorReason,
          retryable: false,
        });
      }
      const imageId = generateId();
      if (typeof imageId !== 'string' || imageId === '') {
        throw new AppError(ERROR_CODE.UNKNOWN, 'Không tạo được imageId.', { stage: UPLOAD_STAGE.VALIDATING, retryable: false });
      }
      state = { imageId, file, processed: null, assets: null };
    }

    const fail = (stage, error) => {
      const code = KNOWN_CODES.has(error?.code) ? error.code : ERROR_CODE.UPLOAD_FAILED;
      const reason = error?.errorReason ?? error?.details?.errorReason;
      // File hỏng/quá lớn phát hiện lúc nén: là lỗi dữ liệu người dùng, không phải lỗi hệ thống.
      const finalCode =
        stage === UPLOAD_STAGE.COMPRESSING && (reason === ERROR_REASON.INVALID_IMAGE || reason === ERROR_REASON.TOO_LARGE)
          ? ERROR_CODE.VALIDATION
          : code;
      return new AppError(finalCode, error?.message || 'lỗi không rõ', {
        stage,
        imageId: state.imageId,
        retryable: isRetryable(stage, finalCode, error),
        errorReason: reason,
        kind: error?.details?.kind,
        httpStatus: error?.details?.httpStatus,
        // Các biến thể đã upload nhưng chưa được xác nhận (không bị tự xóa).
        uploadedVariants: Object.keys(error?.details?.uploaded ?? state.assets ?? {}),
        // Trạng thái để thử lại: cùng imageId, giữ bản nén và asset đã có.
        session: Object.freeze({ ...state }),
        cause: error,
      });
    };
    const cancelled = (stage) =>
      fail(stage, new AppError(ERROR_CODE.CANCELLED, 'Đã hủy.', { kind: 'CANCELLED' }));

    // ----- Nén -----
    if (!state.processed) {
      if (signal?.aborted) throw cancelled(UPLOAD_STAGE.COMPRESSING);
      emit(UPLOAD_STAGE.COMPRESSING, state.imageId);
      try {
        state.processed = await imageProcessor.process(state.file);
      } catch (error) {
        throw fail(UPLOAD_STAGE.COMPRESSING, error);
      }
    }

    // ----- Upload 3 biến thể -----
    if (!state.assets) {
      if (signal?.aborted) throw cancelled(UPLOAD_STAGE.UPLOADING);
      emit(UPLOAD_STAGE.UPLOADING, state.imageId);
      try {
        state.assets = await uploadVariantsToCloudinary({ blobs: state.processed.blobs, signal, onProgress });
      } catch (error) {
        throw fail(UPLOAD_STAGE.UPLOADING, error);
      }
    }

    // ----- Confirm (DONE chỉ có sau bước này) -----
    if (signal?.aborted) throw cancelled(UPLOAD_STAGE.CONFIRMING);
    emit(UPLOAD_STAGE.CONFIRMING, state.imageId);
    let confirm;
    try {
      confirm = await confirmCloudinaryUpload({
        imageId: state.imageId,
        file: state.file,
        processed: state.processed,
        assets: state.assets,
        signal,
      });
    } catch (error) {
      throw fail(UPLOAD_STAGE.CONFIRMING, error);
    }

    return Object.freeze({
      imageId: state.imageId,
      status: 'DONE',
      confirm,
      assets: state.assets,
      processed: state.processed,
      file: state.file,
    });
  };
}
