// DOMAIN — JavaScript thuần: không import React, Firebase hay lớp khác.

import { ERROR_REASON } from '../constants/imageStatus';
import { ALLOWED_EXTENSIONS_LABEL, ALLOWED_TYPES, MAX_SIZE_BYTES } from '../constants/imageRules';

const BYTES_PER_MB = 1024 * 1024;

/**
 * Kiểm tra METADATA của file trước khi làm bất cứ việc gì khác.
 * Nhận object có `type` và `size` (đối tượng File của trình duyệt dùng được luôn).
 *
 * Trả về:
 *   { valid: true }
 *   { valid: false, errorReason, message }   // errorReason thuộc ERROR_REASON
 *
 * QUY TẮC: file bị từ chối ở đây phải bị chặn NGAY, TRƯỚC khi tạo document Firestore.
 * Không tạo bản ghi FAILED cho file đã bị từ chối ở bước validate — chỉ báo lỗi cho người dùng.
 *
 * Giới hạn: `type` do trình duyệt suy ra từ đuôi file, nên file giả (đổi đuôi .txt -> .jpg)
 * vẫn qua được bước này; việc giải mã ảnh để phát hiện thuộc về lớp Infrastructure.
 */
export function validateImageFile(file) {
  if (!file || typeof file !== 'object') {
    return invalid(ERROR_REASON.INVALID_IMAGE, 'Không có file ảnh để kiểm tra.');
  }

  if (!ALLOWED_TYPES.includes(file.type)) {
    return invalid(
      ERROR_REASON.INVALID_IMAGE,
      `Định dạng không được hỗ trợ (chỉ nhận ${ALLOWED_EXTENSIONS_LABEL}).`,
    );
  }

  if (typeof file.size !== 'number' || Number.isNaN(file.size) || file.size <= 0) {
    return invalid(ERROR_REASON.INVALID_IMAGE, 'File ảnh rỗng hoặc không đọc được dung lượng.');
  }

  if (file.size > MAX_SIZE_BYTES) {
    return invalid(
      ERROR_REASON.TOO_LARGE,
      `Dung lượng ảnh vượt quá giới hạn ${MAX_SIZE_BYTES / BYTES_PER_MB}MB.`,
    );
  }

  return { valid: true };
}

function invalid(errorReason, message) {
  return { valid: false, errorReason, message };
}
