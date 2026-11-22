// DOMAIN — JavaScript thuần: không import React, Firebase hay lớp khác.
//
// Dựng và kiểm tra payload của POST /images/cloudinary/confirm theo CONTRACT Hybrid mục 3.1 (origin/dev commit 72ee441)
// CỘNG quyết định đã được nhóm trưởng Tới xác nhận bằng tin nhắn: "Tùy chọn 6 → tùy chọn 7, rồi thêm 1 field processedSize".
// (Văn bản CONTRACT.md trên origin/dev CHƯA cập nhật phần này tại thời điểm viết; xem đề xuất sửa tài liệu trong báo cáo H3A.2.)
//   - 6 field BẮT BUỘC : imageId, thumbnail, medium, webp, originalSize, processingMs (thiếu 1 trong 6 -> Backend trả 400).
//   - 7 field TÙY CHỌN : fileName, width, height, thumbnailId, mediumId, webpId, processedSize (thiếu thì Backend tự điền
//     mặc định). Chỉ gửi field tùy chọn KHI có giá trị hợp lệ; có mà sai kiểu thì báo lỗi (không âm thầm bỏ).
//   - processedSize = tổng kích thước (byte) của 3 Blob WebP THẬT do bộ xử lý ảnh tạo ra
//     (thumbnail.size + medium.size + webp.size). Khuyến nghị Frontend LUÔN gửi khi đã có đủ 3 Blob. Không suy từ độ dài URL,
//     không ước đoán. Backend dùng originalSize và processedSize để tính savedPercent.
//   - KHÔNG gửi contentType (không còn trong confirm). file.type vẫn ở file gốc để dùng cục bộ.
//   - thumbnailId/mediumId/webpId lấy từ public_id Cloudinary trả về ở bước upload (assets.<variant>.publicId của H2),
//     gửi dạng PHẲNG. KHÔNG tự tạo publicId.
//   - imageId do Frontend tạo bằng crypto.randomUUID() MỘT LẦN trước khi nén (hàm generateId có sẵn ở Infrastructure)
//     và giữ nguyên khi thử lại confirm. Hàm này chỉ NHẬN imageId từ nơi gọi, không tự sinh.
// Toàn bộ ánh xạ nằm trong MỘT hàm (buildConfirmPayload) để chỉnh một chỗ khi nhóm đổi quy tắc.

import { IMAGE_VARIANTS, MAX_SIZE_BYTES } from '../constants/imageRules';
import { sumProcessedSize } from './image';

export const CONFIRM_REQUIRED_FIELDS = Object.freeze([
  'imageId',
  'thumbnail',
  'medium',
  'webp',
  'originalSize',
  'processingMs',
]);

export const CONFIRM_OPTIONAL_FIELDS = Object.freeze([
  'fileName',
  'width',
  'height',
  'thumbnailId',
  'mediumId',
  'webpId',
  'processedSize',
]);

/** Toàn bộ 13 field hợp lệ của request (6 bắt buộc + 7 tùy chọn). */
export const CONFIRM_PAYLOAD_FIELDS = Object.freeze([...CONFIRM_REQUIRED_FIELDS, ...CONFIRM_OPTIONAL_FIELDS]);

const VARIANT_KEYS = Object.keys(IMAGE_VARIANTS); // thumbnail, medium, webp

/** Lỗi dữ liệu xác nhận; `problems` là danh sách thông báo tiếng Việt. */
export class ConfirmPayloadError extends Error {
  constructor(problems) {
    super(`Dữ liệu xác nhận không hợp lệ: ${problems.join('; ')}`);
    this.name = 'ConfirmPayloadError';
    this.problems = problems;
  }
}

