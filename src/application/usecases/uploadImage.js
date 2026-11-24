// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.

import { validateImageFile } from '../../domain/validators/validateImageFile';
import { buildStoragePaths, createPendingImage } from '../../domain/models/image';
import { AppError, ERROR_CODE } from '../errors';

/**
 * Tải lên MỘT ảnh: validate -> tạo document PENDING -> nén -> PROCESSING -> upload -> DONE | FAILED.
 *
 * Hai loại lỗi được phân biệt rõ:
 *  - VALIDATION (file không hợp lệ): ném lỗi NGAY, TRƯỚC khi tạo document. Không có bản ghi, không có file.
 *  - UPLOAD_FAILED: lỗi sau khi đã có document; document được đánh dấu FAILED (nếu ghi được),
 *    `error.imageId` cho biết bản ghi nào. Dùng retryImage để thử lại.
 *
 * Hàng đợi nhiều ảnh do Presentation điều phối (gọi use case này lần lượt, concurrency nhỏ).
 */
export function createUploadImage({ imageRepository, generateId, pipeline }) {
  return async function uploadImage({ uid, file, onProgress }) {
    if (!uid) {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Cần đăng nhập để tải ảnh lên.');
    }

    const check = validateImageFile(file);
    if (!check.valid) {
      throw new AppError(ERROR_CODE.VALIDATION, check.message, { errorReason: check.errorReason });
    }

    const imageId = generateId();
    let paths;
    try {
      paths = buildStoragePaths(uid, imageId, file.name);
    } catch (cause) {
      throw new AppError(ERROR_CODE.VALIDATION, 'Tên file ảnh không hợp lệ.', { cause });
    }

    try {
      await imageRepository.create(
        createPendingImage({
          imageId,
          ownerId: uid,
          originalPath: paths.original,
          originalSize: file.size,
        }),
      );
    } catch (cause) {
      throw new AppError(
        ERROR_CODE.UPLOAD_FAILED,
        `Không tạo được bản ghi ảnh (${cause?.message || 'lỗi không rõ'}). Chưa có file nào được tải lên.`,
        { imageId, cause },
      );
    }

    return pipeline.run({ imageId, source: file, paths, onProgress });
  };
}
