// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Phân loại lỗi của luồng Signed Upload (authorize -> upload có chữ ký -> confirm) thành MỘT bộ `details.kind` ổn định
// để Presentation (H4B-5) chọn thông báo/nút bấm mà không phải đọc chuỗi của Backend.
//
// Nguyên tắc (CHỈ dựa trên mã HTTP + `detail` mà Backend 30318ee thật sự trả; chuỗi lạ => KHÔNG retry):
//   - `retryable`           : thử lại ĐÚNG bước hỏng với CÙNG session/imageId có thể thành công. Do người dùng bấm, không tự lặp.
//   - `newSessionRequired`  : phiên này không thể hoàn tất (grant hết hạn, asset không khớp...); chỉ còn cách bắt đầu lại bằng
//                             imageId MỚI khi người dùng chủ động. Không bao giờ gia hạn grant ở Frontend.
//   - `retryAfterSeconds`   : lấy từ header Retry-After của Backend (nếu có). Chỉ là gợi ý chờ, KHÔNG tự retry.
// Không phải mọi 409 đều retry được: chỉ "assets not found" (Admin API chưa thấy asset) và "grant changed" (tranh chấp).

import { ERROR_CODE } from './errors';

export const SIGNED_UPLOAD_KIND = Object.freeze({
  // cấu hình / hỗ trợ
  AUTHORIZE_UNSUPPORTED: 'AUTHORIZE_UNSUPPORTED', // 404 ở authorize: Backend chưa có API
  SIGNED_UNAVAILABLE: 'SIGNED_UNAVAILABLE', // 503 "Signed upload unavailable": tính năng tắt hoặc cấu hình Backend sai
  INVALID_AUTHORIZATION: 'INVALID_AUTHORIZATION', // response authorize sai hợp đồng (Frontend từ chối)
  // grant
  AUTHORIZATION_REQUIRED: 'AUTHORIZATION_REQUIRED', // 403: confirm khi chưa có grant
  GRANT_EXPIRED: 'GRANT_EXPIRED',
  GRANT_INACTIVE: 'GRANT_INACTIVE',
  GRANT_CHANGED: 'GRANT_CHANGED', // tranh chấp ghi: thử lại được
  // confirm
  ASSETS_NOT_FOUND: 'ASSETS_NOT_FOUND', // Admin API chưa thấy asset: thử lại sau được
  ASSETS_MISMATCH: 'ASSETS_MISMATCH', // asset trên Cloudinary không khớp grant: không cứu được
  PARAMS_MISMATCH: 'PARAMS_MISMATCH', // tham số khác lần authorize
  IMAGE_EXISTS: 'IMAGE_EXISTS',
  STATE_CONFLICT: 'STATE_CONFLICT', // các 409 còn lại
  VERIFICATION_UNAVAILABLE: 'VERIFICATION_UNAVAILABLE', // 503: Admin API lỗi/hết lượt; Firestore có thể ĐÃ commit
  // chung
  RATE_LIMITED: 'RATE_LIMITED',
  BACKEND_BUSY: 'BACKEND_BUSY',
  // upload Cloudinary
  SIGNATURE_REJECTED: 'SIGNATURE_REJECTED', // Cloudinary 401/403: xin lại chữ ký (cùng imageId) khi grant còn hạn
  EXISTING_ASSET_MISMATCH: 'EXISTING_ASSET_MISMATCH', // existing=true nhưng asset đang có KHÔNG phải bản vừa nén
  UPLOAD_RESPONSE_MISMATCH: 'UPLOAD_RESPONSE_MISMATCH', // response upload sai public_id/bytes/kích thước/định dạng
  // phiên
  AUTH_CHANGED: 'AUTH_CHANGED', // đăng xuất hoặc đổi UID giữa chừng
  SESSION_OWNER_MISMATCH: 'SESSION_OWNER_MISMATCH', // dùng session của người khác
});

const K = SIGNED_UPLOAD_KIND;

const CONFLICT_BY_DETAIL = Object.freeze({
  'Upload grant expired': { kind: K.GRANT_EXPIRED, retryable: false, newSessionRequired: true },
  'Upload grant is not active': { kind: K.GRANT_INACTIVE, retryable: false, newSessionRequired: true },
  'Uploaded assets not found': { kind: K.ASSETS_NOT_FOUND, retryable: true, newSessionRequired: false },
  'Uploaded assets do not match the upload grant': { kind: K.ASSETS_MISMATCH, retryable: false, newSessionRequired: true },
  'Confirm parameters differ from the upload grant': { kind: K.PARAMS_MISMATCH, retryable: false, newSessionRequired: true },
  'Upload parameters differ from the existing grant': { kind: K.PARAMS_MISMATCH, retryable: false, newSessionRequired: true },
  'Image already exists': { kind: K.IMAGE_EXISTS, retryable: false, newSessionRequired: true },
  'Upload grant changed': { kind: K.GRANT_CHANGED, retryable: true, newSessionRequired: false },
});