const isPositiveInt = (n) => Number.isInteger(n) && n > 0;
const isNonEmptyString = (s) => typeof s === 'string' && s.trim() !== '';
// "Thiếu" = không có giá trị: undefined, null hoặc chuỗi rỗng/khoảng trắng.
const isAbsent = (v) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/**
 * @param {Object} input
 * @param {string} input.imageId        do nơi gọi cung cấp (Frontend tạo bằng crypto.randomUUID() trước khi nén)
 * @param {number} input.originalSize   dung lượng file gốc (byte)
 * @param {number} input.processingMs   thời gian nén ở trình duyệt (ms)
 * @param {{thumbnail: {secureUrl: string, publicId?: string}, medium: {...}, webp: {...}}} input.assets
 *        kết quả upload Cloudinary (H2): secureUrl bắt buộc; publicId tùy chọn -> thumbnailId/mediumId/webpId
 * @param {string} [input.fileName]     tên file gốc (tùy chọn)
 * @param {number} [input.width]        rộng ảnh gốc, đã xoay theo EXIF (tùy chọn)
 * @param {number} [input.height]       cao ảnh gốc (tùy chọn)
 * @param {{thumbnail: number, medium: number, webp: number}} [input.variantSizes]
 *        kích thước (byte) của 3 Blob THẬT; từ đó tính processedSize = tổng. Thiếu hẳn (cả ba undefined/null) thì
 *        bỏ processedSize (CONTRACT cho phép); có mà thiếu/sai một biến thể thì báo lỗi.
 * @returns {Record<string, string|number>} 6 field bắt buộc + các field tùy chọn đang có giá trị hợp lệ (tối đa 13)
 * @throws {ConfirmPayloadError}
 */
export function buildConfirmPayload(input = {}) {
  const { imageId, fileName, originalSize, width, height, processingMs, variantSizes, assets } = input;
  const problems = [];

  // ----- 6 field bắt buộc -----
  if (!isNonEmptyString(imageId)) problems.push('thiếu imageId');
  if (!isPositiveInt(originalSize)) problems.push('originalSize phải là số nguyên dương');
  else if (originalSize > MAX_SIZE_BYTES) problems.push('originalSize vượt 10MB');
  if (!Number.isFinite(processingMs) || processingMs < 0) problems.push('processingMs không hợp lệ');

  const urls = {};
  for (const key of VARIANT_KEYS) {
    const url = assets?.[key]?.secureUrl;
    if (typeof url !== 'string' || !url.startsWith('https://')) problems.push(`thiếu secureUrl https của biến thể "${key}"`);
    else urls[key] = url;
  }

  // ----- 7 field tùy chọn: bỏ qua khi thiếu, báo lỗi khi có mà sai kiểu -----
  const optional = {};
  if (!isAbsent(fileName)) {
    if (typeof fileName !== 'string') problems.push('fileName phải là chuỗi');
    else optional.fileName = fileName;
  }
  for (const [name, value] of [['width', width], ['height', height]]) {
    if (isAbsent(value)) continue;
    if (!isPositiveInt(value)) problems.push(`${name} phải là số nguyên dương`);
    else optional[name] = value;
  }
  for (const key of VARIANT_KEYS) {
    const publicId = assets?.[key]?.publicId; // public_id do Cloudinary trả về (H2), tuyệt đối không tự tạo
    if (isAbsent(publicId)) continue;
    if (typeof publicId !== 'string') problems.push(`publicId của "${key}" phải là chuỗi`);
    else optional[`${key}Id`] = publicId;
  }

  // processedSize = tổng kích thước 3 Blob thật. Thiếu hẳn thì bỏ qua; có thì phải là số nguyên không âm, hữu hạn.
  const sizesAbsent = VARIANT_KEYS.every((key) => isAbsent(variantSizes?.[key]));
  if (!sizesAbsent) {
    const total = sumProcessedSize(variantSizes); // null nếu thiếu/sai kiểu/âm/không hữu hạn ở bất kỳ biến thể nào
    if (total === null || !Number.isInteger(total) || total < 0) {
      problems.push('processedSize không hợp lệ: cần kích thước (byte) là số nguyên không âm của đủ 3 Blob');
    } else {
      optional.processedSize = total;
    }
  }

  if (problems.length > 0) throw new ConfirmPayloadError(problems);

  return {
    imageId,
    thumbnail: urls.thumbnail,
    medium: urls.medium,
    webp: urls.webp,
    originalSize,
    processingMs: Math.round(processingMs),
    ...optional,
  };
}
