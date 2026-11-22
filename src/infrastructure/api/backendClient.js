// INFRASTRUCTURE — cài port `backendApi` (application/ports.js) bằng fetch tới Backend FastAPI THẬT.
//
// Xác thực: `Authorization: Bearer <Firebase ID token>` (CONTRACT mục 0). KHÔNG dùng X-User-Id.
//  - Token được lấy MỚI qua `getIdToken` (H1) ở MỖI request, giữ trong biến cục bộ, không lưu vào state/storage,
//    không ghi log, không đưa vào URL/lỗi.
//  - Nếu Backend trả 401: thử làm mới token (forceRefresh) và gửi lại TỐI ĐA MỘT LẦN, và chỉ khi token mới khác
//    token cũ. Không có vòng lặp. Mọi trường hợp khác KHÔNG tự retry (mạng, timeout, 5xx...).
//  - Timeout + AbortSignal. Không credentials/cookie (credentials: 'omit').
//  - KHÔNG gọi mạng khi khởi tạo module hay khi tạo client; chỉ gọi khi có request.
//
// CHƯA KIỂM CHỨNG VỚI BACKEND THẬT: Backend chưa có API confirm đúng CONTRACT (xem báo cáo H3A).

import { ERROR_CODE } from '../../application/errors';
import { CONFIRM_PAYLOAD_FIELDS, CONFIRM_REQUIRED_FIELDS } from '../../domain/models/confirmPayload';
import {
  BACKEND_ERROR_KIND as KIND,
  backendError,
  cancelledError,
  errorFromHttp,
  extractDetail,
} from './backendErrors';

export const DEFAULT_TIMEOUT_MS = 30_000;
export const CONFIRM_PATH = '/images/cloudinary/confirm';

const isHttpsUrl = (v) => typeof v === 'string' && v.startsWith('https://');

