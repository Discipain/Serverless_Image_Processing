// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.

import { IMAGE_STATUS } from '../../domain/constants/imageStatus';
import { validateImageFile } from '../../domain/validators/validateImageFile';
import {
  buildRetryUpdate,
  buildStoragePaths,
  canTransition,
  fileNameFromPath,
} from '../../domain/models/image';
import { AppError, ERROR_CODE } from '../errors';

/**
 * Thử lại một ảnh FAILED: FAILED -> PENDING (retryCount + 1) rồi chạy lại pipeline.
 *
 * Chống trùng lặp:
 *  - Không tạo document mới: dùng lại cùng imageId => cùng đường dẫn Storage => upload chỉ ghi đè.
 *  - Chuyển FAILED -> PENDING là compare-and-set: bấm đúp hoặc mở hai tab thì lần thứ hai bị từ chối.
 *  - File nguồn được lấy TRƯỚC khi đổi trạng thái, nên không có file thì retryCount không bị tăng.
 *
 * Nguồn file: `file` do người dùng truyền (còn trong RAM / chọn lại); nếu không có thì tải ảnh gốc từ Storage.
 * Nếu cả hai đều không có (ảnh gốc chưa từng upload xong) -> FILE_UNAVAILABLE, người dùng cần chọn lại ảnh.
 */
export function createRetryImage({ imageRepository, storageRepository, pipeline }) {
  return async function retryImage({ uid, imageId, file, onProgress }) {
    if (!uid) {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Cần đăng nhập để thử lại.');
    }
    if (!imageId) {
      throw new AppError(ERROR_CODE.NOT_FOUND, 'Thiếu mã ảnh.');
    }

    const image = await imageRepository.get(imageId);
    if (!image) {
      throw new AppError(ERROR_CODE.NOT_FOUND, 'Không tìm thấy ảnh.', { imageId });
    }
    // Kiểm tra ở client; Firestore/Storage Rules mới là chốt chặn thật.
    if (image.ownerId !== uid) {
      throw new AppError(ERROR_CODE.FORBIDDEN, 'Bạn không có quyền với ảnh này.', { imageId });
    }
    if (image.status !== IMAGE_STATUS.FAILED || !canTransition(image.status, IMAGE_STATUS.PENDING)) {
      throw new AppError(
        ERROR_CODE.INVALID_STATE,
        `Chỉ thử lại được ảnh ở trạng thái FAILED (hiện là ${image.status}).`,
        { imageId },
      );
    }

    // Luôn dựng đường dẫn từ uid + imageId của chính ảnh, không tin các đường dẫn khác trong document.
    let paths;
    try {
      paths = buildStoragePaths(uid, imageId, fileNameFromPath(image.originalPath));
    } catch (cause) {
      throw new AppError(ERROR_CODE.INVALID_STATE, 'Bản ghi ảnh thiếu tên file gốc.', {
        imageId,
        cause,
      });
    }

    // Lấy file nguồn trước khi đổi trạng thái.
    let source;
    let skipOriginalUpload = false;
    if (file) {
      const check = validateImageFile(file);
      if (!check.valid) {
        throw new AppError(ERROR_CODE.VALIDATION, check.message, {
          imageId,
          errorReason: check.errorReason,
        });
      }
      if (typeof image.originalSize === 'number' && file.size !== image.originalSize) {
        throw new AppError(
          ERROR_CODE.VALIDATION,
          'File được chọn không khớp với ảnh gốc đã tải lên (khác dung lượng).',
          { imageId },
        );
      }
      source = file;
    } else {
      try {
        source = await storageRepository.download(paths.original);
      } catch (cause) {
        throw new AppError(
          ERROR_CODE.FILE_UNAVAILABLE,
          'Không còn ảnh gốc trên hệ thống. Hãy chọn lại ảnh gốc để thử lại.',
          { imageId, cause },
        );
      }
      const check = validateImageFile(source);
      if (!check.valid) {
        throw new AppError(ERROR_CODE.FILE_UNAVAILABLE, `Ảnh gốc trên hệ thống không dùng được: ${check.message}`, {
          imageId,
          errorReason: check.errorReason,
        });
      }
      skipOriginalUpload = true; // ảnh gốc đã nằm sẵn trên Storage
    }

    try {
      await imageRepository.transition(imageId, {
        from: IMAGE_STATUS.FAILED,
        to: IMAGE_STATUS.PENDING,
        patch: buildRetryUpdate(image.retryCount),
      });
    } catch (cause) {
      if (cause?.code === ERROR_CODE.STATUS_CONFLICT) {
        throw new AppError(
          ERROR_CODE.INVALID_STATE,
          'Ảnh này đang được thử lại hoặc đã đổi trạng thái ở nơi khác.',
          { imageId, cause },
        );
      }
      if (cause?.code === ERROR_CODE.NOT_FOUND) {
        throw new AppError(ERROR_CODE.NOT_FOUND, 'Không tìm thấy ảnh.', { imageId, cause });
      }
      throw new AppError(
        ERROR_CODE.UPLOAD_FAILED,
        `Không bắt đầu được lần thử lại (${cause?.message || 'lỗi không rõ'}).`,
        { imageId, cause },
      );
    }

    return pipeline.run({ imageId, source, paths, skipOriginalUpload, onProgress });
  };
}
