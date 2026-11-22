// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Pipeline dùng chung cho uploadImage (ảnh mới) và retryImage (ảnh FAILED):
// document đã tồn tại ở trạng thái PENDING -> nén -> PROCESSING -> upload -> DONE | FAILED.
//
// Nguyên tắc:
//  - DONE chỉ được ghi SAU KHI mọi file đã upload xong VÀ metadata ghi thành công.
//  - Mọi lần đổi trạng thái đi qua canTransition (Domain) + imageRepository.transition (compare-and-set).
//  - Khi upload lỗi: xóa các BIẾN THỂ (thumb/medium/full), GIỮ ảnh gốc để retry; ảnh gốc không bao giờ bị
//    xóa ở đây. Đường dẫn luôn dựng từ ownerId của chính ảnh nên không thể xóa nhầm dữ liệu người dùng khác.
//  - Retry dùng lại cùng imageId => cùng đường dẫn => upload chỉ ghi đè, không tạo object hay document trùng.

import { ERROR_REASON, IMAGE_STATUS } from '../domain/constants/imageStatus';
import { IMAGE_VARIANTS } from '../domain/constants/imageRules';
import { buildDoneUpdate, buildFailedUpdate, canTransition } from '../domain/models/image';
import { AppError, ERROR_CODE } from './errors';

const VARIANT_KEYS = Object.keys(IMAGE_VARIANTS);

function normalizeErrorReason(reason, fallback) {
  return Object.values(ERROR_REASON).includes(reason) ? reason : fallback;
}

// Kiểm tra kết quả của imageProcessor trước khi tin dùng.
function readProcessed(result) {
  const { blobs, width, height, processingMs } = result ?? {};
  const invalid = (message) =>
    Object.assign(new Error(message), { errorReason: ERROR_REASON.COMPRESS_FAIL });

  for (const key of VARIANT_KEYS) {
    const blob = blobs?.[key];
    if (!blob || typeof blob.size !== 'number' || !(blob.size > 0)) {
      throw invalid(`Kết quả nén thiếu hoặc rỗng ở biến thể "${key}".`);
    }
  }
  if (![width, height].every((n) => Number.isFinite(n) && n > 0)) {
    throw invalid('Kết quả nén thiếu kích thước ảnh gốc.');
  }
  return {
    blobs,
    width,
    height,
    processingMs: Number.isFinite(processingMs) && processingMs >= 0 ? Math.round(processingMs) : 0,
  };
}

function describeCleanupFailure(cleanup) {
  if (!cleanup?.failed?.length) return '';
  return ` Dọn dẹp thất bại ${cleanup.failed.length} file: ${cleanup.failed.map((f) => f.path).join(', ')}.`;
}

