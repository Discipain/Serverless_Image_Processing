// INFRASTRUCTURE / MOCK — Backend GIẢ cho POST /images/cloudinary/confirm. KHÔNG phải Backend thật.
//
// - KHÔNG gọi mạng, KHÔNG gọi FastAPI, KHÔNG gọi Cloudinary, KHÔNG ghi Firestore, KHÔNG đọc/gửi ID token.
// - Cài port `backendApi` (application/ports.js). Kết quả mang `isMock: true`: không được trình bày như phản hồi thật.
// - Mô phỏng luật của CONTRACT Hybrid mục 3 (commit 72ee441 + xác nhận của nhóm trưởng Tới về processedSize):
//     6 field BẮT BUỘC: imageId, thumbnail, medium, webp, originalSize, processingMs (thiếu 1 trong 6 -> 400).
//     7 field TÙY CHỌN: fileName, width, height, thumbnailId, mediumId, webpId, processedSize
//       (thiếu thì bỏ qua, KHÔNG bắt buộc processedSize; có mà sai kiểu/giá trị -> 400).
//     URL phải là https://res.cloudinary.com/... (và đúng cloud nếu cấu hình `cloudName`); originalSize <= 10MB.
//     Confirm trùng imageId -> trả lại kết quả cũ (idempotent), không ghi đè.
//   Mock còn TỪ CHỐI field ngoài 13 field trên (vd contentType) để bắt lỗi nếu Frontend lỡ gửi dữ liệu ngoài CONTRACT.
//   Đây là chính sách của MOCK, KHÔNG khẳng định Backend thật cũng từ chối field lạ.
// - imageId do FRONTEND tạo (crypto.randomUUID, một lần trước khi nén) và truyền vào; mock không cấp imageId.
//   `knownImageIds` (tùy chọn) mô phỏng cấu hình Backend KHÔNG tự tạo bản ghi PENDING (CONTRACT dòng 404 "tùy cài đặt").
// - savedPercent: khi request có processedSize hợp lệ, mock TÍNH = (1 - processedSize / originalSize) x 100, làm tròn 1 chữ số
//   (công thức của TEST-PLAN.md, khớp ví dụ CONTRACT: 2457600 -> 412000 = 83,2). Đây là phép tính của MOCK, không khẳng định
//   Backend thật làm tròn giống hệt. Khi KHÔNG có processedSize, mock không bịa: trả null (hoặc giá trị mô phỏng do
//   options.savedPercent đặt, chỉ dùng thử giao diện; kết quả luôn có isMock: true).
// - Dùng cùng bộ lỗi với adapter thật (backendErrors.js) nên giao diện xử lý như nhau.
// Chỉ phục vụ phát triển và kiểm thử.

import { ERROR_CODE } from '../../application/errors';
import { BACKEND_ERROR_KIND as KIND, backendError, cancelledError, errorFromHttp } from '../api/backendErrors';
import { PAGE_SIZE } from '../../domain/constants/imageRules';
import { mapGalleryDetail, mapGalleryPage, normalizeListParams, buildImagePath } from '../api/galleryMapper';

export const MOCK_BACKEND_LABEL = 'MOCK';

/** Kịch bản lỗi/thành công để thử giao diện (đọc lúc gọi, nên đổi kịch bản không cần tạo lại adapter). */
export const MOCK_BACKEND_SCENARIOS = Object.freeze({
  SUCCESS: 'success',
  UNAUTHENTICATED: 'unauthenticated', // 401 { detail: 'Missing token' }
  FORBIDDEN: 'forbidden', // 403 { detail: 'Forbidden' }
  NOT_FOUND: 'not-found', // 404
  RATE_LIMITED: 'rate-limited', // 429
  SERVER_ERROR: 'server-error', // 500 { detail: 'Internal error' }
  NETWORK: 'network', // mất mạng
  TIMEOUT: 'timeout', // quá thời gian chờ
  INVALID_RESPONSE: 'invalid-response', // trả kết quả KHÔNG phải DONE (kiểm tra Application không tin mù quáng)
});

// Bản sao ĐỘC LẬP của luật CONTRACT (không import từ Domain) để bắt lỗi nếu payload dựng sai.
const REQUIRED = [
  ['imageId', 'string'], ['thumbnail', 'string'], ['medium', 'string'], ['webp', 'string'],
  ['originalSize', 'number'], ['processingMs', 'number'],
];
const OPTIONAL = [
  ['fileName', 'string'], ['width', 'number'], ['height', 'number'],
  ['thumbnailId', 'string'], ['mediumId', 'string'], ['webpId', 'string'],
  ['processedSize', 'number'],
];
const MAX_BYTES = 10 * 1024 * 1024;

function wait(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener?.('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener?.('abort', onAbort, { once: true });
  });
}

