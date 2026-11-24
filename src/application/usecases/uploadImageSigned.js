// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Luồng upload Hybrid CÓ CHỮ KÝ cho MỘT ảnh (H4B-4), thay thế đường unsigned của uploadImageHybrid KHI ĐƯỢC NỐI Ở H4B-5:
//   Validate -> imageId (MỘT lần) -> Nén 3 WebP -> Authorize -> Upload có chữ ký 3 biến thể -> Confirm -> DONE.
// Mọi phụ thuộc truyền vào (Dependency Injection). File này KHÔNG được nối vào composition root đang chạy (UploadPage vẫn MOCK).
//
//  - KHÔNG BAO GIỜ fallback: Backend không hỗ trợ authorize / cấu hình signed sai / Cloudinary từ chối chữ ký => báo lỗi rõ ràng.
//    Không chuyển sang unsigned preset, không chuyển sang MOCK.
//  - DONE CHỈ khi confirm trả kết quả hợp lệ (status DONE, imageId khớp). Upload xong chưa phải DONE.
//  - Thử lại = chạy tiếp từ ĐÚNG bước hỏng bằng `session` mà lỗi mang theo (error.details.session), cùng imageId, KHÔNG tạo grant mới:
//      * confirm lỗi (kể cả 503 khi Firestore có thể ĐÃ commit, mất phản hồi): CHỈ confirm lại cùng payload. Backend idempotent.
//      * upload lỗi giữa chừng: chỉ upload các biến thể CHƯA xong; biến thể đã xong (khớp public_id được cấp) giữ nguyên.
//      * Cloudinary từ chối chữ ký (401/403): xin lại chữ ký cho CÙNG imageId + metadata (một lần mỗi lần người dùng bấm thử lại).
//      * authorize lỗi: authorize lại (cùng imageId, cùng metadata).
//  - Grant hết hạn / asset không khớp / ... (newSessionRequired): KHÔNG có `session`; chỉ còn `details.restartFile` để người dùng
//    CHỦ ĐỘNG bắt đầu lại với imageId MỚI. Frontend không gia hạn grant, không tự lặp, không tự xóa asset Cloudinary.
//  - `session` chỉ nằm trong bộ nhớ. Quyền upload (chữ ký) nằm trong `session.authorization` dưới dạng thuộc tính KHÔNG liệt kê
//    (không lọt vào JSON.stringify/spread/log) và KHÔNG được ghi vào localStorage/sessionStorage.
//  - `ownerUid`: người dùng sở hữu phiên. Session của người khác bị từ chối (grant của A không dùng cho B).

import { validateImageFile } from '../../domain/validators/validateImageFile';
import { ERROR_REASON } from '../../domain/constants/imageStatus';
import { UUID_V4_PATTERN, normalizeFileName, VARIANT_KEYS } from '../../domain/models/uploadAuthorization';
import { AppError, ERROR_CODE } from '../errors';
import { SIGNED_UPLOAD_KIND, describeBackendFailure, messageForKind } from '../signedUploadErrors';
import { UPLOAD_STAGE } from './uploadImageHybrid';

export const SIGNED_UPLOAD_STAGE = Object.freeze({ ...UPLOAD_STAGE, AUTHORIZING: 'AUTHORIZING' });
const S = SIGNED_UPLOAD_STAGE;

const KNOWN_CODES = new Set(Object.values(ERROR_CODE));
const RETRYABLE_CODES = new Set([ERROR_CODE.NETWORK, ERROR_CODE.QUOTA_EXCEEDED, ERROR_CODE.CANCELLED]);

// Tóm tắt kết quả xử lý (dung lượng/kích thước THẬT của 3 biến thể) để giao diện hiển thị; không chứa Blob hay chữ ký.
function summarizeVariants(processed) {
  const out = {};
  for (const key of VARIANT_KEYS) {
    const measured = processed?.stats?.variants?.[key];
    out[key] = { bytes: processed?.blobs?.[key]?.size ?? null, width: measured?.width ?? null, height: measured?.height ?? null };
  }
  return out;
}

function makeSession(state) {
  const session = {
    imageId: state.imageId,
    file: state.file,
    fileName: state.fileName,
    ownerUid: state.ownerUid,
    processed: state.processed,
    assets: state.assets,
  };
  // Chữ ký nằm trong authorization: không liệt kê để không lọt vào JSON/log/spread của error.details.session.
  Object.defineProperty(session, 'authorization', { value: state.authorization ?? null, enumerable: false });
  return Object.freeze(session);
}

