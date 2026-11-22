// DOMAIN — JavaScript thuần: không import React, Firebase hay lớp khác.

// Định dạng được phép upload (CONTRACT.md mục 3).
export const ALLOWED_TYPES = Object.freeze(['image/jpeg', 'image/png', 'image/webp']);
export const ALLOWED_EXTENSIONS_LABEL = 'JPG, PNG, WebP';

// Giới hạn dung lượng 10MB (CONTRACT.md mục 3).
export const MAX_SIZE_BYTES = 10 * 1024 * 1024;

// Giới hạn tổng số điểm ảnh (rộng × cao) = 50 triệu. ĐÂY LÀ CHÍNH SÁCH CỦA ỨNG DỤNG, không phải giới hạn
// trong CONTRACT/SCHEMA: ảnh lớn hơn bị từ chối (TOO_LARGE) TRƯỚC khi tạo Canvas để tránh hết bộ nhớ trình duyệt.
// (Giới hạn kỹ thuật một cạnh của encoder WebP = 16383px nằm ở Infrastructure, không phải ở đây.)
export const MAX_PIXELS = 50_000_000;

// Số ảnh tối đa mỗi lần tải danh sách (SCHEMA.md mục 3: limit <= 20).
export const PAGE_SIZE = 20;

// 3 biến thể WebP tạo ở trình duyệt. Khóa trùng với `variants` trong SCHEMA.md.
//   fileName : tên file dưới processed/{uid}/{imageId}/ (CONTRACT.md mục 4)
//   maxSize  : cạnh dài nhất tối đa (px); null = giữ kích thước gốc
export const IMAGE_VARIANTS = Object.freeze({
  thumbnail: Object.freeze({ fileName: 'thumb.webp', maxSize: 200 }),
  medium: Object.freeze({ fileName: 'medium.webp', maxSize: 800 }),
  webp: Object.freeze({ fileName: 'full.webp', maxSize: null }),
});