export function createUploadPipeline({ imageRepository, storageRepository, imageProcessor }) {
  async function moveStatus(imageId, from, to, patch) {
    if (!canTransition(from, to)) {
      throw new AppError(ERROR_CODE.INVALID_STATE, `Không thể chuyển trạng thái ${from} → ${to}.`, {
        imageId,
      });
    }
    await imageRepository.transition(imageId, { from, to, patch });
  }

  // Ghi FAILED rồi LUÔN ném AppError (kể cả khi chính việc ghi FAILED cũng lỗi).
  async function failImage(imageId, from, errorReason, cause, extra = {}) {
    let markFailedError = null;
    try {
      await moveStatus(imageId, from, IMAGE_STATUS.FAILED, buildFailedUpdate(errorReason));
    } catch (error) {
      markFailedError = error;
    }

    let message = `Xử lý ảnh thất bại (${errorReason}): ${cause?.message || 'lỗi không rõ'}.`;
    message += describeCleanupFailure(extra.cleanup);
    if (markFailedError) {
      message += ` Không ghi được trạng thái FAILED (${markFailedError.message}); bản ghi có thể còn ở ${from}.`;
    }
    throw new AppError(ERROR_CODE.UPLOAD_FAILED, message, {
      imageId,
      errorReason,
      cause,
      markFailedError,
      ...extra,
    });
  }

  // Xóa 3 biến thể (best-effort, không bao giờ xóa ảnh gốc). Object không tồn tại được adapter coi là thành công.
  async function cleanupVariants(paths) {
    const targets = VARIANT_KEYS.map((key) => paths[key]);
    const results = await Promise.allSettled(targets.map((path) => storageRepository.remove(path)));
    const failed = [];
    results.forEach((result, index) => {
      if (result.status === 'rejected') failed.push({ path: targets[index], error: result.reason });
    });
    return { attempted: targets, failed };
  }

  async function readStatus(imageId) {
    try {
      const image = await imageRepository.get(imageId);
      return { known: true, status: image?.status };
    } catch {
      return { known: false };
    }
  }

  /**
   * @param {Object} args
   * @param {string} args.imageId
   * @param {string} args.ownerId
   * @param {Blob} args.source               file nguồn (File mới chọn, hoặc Blob tải từ Storage khi retry)
   * @param {{original: string, thumbnail: string, medium: string, webp: string}} args.paths  từ buildStoragePaths
   * @param {boolean} [args.skipOriginalUpload]  true khi ảnh gốc đã nằm sẵn trên Storage (retry tải từ Storage)
   * @param {(p: {stage: 'COMPRESSING'|'UPLOADING'|'FINALIZING', percent: number}) => void} [args.onProgress]
   */
  async function run({ imageId, source, paths, skipOriginalUpload = false, onProgress }) {
    const report = (stage, percent) => {
      if (typeof onProgress === 'function') onProgress({ stage, percent });
    };

    // 1) PENDING: nén ảnh ở trình duyệt.
    report('COMPRESSING', 0);
    let processed;
    try {
      processed = readProcessed(await imageProcessor.process(source));
    } catch (error) {
      return failImage(
        imageId,
        IMAGE_STATUS.PENDING,
        normalizeErrorReason(error?.errorReason, ERROR_REASON.COMPRESS_FAIL),
        error,
      );
    }

    // 2) PENDING -> PROCESSING: bắt đầu upload.
    try {
      await moveStatus(imageId, IMAGE_STATUS.PENDING, IMAGE_STATUS.PROCESSING, {});
    } catch (error) {
      if (error?.code === ERROR_CODE.STATUS_CONFLICT) {
        throw new AppError(
          ERROR_CODE.INVALID_STATE,
          'Trạng thái ảnh đã bị thay đổi ở nơi khác, đã dừng xử lý.',
          { imageId, cause: error },
        );
      }
      return failImage(imageId, IMAGE_STATUS.PENDING, ERROR_REASON.UPLOAD_FAIL, error);
    }

    // 3) PROCESSING: upload. Ảnh gốc trước, rồi 3 biến thể song song.
    report('UPLOADING', 0);
    const originalItem = { path: paths.original, blob: source, contentType: source.type };
    const variantItems = VARIANT_KEYS.map((key) => ({
      path: paths[key],
      blob: processed.blobs[key],
      contentType: 'image/webp',
    }));
    const allItems = skipOriginalUpload ? variantItems : [originalItem, ...variantItems];
    const totalBytes = allItems.reduce((sum, item) => sum + item.blob.size, 0);
    const transferred = new Map();
    const uploadOne = (item) =>
      storageRepository.upload({
        path: item.path,
        blob: item.blob,
        contentType: item.contentType,
        onProgress: (bytes) => {
          transferred.set(item.path, bytes);
          let sum = 0;
          for (const value of transferred.values()) sum += value;
          report('UPLOADING', Math.min(99, Math.floor((sum / totalBytes) * 100)));
        },
      });

    let uploadError = null;
    let variantsAttempted = false;
    if (!skipOriginalUpload) {
      try {
        await uploadOne(originalItem);
      } catch (error) {
        uploadError = error;
      }
    }
    if (!uploadError) {
      variantsAttempted = true;
      // allSettled: chờ TẤT CẢ upload kết thúc trước khi dọn, để không còn upload dở chạy sau cleanup.
      const results = await Promise.allSettled(variantItems.map(uploadOne));
      const rejected = results.find((result) => result.status === 'rejected');
      if (rejected) uploadError = rejected.reason;
    }
    if (uploadError) {
      const cleanup = variantsAttempted
        ? await cleanupVariants(paths)
        : { attempted: [], failed: [] };
      return failImage(imageId, IMAGE_STATUS.PROCESSING, ERROR_REASON.UPLOAD_FAIL, uploadError, {
        cleanup,
      });
    }

    // 4) PROCESSING -> DONE: ghi metadata. Chỉ tới đây mới được coi là hoàn tất.
    report('FINALIZING', 99);
    const patch = buildDoneUpdate({
      paths,
      sizes: {
        thumbnail: processed.blobs.thumbnail.size,
        medium: processed.blobs.medium.size,
        webp: processed.blobs.webp.size,
      },
      width: processed.width,
      height: processed.height,
      processingMs: processed.processingMs,
    });
    try {
      await moveStatus(imageId, IMAGE_STATUS.PROCESSING, IMAGE_STATUS.DONE, patch);
    } catch (error) {
      // Yêu cầu có thể đã thành công phía server dù phản hồi bị mất: đọc lại trước khi dọn,
      // tránh xóa biến thể của một ảnh đã DONE.
      const state = await readStatus(imageId);
      if (state.known && state.status === IMAGE_STATUS.DONE) {
        report('FINALIZING', 100);
        return { imageId, status: IMAGE_STATUS.DONE, processedSize: patch.processedSize };
      }
      if (!state.known) {
        throw new AppError(
          ERROR_CODE.UPLOAD_FAILED,
          'Không xác định được ảnh đã ghi DONE hay chưa (mất kết nối). Giữ nguyên file đã upload; ' +
            'bản ghi có thể còn ở PROCESSING.',
          { imageId, errorReason: ERROR_REASON.UPLOAD_FAIL, cause: error, stateUnknown: true },
        );
      }
      const cleanup = await cleanupVariants(paths);
      return failImage(imageId, IMAGE_STATUS.PROCESSING, ERROR_REASON.UPLOAD_FAIL, error, {
        cleanup,
      });
    }

    report('FINALIZING', 100);
    return { imageId, status: IMAGE_STATUS.DONE, processedSize: patch.processedSize };
  }

  return { run };
}
