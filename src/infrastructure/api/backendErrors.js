// INFRASTRUCTURE — lỗi dùng chung của Backend API (adapter thật và adapter MOCK cùng dùng để hành vi giống nhau).
//
// Không import Firebase/React. Không bao giờ đưa token, header Authorization hay body request vào lỗi.

import { AppError, ERROR_CODE } from '../../application/errors';

export const BACKEND_ERROR_KIND = Object.freeze({
  CONFIG: 'CONFIG', // chọn chế độ real nhưng thiếu/sai cấu hình
  BAD_REQUEST: 'BAD_REQUEST', // 400
  UNPROCESSABLE: 'UNPROCESSABLE', // 422 (FastAPI validation)
  TOO_LARGE: 'TOO_LARGE', // 413
  UNAUTHENTICATED: 'UNAUTHENTICATED', // 401
  TOKEN_UNAVAILABLE: 'TOKEN_UNAVAILABLE', // không lấy được ID token (chưa đăng nhập, mất mạng khi làm mới...)
  FORBIDDEN: 'FORBIDDEN', // 403
  NOT_FOUND: 'NOT_FOUND', // 404
  RATE_LIMITED: 'RATE_LIMITED', // 429
  SERVER_ERROR: 'SERVER_ERROR', // 5xx
  HTTP_ERROR: 'HTTP_ERROR', // mã HTTP khác
  NETWORK: 'NETWORK',
  TIMEOUT: 'TIMEOUT',
  CANCELLED: 'CANCELLED',
  INVALID_RESPONSE: 'INVALID_RESPONSE', // 2xx nhưng nội dung không dùng được
});

const MAX_DETAIL = 300;

export function backendError(code, kind, message, extra = {}) {
  return new AppError(code, message, { kind, ...extra });
}

export const cancelledError = () =>
  backendError(ERROR_CODE.CANCELLED, BACKEND_ERROR_KIND.CANCELLED, 'Đã hủy yêu cầu tới Backend.');

/**
 * Rút thông điệp từ body lỗi của FastAPI: {"detail": "chuỗi"} hoặc {"detail": [{loc, msg, type}, ...]}.
 * Không bao giờ ném lỗi; trả null nếu không đọc được.
 */
export function extractDetail(text) {
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return null;
  }
  const detail = body?.detail;
  if (typeof detail === 'string') return detail.slice(0, MAX_DETAIL);
  if (Array.isArray(detail)) {
    const parts = detail
      .map((item) => {
        if (typeof item === 'string') return item;
        const loc = Array.isArray(item?.loc) ? item.loc.filter((p) => p !== 'body').join('.') : '';
        return [loc, typeof item?.msg === 'string' ? item.msg : ''].filter(Boolean).join(': ');
      })
      .filter(Boolean);
    return parts.length > 0 ? parts.join('; ').slice(0, MAX_DETAIL) : null;
  }
  if (detail && typeof detail === 'object' && typeof detail.message === 'string') {
    return detail.message.slice(0, MAX_DETAIL);
  }
  return null;
}

/** Chuyển mã HTTP lỗi + `detail` của Backend thành lỗi của Application. */
export function errorFromHttp(status, detail) {
  const suffix = detail ? ` (${detail})` : '';
  const extra = { httpStatus: status, detail: detail ?? null };
  const K = BACKEND_ERROR_KIND;
  const C = ERROR_CODE;
  if (status === 400) return backendError(C.VALIDATION, K.BAD_REQUEST, `Backend từ chối dữ liệu xác nhận (HTTP 400)${suffix}.`, extra);
  if (status === 401) return backendError(C.UNAUTHENTICATED, K.UNAUTHENTICATED, `Backend không chấp nhận phiên đăng nhập (HTTP 401)${suffix}. Hãy đăng nhập lại.`, extra);
  if (status === 403) return backendError(C.FORBIDDEN, K.FORBIDDEN, `Bạn không có quyền với ảnh này (HTTP 403)${suffix}.`, extra);
  if (status === 404) return backendError(C.NOT_FOUND, K.NOT_FOUND, `Backend không tìm thấy ảnh (HTTP 404)${suffix}.`, extra);
  if (status === 413) return backendError(C.VALIDATION, K.TOO_LARGE, `Dữ liệu hoặc file quá lớn (HTTP 413)${suffix}.`, extra);
  if (status === 422) return backendError(C.VALIDATION, K.UNPROCESSABLE, `Backend không xử lý được dữ liệu gửi lên (HTTP 422)${suffix}.`, extra);
  if (status === 429) return backendError(C.QUOTA_EXCEEDED, K.RATE_LIMITED, `Gọi Backend quá nhanh (HTTP 429)${suffix}. Hãy thử lại sau.`, { ...extra, retryable: true });
  if (status >= 500) return backendError(C.UNKNOWN, K.SERVER_ERROR, `Backend gặp lỗi (HTTP ${status})${suffix}. Hãy thử lại sau.`, { ...extra, retryable: true });
  return backendError(C.UNKNOWN, K.HTTP_ERROR, `Backend trả về mã HTTP không mong đợi (${status})${suffix}.`, extra);
}