/** Kiểm tra response 2xx của confirm: status DONE, imageId khớp, đủ 3 URL biến thể. */
function parseConfirmResult(text, expectedImageId) {
  const bad = (reason) =>
    backendError(ERROR_CODE.UNKNOWN, KIND.INVALID_RESPONSE, `Backend trả về dữ liệu xác nhận không hợp lệ (${reason}).`, {
      retryable: false,
    });

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw bad('không phải JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw bad('không phải đối tượng JSON');
  if (body.status !== 'DONE') throw bad(`status là "${String(body.status)}" thay vì DONE`);
  if (body.imageId !== expectedImageId) throw bad('imageId không khớp với yêu cầu');
  const v = body.variants;
  if (!v || !isHttpsUrl(v.thumbnail) || !isHttpsUrl(v.medium) || !isHttpsUrl(v.webp)) {
    throw bad('thiếu 3 URL biến thể variants.thumbnail/medium/webp');
  }
  const num = (n) => (typeof n === 'number' && Number.isFinite(n) ? n : null);
  // thumbnailId/mediumId/webpId (public_id) là TÙY CHỌN trong response: chỉ giữ khi Backend trả chuỗi không rỗng,
  // không tự bịa hay suy ra từ URL.
  const variants = { thumbnail: v.thumbnail, medium: v.medium, webp: v.webp };
  for (const key of ['thumbnailId', 'mediumId', 'webpId']) {
    if (typeof v[key] === 'string' && v[key] !== '') variants[key] = v[key];
  }
  return Object.freeze({
    imageId: body.imageId,
    status: 'DONE',
    ownerId: typeof body.ownerId === 'string' ? body.ownerId : null,
    variants: Object.freeze(variants),
    processingMs: num(body.processingMs),
    savedPercent: num(body.savedPercent),
    isMock: false,
  });
}

/**
 * @param {Object} options
 * @param {string} options.baseUrl  đã được readBackendConfig chuẩn hóa (không có "/" cuối)
 * @param {(options?: {forceRefresh?: boolean}) => Promise<string>} options.getIdToken  use case getIdToken của H1
 * @param {typeof fetch} [options.fetchImpl]  điểm tiêm để kiểm thử (mặc định: fetch của trình duyệt, gọi lúc request)
 * @param {number} [options.timeoutMs=30000]  thời gian chờ MỖI lần gửi
 * @returns {import('../../application/ports.js').BackendApi}
 */
export function createBackendClient({ baseUrl, getIdToken, fetchImpl, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
  if (typeof baseUrl !== 'string' || !/^https?:\/\//.test(baseUrl)) {
    throw new TypeError('createBackendClient cần baseUrl http(s) hợp lệ (từ readBackendConfig).');
  }
  if (typeof getIdToken !== 'function') {
    throw new TypeError('createBackendClient cần hàm getIdToken (use case xác thực của H1).');
  }
  const base = baseUrl.replace(/\/+$/, '');
  const doFetch = fetchImpl ?? ((...args) => globalThis.fetch(...args));

  async function obtainToken(forceRefresh) {
    let token;
    try {
      token = await getIdToken({ forceRefresh });
    } catch (error) {
      throw backendError(
        typeof error?.code === 'string' ? error.code : ERROR_CODE.UNAUTHENTICATED,
        KIND.TOKEN_UNAVAILABLE,
        `Không lấy được Firebase ID token: ${error?.message || 'chưa đăng nhập'}`,
        { cause: error },
      );
    }
    if (typeof token !== 'string' || token === '') {
      throw backendError(ERROR_CODE.UNAUTHENTICATED, KIND.TOKEN_UNAVAILABLE, 'Không có Firebase ID token (chưa đăng nhập?).');
    }
    return token;
  }

  // Gửi MỘT request. Trả { status, text }; ném lỗi mạng/timeout/hủy.
  async function sendOnce({ method, path, token, body, signal }) {
    if (signal?.aborted) throw cancelledError();
    const controller = new AbortController();
    let timedOut = false;
    const onAbort = () => controller.abort();
    signal?.addEventListener?.('abort', onAbort, { once: true });
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      const headers = { Accept: 'application/json', Authorization: `Bearer ${token}` };
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      const response = await doFetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: controller.signal,
        credentials: 'omit',
        cache: 'no-store',
        mode: 'cors',
      });
      const text = await response.text();
      return { status: response.status, text };
    } catch (error) {
      if (signal?.aborted) throw cancelledError();
      if (timedOut) {
        throw backendError(ERROR_CODE.NETWORK, KIND.TIMEOUT, 'Backend phản hồi quá thời gian chờ. Hãy thử lại.', { retryable: true });
      }
      throw backendError(
        ERROR_CODE.NETWORK,
        KIND.NETWORK,
        'Không kết nối được tới Backend (mạng, CORS hoặc máy chủ chưa chạy). Hãy kiểm tra và thử lại.',
        { retryable: true, cause: error },
      );
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener?.('abort', onAbort);
    }
  }

  async function request({ method, path, body, signal }) {
    if (signal?.aborted) throw cancelledError();
    const token = await obtainToken(false);
    let result = await sendOnce({ method, path, token, body, signal });

    // 401: làm mới token và gửi lại đúng MỘT lần (chỉ khi token mới khác token cũ).
    if (result.status === 401) {
      let fresh;
      try {
        fresh = await obtainToken(true);
      } catch {
        fresh = null; // không làm mới được: giữ nguyên kết quả 401
      }
      if (fresh && fresh !== token) {
        result = await sendOnce({ method, path, token: fresh, body, signal });
      }
    }
    return result;
  }

  return {
    async confirmCloudinaryUpload(payload, { signal } = {}) {
      if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
        throw backendError(ERROR_CODE.VALIDATION, KIND.BAD_REQUEST, 'Payload xác nhận không hợp lệ.');
      }
      // Chỉ gửi các field có trong CONTRACT (6 bắt buộc + 7 tùy chọn, tối đa 13): chặn field lạ (vd contentType)
      // và thiếu field bắt buộc TRƯỚC khi gửi, để không lỡ đẩy dữ liệu ngoài CONTRACT lên Backend thật.
      const extra = Object.keys(payload).filter((key) => !CONFIRM_PAYLOAD_FIELDS.includes(key));
      const absent = CONFIRM_REQUIRED_FIELDS.filter((key) => payload[key] === undefined || payload[key] === null);
      if (extra.length > 0 || absent.length > 0) {
        const parts = [];
        if (absent.length > 0) parts.push(`thiếu ${absent.join(', ')}`);
        if (extra.length > 0) parts.push(`field ngoài CONTRACT: ${extra.join(', ')}`);
        throw backendError(ERROR_CODE.VALIDATION, KIND.BAD_REQUEST, `Payload xác nhận không đúng CONTRACT (${parts.join('; ')}).`);
      }
      const { status, text } = await request({ method: 'POST', path: CONFIRM_PATH, body: payload, signal });
      if (status >= 200 && status < 300) return parseConfirmResult(text, payload.imageId);
      throw errorFromHttp(status, extractDetail(text));
    },
  };
}

/**
 * BackendApi dùng khi đã chọn chế độ real nhưng cấu hình sai: mọi lời gọi báo lỗi CONFIG rõ ràng,
 * KHÔNG chuyển sang MOCK và KHÔNG gọi mạng.
 * @param {{message: string, missing?: string[]}} configError
 */
export function createUnavailableBackendApi({ message, missing = [] }) {
  return {
    async confirmCloudinaryUpload() {
      throw backendError(ERROR_CODE.CONFIG, KIND.CONFIG, message, { missing, unavailable: true });
    },
  };
}
