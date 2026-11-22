// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.

import { IMAGE_STATUS } from '../../domain/constants/imageStatus';
import { buildStoragePaths, fileNameFromPath } from '../../domain/models/image';
import { AppError, ERROR_CODE } from '../errors';

// Chỉ xóa khi ảnh không còn tác vụ nào đang chạy (tránh tranh chấp với upload/retry).
const DELETABLE_STATUSES = [IMAGE_STATUS.DONE, IMAGE_STATUS.FAILED];

/**
 * Xóa ảnh: 4 file Storage trước, document Firestore sau (CONTRACT.md).
 *  - Chỉ cho ảnh DONE hoặc FAILED; PENDING/PROCESSING bị từ chối (INVALID_STATE).
 *  - Đường dẫn dựng từ uid + imageId của chính ảnh (không tin đường dẫn khác trong document),
 *    nên không thể xóa nhầm file của người dùng khác.
 *  - Object không tồn tại (vd ảnh FAILED chưa từng upload đủ) được adapter coi là đã xóa.
 *  - Nếu xóa file lỗi thì GIỮ document để người dùng thử xóa lại, tránh file mồ côi không còn bản ghi.
 */
export function createDeleteImage({ imageRepository, storageRepository }) {
  return async function deleteImage({ uid, imageId }) {
    if (!uid) {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Cần đăng nhập để xóa ảnh.');
    }
    if (!imageId) {
      throw new AppError(ERROR_CODE.NOT_FOUND, 'Thiếu mã ảnh.');
    }

    const image = await imageRepository.get(imageId);
    if (!image) {
      throw new AppError(ERROR_CODE.NOT_FOUND, 'Không tìm thấy ảnh.', { imageId });
    }
    if (image.ownerId !== uid) {
      throw new AppError(ERROR_CODE.FORBIDDEN, 'Bạn không có quyền xóa ảnh này.', { imageId });
    }
    if (!DELETABLE_STATUSES.includes(image.status)) {
      throw new AppError(
        ERROR_CODE.INVALID_STATE,
        `Không thể xóa ảnh đang ở trạng thái ${image.status}. Chỉ xóa được ảnh DONE hoặc FAILED.`,
        { imageId },
      );
    }

    let paths;
    try {
      paths = buildStoragePaths(uid, imageId, fileNameFromPath(image.originalPath));
    } catch (cause) {
      throw new AppError(ERROR_CODE.INVALID_STATE, 'Bản ghi ảnh thiếu tên file gốc.', {
        imageId,
        cause,
      });
    }

    const targets = Object.values(paths);
    const results = await Promise.allSettled(targets.map((path) => storageRepository.remove(path)));
    const failedPaths = [];
    let firstCause = null;
    results.forEach((result, index) => {
      if (result.status === 'rejected') {
        failedPaths.push(targets[index]);
        firstCause ??= result.reason;
      }
    });
    if (failedPaths.length > 0) {
      throw new AppError(
        ERROR_CODE.DELETE_FAILED,
        `Không xóa được ${failedPaths.length}/${targets.length} file trên Storage; giữ nguyên bản ghi để thử lại.`,
        { imageId, failedPaths, cause: firstCause },
      );
    }

    try {
      await imageRepository.remove(imageId);
    } catch (cause) {
      throw new AppError(
        ERROR_CODE.DELETE_FAILED,
        'Đã xóa file nhưng chưa xóa được bản ghi; hãy thử xóa lại.',
        { imageId, cause },
      );
    }

    return { imageId };
  };
}
