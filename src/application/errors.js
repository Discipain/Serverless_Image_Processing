// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.

// Mã lỗi mà use case ném ra (Presentation dựa vào `error.code` để chọn thông báo/hành vi).
export const ERROR_CODE = Object.freeze({
  // Bị chặn TRƯỚC khi tạo document: file không hợp lệ. KHÔNG có bản ghi FAILED nào được tạo.
  VALIDATION: 'VALIDATION',
  UNAUTHENTICATED: 'UNAUTHENTICATED',
  FORBIDDEN: 'FORBIDDEN',
  NOT_FOUND: 'NOT_FOUND',
  // Thao tác không hợp lệ với trạng thái hiện tại (vd: xóa ảnh đang PROCESSING, retry ảnh không FAILED).
  INVALID_STATE: 'INVALID_STATE',
  // Retry nhưng không còn file nguồn (không có file trong RAM, ảnh gốc cũng không còn trên Storage).
  FILE_UNAVAILABLE: 'FILE_UNAVAILABLE',
  // Lỗi SAU khi đã tạo document (nén/upload/ghi metadata). `details.imageId` cho biết bản ghi nào.
  UPLOAD_FAILED: 'UPLOAD_FAILED',
  DELETE_FAILED: 'DELETE_FAILED',
  // Mã mà ADAPTER dùng khi báo lỗi lên Application (xem ports.js). Không phải mã để Presentation xử lý.
  STATUS_CONFLICT: 'STATUS_CONFLICT',
  // ---- Mã lỗi do ADAPTER Firebase báo lên (E4a), qua infrastructure/firebase/mapFirebaseError.js.
  // Mỗi lỗi adapter còn mang `originalCode` (mã gốc của SDK, vd 'storage/unauthorized') và `cause` để chẩn đoán.
  // PERMISSION_DENIED KHÔNG BAO GIỜ được đổi thành NOT_FOUND: hai trường hợp này khác nhau.
  PERMISSION_DENIED: 'PERMISSION_DENIED', // Rules/quyền từ chối (kể cả đọc document không tồn tại nếu Rules chặn)
  NETWORK: 'NETWORK', // mất mạng, hết thời gian chờ, dịch vụ tạm thời không truy cập được
  CANCELLED: 'CANCELLED', // người dùng hủy (vd đóng popup đăng nhập) — không phải lỗi đăng nhập thật
  POPUP_BLOCKED: 'POPUP_BLOCKED', // trình duyệt chặn cửa sổ popup đăng nhập
  QUOTA_EXCEEDED: 'QUOTA_EXCEEDED', // vượt hạn mức dịch vụ (kể cả Storage chưa bật gói phù hợp)
  CONFIG: 'CONFIG', // cấu hình/dịch vụ chưa đúng: provider chưa bật, domain chưa được phép, thiếu index, thiếu bucket...
  UNKNOWN: 'UNKNOWN', // mã lỗi không nhận diện được (xem originalCode/cause)
});

/**
 * Lỗi nghiệp vụ của Application.
 *   code    : một giá trị của ERROR_CODE
 *   message : thông báo tiếng Việt, hiển thị được cho người dùng
 *   details : { imageId?, errorReason?, cause?, cleanup?, markFailedError?, stateUnknown?, ... }
 */
export class AppError extends Error {
  constructor(code, message, details = {}) {
    super(message, details.cause ? { cause: details.cause } : undefined);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
    this.imageId = details.imageId;
    this.errorReason = details.errorReason;
  }
}
