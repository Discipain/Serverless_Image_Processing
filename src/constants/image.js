// Hằng số theo CONTRACT.md / SCHEMA.md (bản client-side trên nhánh dev).

// Vòng đời status: PENDING -> DONE | FAILED (không còn PROCESSING phía server).
export const IMAGE_STATUS = {
  PENDING: 'PENDING',
  DONE: 'DONE',
  FAILED: 'FAILED',
};

// Định dạng được phép upload (CONTRACT.md mục 3).
export const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
export const ALLOWED_EXTENSIONS_LABEL = 'JPG, PNG, WebP';

// Giới hạn dung lượng 10MB (CONTRACT.md mục 3).
export const MAX_SIZE_BYTES = 10 * 1024 * 1024;

// Số ảnh tối đa mỗi lần tải danh sách (SCHEMA.md mục 3: limit <= 20).
export const PAGE_SIZE = 20;