/**
 * @param {*} error  lỗi do backendApi/adapter ném (AppError có details.httpStatus/detail/kind)
 * @param {{stage?: 'AUTHORIZING'|'CONFIRMING'}} [context]
 * @returns {{kind: string|undefined, retryable: boolean, newSessionRequired: boolean, retryAfterSeconds: number|null, code: string}}
 */
export function describeBackendFailure(error, { stage } = {}) {
  const details = error?.details ?? {};
  const status = details.httpStatus;
  const detail = typeof details.detail === 'string' ? details.detail : '';
  const retryAfterSeconds = Number.isInteger(details.retryAfterSeconds) ? details.retryAfterSeconds : null;
  const out = (kind, retryable, newSessionRequired = false, code = error?.code) => ({
    kind,
    retryable,
    newSessionRequired,
    retryAfterSeconds,
    code: Object.values(ERROR_CODE).includes(code) ? code : ERROR_CODE.UNKNOWN,
  });

  if (status === undefined) {
    // Lỗi phía Frontend (mạng, timeout, hủy, token, cấu hình, response sai).
    return out(details.kind, details.retryable === true || error?.code === ERROR_CODE.NETWORK || error?.code === ERROR_CODE.CANCELLED);
  }
  if (status === 429) return out(K.RATE_LIMITED, true);
  if (status === 401) return out(details.kind, false);
  if (status === 404 && stage === 'AUTHORIZING') return out(K.AUTHORIZE_UNSUPPORTED, false, false, ERROR_CODE.CONFIG);
  if (status === 403 && detail === 'Upload authorization required') return out(K.AUTHORIZATION_REQUIRED, false, true);
  if (status === 409) {
    const known = CONFLICT_BY_DETAIL[detail];
    return known ? out(known.kind, known.retryable, known.newSessionRequired) : out(K.STATE_CONFLICT, false, true);
  }
  if (status === 503 && detail === 'Signed upload unavailable') return out(K.SIGNED_UNAVAILABLE, false, false, ERROR_CODE.CONFIG);
  if (status === 503 && detail === 'Upload verification unavailable') return out(K.VERIFICATION_UNAVAILABLE, true);
  if (status >= 500) return out(K.BACKEND_BUSY, true);
  return out(details.kind, false);
}

const NEW_SESSION_TEXT = 'Phiên upload này không thể hoàn tất. Hãy bắt đầu lại với phiên upload mới (ảnh đã tải lên Cloudinary không bị tự xóa).';

/**
 * Thông báo tiếng Việt cho người dùng theo `kind` (thay cho câu chung của lớp HTTP, vd "không tìm thấy ảnh" khi authorize 404).
 * Trả null nếu không có câu riêng: nơi gọi giữ thông báo gốc. Không chứa chữ ký, token hay nội dung response.
 */
export function messageForKind(kind, { retryAfterSeconds = null } = {}) {
  const wait = Number.isInteger(retryAfterSeconds) ? ` Hãy thử lại sau khoảng ${retryAfterSeconds} giây.` : ' Hãy thử lại sau.';
  switch (kind) {
    case K.AUTHORIZE_UNSUPPORTED:
      return 'Backend chưa hỗ trợ cấp quyền upload có chữ ký (POST /images/cloudinary/authorize). Sẽ không chuyển sang upload không ký hay MOCK.';
    case K.SIGNED_UNAVAILABLE:
      return 'Backend đang tắt hoặc cấu hình sai tính năng upload có chữ ký. Sẽ không chuyển sang upload không ký hay MOCK.';
    case K.GRANT_EXPIRED:
      return 'Quyền upload đã hết hạn. Hãy bắt đầu lại với phiên upload mới (ảnh đã tải lên Cloudinary không bị tự xóa).';
    case K.GRANT_INACTIVE:
    case K.AUTHORIZATION_REQUIRED:
    case K.IMAGE_EXISTS:
    case K.PARAMS_MISMATCH:
    case K.ASSETS_MISMATCH:
    case K.STATE_CONFLICT:
    case K.EXISTING_ASSET_MISMATCH:
    case K.UPLOAD_RESPONSE_MISMATCH:
      return NEW_SESSION_TEXT;
    case K.ASSETS_NOT_FOUND:
      return 'Backend chưa thấy ảnh vừa upload trên Cloudinary (có thể do độ trễ). Hãy thử xác nhận lại sau ít phút; không cần upload lại.';
    case K.VERIFICATION_UNAVAILABLE:
      return `Backend chưa xác minh được ảnh trên Cloudinary lúc này; ảnh có thể đã được ghi nhận.${wait} Chỉ xác nhận lại, không upload lại.`;
    case K.RATE_LIMITED:
      return `Gọi Backend quá nhanh.${wait}`;
    case K.BACKEND_BUSY:
      return `Backend tạm thời không phản hồi.${wait}`;
    case K.SIGNATURE_REJECTED:
      return 'Cloudinary từ chối chữ ký upload. Hãy thử lại để xin chữ ký mới (cùng ảnh, cùng phiên).';
    case K.GRANT_CHANGED:
      return 'Phiên upload vừa bị thay đổi do tranh chấp ghi. Hãy thử xác nhận lại.';
    default:
      return null;
  }
}
