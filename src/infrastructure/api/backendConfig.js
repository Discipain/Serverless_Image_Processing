// INFRASTRUCTURE — đọc cấu hình Backend từ VITE_BACKEND_MODE và VITE_API_BASE_URL.
//
//   VITE_BACKEND_MODE=mock (hoặc để trống)  -> Backend GIẢ (MOCK). KHÔNG có request nào ra Backend thật.
//   VITE_BACKEND_MODE=real                  -> Backend thật, bắt buộc VITE_API_BASE_URL hợp lệ.
//   giá trị khác / real mà thiếu hoặc sai URL -> mode 'invalid' + configError. TUYỆT ĐỐI không tự chuyển sang MOCK.
//
// Mặc định (không cấu hình gì) là MOCK. Trong H3A chưa có gì nối tới Backend thật.
// Chỉ trả về TÊN biến lỗi/thiếu, không in giá trị cấu hình.

export const BACKEND_ENV = Object.freeze({
  mode: 'VITE_BACKEND_MODE',
  baseUrl: 'VITE_API_BASE_URL',
});

export const BACKEND_MODE = Object.freeze({ MOCK: 'mock', REAL: 'real', INVALID: 'invalid' });

const clean = (value) => (typeof value === 'string' ? value.trim() : '');
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

function invalid(message, missing = []) {
  return { mode: BACKEND_MODE.INVALID, baseUrl: null, configError: { message, missing } };
}

/**
 * @param {Record<string, unknown>} [source]  mặc định import.meta.env (tham số để kiểm thử)
 * @returns {{mode: 'mock'|'real'|'invalid', baseUrl: string|null, configError: null|{message: string, missing: string[]}}}
 */
export function readBackendConfig(source = import.meta.env) {
  const rawMode = clean(source?.[BACKEND_ENV.mode]).toLowerCase();
  const rawUrl = clean(source?.[BACKEND_ENV.baseUrl]);

  if (rawMode === '' || rawMode === BACKEND_MODE.MOCK) {
    // Chế độ MOCK bỏ qua hoàn toàn VITE_API_BASE_URL (không bao giờ dùng để gọi mạng).
    return { mode: BACKEND_MODE.MOCK, baseUrl: null, configError: null };
  }
  if (rawMode !== BACKEND_MODE.REAL) {
    return invalid(`${BACKEND_ENV.mode} không hợp lệ (chỉ nhận "mock" hoặc "real").`);
  }

  if (!rawUrl) {
    return invalid(
      `Đã chọn Backend thật (${BACKEND_ENV.mode}=real) nhưng thiếu ${BACKEND_ENV.baseUrl}. Hãy điền trong .env.local hoặc đặt ${BACKEND_ENV.mode}=mock.`,
      [BACKEND_ENV.baseUrl],
    );
  }

  let url;
  try {
    url = new URL(rawUrl);
  } catch {
    return invalid(`${BACKEND_ENV.baseUrl} không phải URL hợp lệ (cần dạng https://host, hoặc http://localhost:<cổng> khi chạy cục bộ).`);
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    return invalid(`${BACKEND_ENV.baseUrl} chỉ chấp nhận http(s).`);
  }
  if (url.protocol === 'http:' && !LOCAL_HOSTS.has(url.hostname)) {
    return invalid(`${BACKEND_ENV.baseUrl} phải dùng https (http chỉ cho phép với localhost).`);
  }
  if (url.username || url.password) {
    return invalid(`${BACKEND_ENV.baseUrl} không được chứa tên người dùng/mật khẩu.`);
  }
  if (url.search || url.hash) {
    return invalid(`${BACKEND_ENV.baseUrl} không được chứa query hoặc fragment.`);
  }

  const path = url.pathname.replace(/\/+$/, '');
  return { mode: BACKEND_MODE.REAL, baseUrl: `${url.origin}${path}`, configError: null };
}