function validatePayload(payload, { cloudName }) {
  const bad = (detail) => errorFromHttp(400, detail);
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return bad('Invalid body');

  for (const [name, type] of REQUIRED) {
    if (!(name in payload) || payload[name] === null || payload[name] === undefined) return bad(`Missing field: ${name}`);
    if (typeof payload[name] !== type) return bad(`Invalid type: ${name}`);
  }
  // Field tùy chọn: thiếu thì bỏ qua; nếu có thì phải đúng kiểu.
  for (const [name, type] of OPTIONAL) {
    if (!(name in payload) || payload[name] === undefined) continue;
    if (typeof payload[name] !== type) return bad(`Invalid type: ${name}`);
  }
  const known = new Set([...REQUIRED, ...OPTIONAL].map(([name]) => name));
  for (const key of Object.keys(payload)) if (!known.has(key)) return bad(`Unknown field: ${key}`);

  if (!(payload.originalSize > 0) || payload.originalSize > MAX_BYTES) return bad('File too large');
  if (!(payload.processingMs >= 0)) return bad('Invalid processingMs');
  for (const name of ['width', 'height']) {
    if (name in payload && !(Number.isInteger(payload[name]) && payload[name] > 0)) return bad(`Invalid value: ${name}`);
  }
  // processedSize (tùy chọn): nếu có phải là số nguyên không âm, hữu hạn.
  if ('processedSize' in payload && !(Number.isInteger(payload.processedSize) && payload.processedSize >= 0)) {
    return bad('Invalid value: processedSize');
  }
  for (const key of ['thumbnail', 'medium', 'webp']) {
    let url;
    try {
      url = new URL(payload[key]);
    } catch {
      return bad('Invalid cloudinary url');
    }
    const okHost = url.protocol === 'https:' && url.hostname === 'res.cloudinary.com';
    const okCloud = !cloudName || url.pathname.startsWith(`/${cloudName}/`);
    if (!okHost || !okCloud) return bad('Invalid cloudinary url');
  }
  return null;
}

/**
 * @param {Object} [options]
 * @param {() => string} [options.getScenario]
 * @param {number} [options.latencyMs=400]
 * @param {string} [options.ownerId]  ownerId giả trong kết quả
 * @param {Set<string>|null} [options.knownImageIds]  nếu có: imageId ngoài tập này -> 404
 * @param {string|null} [options.cloudName]  nếu có: 3 URL phải thuộc cloud này (mô phỏng luật "đúng cloud của nhóm")
 * @param {number|null} [options.savedPercent]  giá trị savedPercent MÔ PHỎNG khi request KHÔNG có processedSize (mặc định null: không bịa số)
 * @param {Array<Object>} [options.galleryItems]  (INT-3A) dữ liệu Gallery GIẢ, đúng DẠNG JSON của Backend (cùng bộ ánh xạ với adapter thật).
 *   Mô phỏng Backend lọc theo chủ sở hữu: chỉ trả phần tử có `ownerId === options.ownerId`. Mặc định rỗng. Kết quả luôn `isMock: true`.
 * @returns {import('../../application/ports.js').BackendApi & {debug: object}}
 */