/**
 * @param {Object} deps
 * @param {import('../ports.js').ImageProcessor} deps.imageProcessor
 * @param {(args: object) => Promise<object>} deps.authorizeCloudinaryUpload
 * @param {(args: object) => Promise<object>} deps.uploadVariantsSigned
 * @param {(args: object) => Promise<object>} deps.confirmCloudinaryUpload  nên tạo với processedSizeBasis: 'webp'
 * @param {() => string} deps.generateId  UUID v4 chữ thường (Backend từ chối dạng khác)
 */
export function createUploadImageSigned({
  imageProcessor,
  authorizeCloudinaryUpload,
  uploadVariantsSigned,
  confirmCloudinaryUpload,
  generateId,
}) {
  /**
   * @param {Object} args
   * @param {File} [args.file]
   * @param {Object} [args.session]  từ error.details.session (thử lại); khi có thì bỏ qua `file`
   * @param {string} args.ownerUid   UID của người dùng đang đăng nhập (bắt buộc)
   * @param {AbortSignal} [args.signal]
   * @param {(e: {stage: string, imageId: string|null}) => void} [args.onStage]
   * @param {(p: object) => void} [args.onProgress]
   * @returns {Promise<{imageId: string, status: 'DONE', confirm: object, assets: object, processed: object, file: object, signed: true, existingVariants: string[]}>}
   * @throws {AppError} details: { stage, imageId, retryable, newSessionRequired, retryAfterSeconds, kind, session, restartFile, uploadedVariants, cause }
   */
  return async function uploadImageSigned({ file, session, ownerUid, signal, onStage, onProgress } = {}) {
    const emit = (stage, imageId, extra) => {
      try {
        onStage?.({ stage, imageId: imageId ?? null, ...(extra ?? {}) });
      } catch {
        // lỗi của callback không được làm hỏng luồng
      }
    };

    if (typeof ownerUid !== 'string' || ownerUid === '') {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Chưa đăng nhập nên không thể upload.', { stage: S.VALIDATING, retryable: false });
    }

    let state;
    if (session) {
      if (typeof session.imageId !== 'string' || !session.imageId || !session.file) {
        throw new AppError(ERROR_CODE.VALIDATION, 'Phiên upload không hợp lệ để thử lại.', { stage: S.VALIDATING, retryable: false });
      }
      if (session.ownerUid !== ownerUid) {
        // Fail closed: không bao giờ dùng grant/asset/session của người khác.
        throw new AppError(ERROR_CODE.FORBIDDEN, 'Phiên upload này thuộc về người dùng khác.', {
          stage: S.VALIDATING,
          kind: SIGNED_UPLOAD_KIND.SESSION_OWNER_MISMATCH,
          retryable: false,
        });
      }
      state = {
        imageId: session.imageId,
        file: session.file,
        fileName: session.fileName ?? null,
        ownerUid,
        processed: session.processed ?? null,
        authorization: session.authorization ?? null,
        assets: session.assets ?? null,
      };
    } else {
      emit(S.VALIDATING, null);
      const check = validateImageFile(file);
      if (!check.valid) {
        throw new AppError(ERROR_CODE.VALIDATION, check.message, { stage: S.VALIDATING, errorReason: check.errorReason, retryable: false });
      }
      const imageId = generateId();
      if (typeof imageId !== 'string' || !UUID_V4_PATTERN.test(imageId)) {
        throw new AppError(ERROR_CODE.UNKNOWN, 'Không tạo được imageId hợp lệ (cần UUID v4 chữ thường).', { stage: S.VALIDATING, retryable: false });
      }
      state = { imageId, file, fileName: normalizeFileName(file.name), ownerUid, processed: null, authorization: null, assets: null };
    }

    const allUploaded = () => VARIANT_KEYS.every((key) => state.assets?.[key]);

    const fail = (stage, error) => {
      let code = KNOWN_CODES.has(error?.code) ? error.code : ERROR_CODE.UPLOAD_FAILED;
      const reason = error?.errorReason ?? error?.details?.errorReason;
      let meta;
      if (stage === S.CONFIRMING) {
        meta = describeBackendFailure(error?.details?.cause ?? error, { stage });
        // Phân loại theo phản hồi THẬT của Backend (vd 503 "Signed upload unavailable" là lỗi cấu hình CONFIG, không phải UNKNOWN).
        if (error?.details?.cause?.details?.httpStatus !== undefined && KNOWN_CODES.has(meta.code)) code = meta.code;
      } else {
        meta = {
          kind: error?.details?.kind,
          retryable: error?.details?.retryable === true,
          newSessionRequired: error?.details?.newSessionRequired === true,
          retryAfterSeconds: Number.isInteger(error?.details?.retryAfterSeconds) ? error.details.retryAfterSeconds : null,
        };
      }
      if (stage === S.UPLOADING) {
        // Cloudinary lỗi máy chủ (5xx) ở bước upload: thử lại hợp lý (giống luồng H2).
        if (meta.kind === 'CLOUDINARY_REJECTED' && error?.details?.httpStatus >= 500) meta.retryable = true;
        // Giữ lại các biến thể đã lên Cloudinary (đã khớp public_id được cấp) để lần sau chỉ upload phần còn thiếu.
        if (error?.details?.uploaded) state.assets = { ...(state.assets ?? {}), ...error.details.uploaded };
        // Cloudinary từ chối chữ ký: lần thử lại xin chữ ký mới cho cùng imageId (nếu grant còn hạn).
        if (meta.kind === SIGNED_UPLOAD_KIND.SIGNATURE_REJECTED) {
          state.authorization = null;
          meta.retryable = true;
        }
      }
      const finalCode =
        stage === S.COMPRESSING && (reason === ERROR_REASON.INVALID_IMAGE || reason === ERROR_REASON.TOO_LARGE) ? ERROR_CODE.VALIDATION : code;
      const compressRetryable = stage === S.COMPRESSING && reason === ERROR_REASON.COMPRESS_FAIL;
      const newSessionRequired = meta.newSessionRequired === true;
      const retryable = !newSessionRequired && (meta.retryable === true || RETRYABLE_CODES.has(finalCode) || compressRetryable);
      return new AppError(finalCode, messageForKind(meta.kind, { retryAfterSeconds: meta.retryAfterSeconds }) ?? (error?.message || 'lỗi không rõ'), {
        stage,
        imageId: state.imageId,
        retryable,
        newSessionRequired,
        retryAfterSeconds: meta.retryAfterSeconds ?? null,
        errorReason: reason,
        kind: meta.kind,
        httpStatus: error?.details?.httpStatus,
        // Biến thể đã lên Cloudinary nhưng chưa được xác nhận (không bị tự xóa).
        uploadedVariants: Object.keys(state.assets ?? {}),
        // Thử lại: cùng imageId, giữ bản nén, quyền upload (nếu còn dùng được) và asset đã có. Phiên không cứu được thì KHÔNG có session.
        session: newSessionRequired ? undefined : makeSession(state),
        restartFile: newSessionRequired ? state.file : undefined,
        cause: error,
      });
    };
    const cancelled = (stage) => fail(stage, new AppError(ERROR_CODE.CANCELLED, 'Đã hủy.', { kind: 'CANCELLED' }));

    // ----- Nén -----
    if (!state.processed) {
      if (signal?.aborted) throw cancelled(S.COMPRESSING);
      emit(S.COMPRESSING, state.imageId);
      try {
        state.processed = await imageProcessor.process(state.file);
      } catch (error) {
        throw fail(S.COMPRESSING, error);
      }
    }

    // ----- Authorize (chỉ khi còn biến thể phải upload và chưa có quyền dùng được) -----
    if (!allUploaded() && !state.authorization) {
      if (signal?.aborted) throw cancelled(S.AUTHORIZING);
      emit(S.AUTHORIZING, state.imageId, { variants: summarizeVariants(state.processed) });
      try {
        state.authorization = await authorizeCloudinaryUpload({
          imageId: state.imageId,
          file: state.file,
          fileName: state.fileName,
          processed: state.processed,
          signal,
        });
      } catch (error) {
        throw fail(S.AUTHORIZING, error);
      }
    }

    // ----- Upload có chữ ký (chỉ các biến thể còn thiếu) -----
    if (!allUploaded()) {
      if (signal?.aborted) throw cancelled(S.UPLOADING);
      emit(S.UPLOADING, state.imageId, { variants: summarizeVariants(state.processed) });
      try {
        state.assets = await uploadVariantsSigned({
          blobs: state.processed.blobs,
          authorization: state.authorization,
          uploaded: state.assets ?? {},
          signal,
          onProgress,
        });
      } catch (error) {
        throw fail(S.UPLOADING, error);
      }
    }

    // ----- Confirm (DONE chỉ có sau bước này). Thử lại luôn dùng cùng imageId + cùng asset. -----
    if (signal?.aborted) throw cancelled(S.CONFIRMING);
    emit(S.CONFIRMING, state.imageId, { variants: summarizeVariants(state.processed) });
    let confirm;
    try {
      confirm = await confirmCloudinaryUpload({
        imageId: state.imageId,
        file: { size: state.file.size, name: state.fileName ?? undefined }, // đúng fileName đã khai ở authorize
        processed: state.processed,
        assets: state.assets,
        signal,
      });
    } catch (error) {
      throw fail(S.CONFIRMING, error);
    }

    return Object.freeze({
      imageId: state.imageId,
      status: 'DONE',
      confirm,
      assets: state.assets,
      processed: state.processed,
      file: state.file,
      signed: true,
      existingVariants: VARIANT_KEYS.filter((key) => state.assets[key]?.existing === true),
    });
  };
}
