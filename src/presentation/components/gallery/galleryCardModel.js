// PRESENTATION — chuyển 2 loại dữ liệu ảnh về MỘT model hiển thị cho ImageCard. JavaScript thuần (test được trong Node).
//
//  - Model MOCK cũ (kho `mockImages`, có `originalPath`): giữ đúng cách hiển thị trước INT-3B (nhãn MOCK, màu giả).
//  - GalleryImage từ Backend (infrastructure/api/galleryMapper.js): hiển thị dữ liệu THẬT, không nhãn MOCK, trừ khi chính
//    adapter MOCK tạo ra (`isMock === true`).
//
// KHÔNG tự suy diễn dữ liệu thiếu: không có kích thước => không có dòng kích thước; không có savedPercent từ Backend =>
// không có "Tiết kiệm" (không tự tính từ processedSize ở nhánh dữ liệu thật); thời gian không hợp lệ => không có dòng thời gian.

import { IMAGE_STATUS } from '../../../domain/constants/imageStatus';
import { fileNameFromPath, formatPercent, formatSavedPercent } from '../../utils/format';

const isValidDate = (value) => value instanceof Date && !Number.isNaN(value.getTime());

/** Chỉ cho phép URL https đã được mapper xác thực; đường dẫn tương đối như "/images/preview/..." KHÔNG BAO GIỜ vào <img>. */
export function safePreviewUrl(value) {
  return typeof value === 'string' && value.startsWith('https://') ? value : null;
}

/** Có nên hiện <img> không: có URL và URL đó chưa từng báo lỗi tải. (Đổi URL thì thử lại.) */
export function shouldShowPreview(previewUrl, failedUrl) {
  return previewUrl !== null && previewUrl !== failedUrl;
}

/**
 * @returns {{
 *   imageId: string, name: string, status: string, isMock: boolean, provider: string|null, previewUrl: string|null,
 *   originalSize: number|null, showOriginalSize: boolean, savedText: string|null,
 *   createdAt: Date|null, showCreatedAt: boolean, createdAtEstimated: boolean, errorReason: string|null
 * }}
 */
export function toCardModel(image) {
  if (image && typeof image.originalPath === 'string') {
    // Model MOCK cũ: giữ nguyên hành vi hiển thị.
    const done = image.status === IMAGE_STATUS.DONE;
    return {
      imageId: image.imageId,
      name: fileNameFromPath(image.originalPath),
      status: image.status,
      isMock: true,
      provider: null,
      previewUrl: null,
      originalSize: image.originalSize,
      showOriginalSize: true,
      savedText: done ? formatSavedPercent(image.originalSize, image.processedSize) : null,
      createdAt: image.createdAt,
      showCreatedAt: true,
      createdAtEstimated: false,
      errorReason: image.errorReason ?? null,
    };
  }

  // GalleryImage (Backend hoặc MOCK Backend).
  const hasSize = typeof image.originalSize === 'number' && Number.isFinite(image.originalSize);
  return {
    imageId: image.imageId,
    name: image.name || image.imageId,
    status: image.status,
    isMock: image.isMock === true,
    provider: image.provider ?? null,
    previewUrl: safePreviewUrl(image.previewUrl),
    originalSize: hasSize ? image.originalSize : null,
    showOriginalSize: hasSize,
    // Chỉ khi Backend TỰ gửi savedPercent (không tính lại từ kích thước).
    savedText: image.status === IMAGE_STATUS.DONE ? formatPercent(image.savedPercent) : null,
    createdAt: isValidDate(image.createdAt) ? image.createdAt : null,
    showCreatedAt: isValidDate(image.createdAt),
    createdAtEstimated: image.createdAtEstimated === true,
    errorReason: image.errorReason ?? null,
  };
}