export function createMockBackendApi({
  getScenario = () => MOCK_BACKEND_SCENARIOS.SUCCESS,
  latencyMs = 400,
  ownerId = 'mock-owner-uid',
  knownImageIds = null,
  cloudName = null,
  savedPercent = null,
  galleryItems = [],
} = {}) {
  const store = new Map(); // imageId -> kết quả DONE đầu tiên (không ghi đè)
  const attempts = new Map(); // imageId -> số lần gọi confirm
  const S = MOCK_BACKEND_SCENARIOS;

  // Lỗi theo kịch bản cho Gallery (cùng bộ lỗi với confirm). SUCCESS và INVALID_RESPONSE không ném ở đây.
  async function throwScenarioError(scenario) {
    if (scenario === S.NETWORK) throw backendError(ERROR_CODE.NETWORK, KIND.NETWORK, 'MOCK: mất kết nối tới Backend giả lập.', { retryable: true });
    if (scenario === S.TIMEOUT) throw backendError(ERROR_CODE.NETWORK, KIND.TIMEOUT, 'MOCK: Backend giả lập phản hồi quá thời gian chờ.', { retryable: true });
    const byStatus = { [S.UNAUTHENTICATED]: [401, 'Missing token'], [S.FORBIDDEN]: [403, 'Forbidden'], [S.NOT_FOUND]: [404, 'Image not found'],
      [S.RATE_LIMITED]: [429, 'Too many requests'], [S.SERVER_ERROR]: [500, 'Internal error'] };
    if (byStatus[scenario]) throw errorFromHttp(byStatus[scenario][0], byStatus[scenario][1], { subject: 'yêu cầu tải ảnh' });
  }

  return {
    async confirmCloudinaryUpload(payload, { signal } = {}) {
      await wait(latencyMs, signal);

      const scenario = getScenario();
      if (scenario === S.NETWORK) {
        throw backendError(ERROR_CODE.NETWORK, KIND.NETWORK, 'MOCK: mất kết nối tới Backend giả lập.', { retryable: true });
      }
      if (scenario === S.TIMEOUT) {
        throw backendError(ERROR_CODE.NETWORK, KIND.TIMEOUT, 'MOCK: Backend giả lập phản hồi quá thời gian chờ.', { retryable: true });
      }
      if (scenario === S.UNAUTHENTICATED) throw errorFromHttp(401, 'Missing token');
      if (scenario === S.FORBIDDEN) throw errorFromHttp(403, 'Forbidden');
      if (scenario === S.NOT_FOUND) throw errorFromHttp(404, 'Image not found');
      if (scenario === S.RATE_LIMITED) throw errorFromHttp(429, 'Too many requests');
      if (scenario === S.SERVER_ERROR) throw errorFromHttp(500, 'Internal error');

      const problem = validatePayload(payload, { cloudName });
      if (problem) throw problem;

      const { imageId } = payload;
      attempts.set(imageId, (attempts.get(imageId) ?? 0) + 1);

      if (scenario === S.INVALID_RESPONSE) {
        return { imageId, status: 'PENDING', ownerId, variants: null, isMock: true };
      }
      // Idempotent: đã DONE thì trả lại kết quả cũ, không ghi đè.
      if (store.has(imageId)) return store.get(imageId);
      if (knownImageIds && !knownImageIds.has(imageId)) throw errorFromHttp(404, 'Image not found');

      // Chỉ tính khi request thật sự có processedSize hợp lệ (đã kiểm tra ở validatePayload); không bịa.
      const computedSaved =
        typeof payload.processedSize === 'number'
          ? Math.round((1 - payload.processedSize / payload.originalSize) * 1000) / 10
          : null;

      // Chỉ lặp lại các *Id mà request ĐÃ gửi; không bịa public_id.
      const variants = { thumbnail: payload.thumbnail, medium: payload.medium, webp: payload.webp };
      for (const key of ['thumbnailId', 'mediumId', 'webpId']) {
        if (typeof payload[key] === 'string' && payload[key] !== '') variants[key] = payload[key];
      }
      const result = Object.freeze({
        imageId,
        status: 'DONE',
        ownerId,
        variants: Object.freeze(variants),
        processingMs: payload.processingMs,
        savedPercent: computedSaved ?? (Number.isFinite(savedPercent) ? savedPercent : null), // tính từ processedSize, hoặc mô phỏng/null
        isMock: true,
      });
      store.set(imageId, result);
      return result;
    },

    // GET /images (MOCK): phân trang bằng cursor mờ "mock-<offset>"; ảnh của chủ sở hữu khác không bao giờ xuất hiện.
    async listImages({ limit, cursor } = {}, { signal } = {}) {
      await wait(latencyMs, signal);
      await throwScenarioError(getScenario());
      const params = normalizeListParams({ limit, cursor });
      const size = params.limit ?? PAGE_SIZE;
      let offset = 0;
      if (params.cursor !== undefined) {
        const m = /^mock-(\d{1,9})$/.exec(params.cursor);
        if (!m) throw errorFromHttp(400, 'Invalid cursor', { subject: 'yêu cầu tải ảnh' });
        offset = Number(m[1]);
      }
      const mine = galleryItems.filter((item) => item?.ownerId === ownerId);
      const items = mine.slice(offset, offset + size);
      const hasMore = offset + size < mine.length;
      const body =
        getScenario() === S.INVALID_RESPONSE
          ? { items: 'khong-phai-mang' }
          : { items, nextCursor: hasMore ? `mock-${offset + size}` : null, hasMore };
      return mapGalleryPage(body, { maxItems: size, isMock: true });
    },

    // GET /images/{imageId} (MOCK): ảnh của chủ sở hữu khác => 403 Forbidden (đúng CONTRACT), không tồn tại => 404.
    async getImage(imageId, { signal } = {}) {
      buildImagePath(imageId);
      await wait(latencyMs, signal);
      await throwScenarioError(getScenario());
      const found = galleryItems.find((item) => item?.imageId === imageId);
      if (!found) throw errorFromHttp(404, 'Image not found', { subject: 'yêu cầu tải ảnh' });
      if (found.ownerId !== ownerId) throw errorFromHttp(403, 'Forbidden', { subject: 'yêu cầu tải ảnh' });
      return mapGalleryDetail(getScenario() === S.INVALID_RESPONSE ? { imageId, status: 'DONE?' } : found, imageId, { isMock: true });
    },

    /** Chỉ để kiểm thử/chẩn đoán, không thuộc port. */
    debug: {
      storedCount: () => store.size,
      attemptsFor: (imageId) => attempts.get(imageId) ?? 0,
    },
  };
}
