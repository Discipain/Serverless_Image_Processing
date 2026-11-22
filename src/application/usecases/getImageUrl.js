// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.

import { IMAGE_STATUS } from '../../domain/constants/imageStatus';
import { IMAGE_VARIANTS } from '../../domain/constants/imageRules';
import { buildStoragePaths, fileNameFromPath } from '../../domain/models/image';
import { AppError, ERROR_CODE } from '../errors';

const ORIGINAL = 'original';

/**
 * Lấy URL của một phiên bản ảnh để HIỂN THỊ (thumbnail/medium) hoặc TẢI VỀ (webp/original).
 *   variant: 'thumbnail' | 'medium' | 'webp' | 'original'
 * Chỉ dùng cho ảnh DONE của chính người dùng. Đường dẫn dựng từ ownerId + imageId, không lấy từ `image.variants`.
 * Trả về { url, path, fileName } — fileName là tên gợi ý khi lưu file.
 * Cách tải về (mở tab mới hay lưu blob) do Presentation quyết định.
 */
export function createGetImageUrl({ storageRepository }) {
  return async function getImageUrl({ uid, image, variant = 'thumbnail' }) {
    if (!uid) {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Cần đăng nhập để xem ảnh.');
    }
    if (variant !== ORIGINAL && !Object.hasOwn(IMAGE_VARIANTS, variant)) {
      throw new AppError(ERROR_CODE.VALIDATION, `Phiên bản ảnh không hợp lệ: ${String(variant)}.`);
    }
    if (!image?.imageId || !image?.ownerId) {
      throw new AppError(ERROR_CODE.VALIDATION, 'Thiếu thông tin ảnh.');
    }
    if (image.ownerId !== uid) {
      throw new AppError(ERROR_CODE.FORBIDDEN, 'Bạn không có quyền với ảnh này.', {
        imageId: image.imageId,
      });
    }
    if (image.status !== IMAGE_STATUS.DONE) {
      throw new AppError(
        ERROR_CODE.INVALID_STATE,
        `Ảnh chưa sẵn sàng (trạng thái ${image.status}).`,
        { imageId: image.imageId },
      );
    }

    const originalName = fileNameFromPath(image.originalPath);
    let paths;
    try {
      paths = buildStoragePaths(image.ownerId, image.imageId, originalName);
    } catch (cause) {
      throw new AppError(ERROR_CODE.INVALID_STATE, 'Bản ghi ảnh thiếu tên file gốc.', {
        imageId: image.imageId,
        cause,
      });
    }

    const path = paths[variant];
    const url = await storageRepository.getDownloadUrl(path);
    const stem = originalName.replace(/\.[^./]+$/, '');
    const fileName = variant === ORIGINAL ? originalName : `${stem}_${IMAGE_VARIANTS[variant].fileName}`;
    return { url, path, fileName };
  };
}
