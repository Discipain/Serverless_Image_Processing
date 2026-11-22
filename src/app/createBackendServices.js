// COMPOSITION ROOT (H3A) — ghép use case confirm với Backend API (GIẢ hoặc THẬT).
//
// Chế độ (xem infrastructure/api/backendConfig.js):
//   - 'mock'    : mặc định. Backend GIẢ, không có request ra ngoài, không dùng ID token.
//   - 'real'    : Backend thật qua fetch + Bearer token. Chỉ khi VITE_BACKEND_MODE=real và VITE_API_BASE_URL hợp lệ.
//   - 'invalid' : đã chọn real nhưng cấu hình sai -> lỗi CONFIG rõ ràng, KHÔNG tự chuyển sang MOCK.
//
// CHƯA nối vào UI (H3B/H4). Không gọi mạng khi khởi tạo. Chế độ real cần `getIdToken` (use case của H1,
// lấy từ createAuthServices().useCases.getIdToken).

import { readBackendConfig, BACKEND_MODE } from '../infrastructure/api/backendConfig';
import { createBackendClient, createUnavailableBackendApi } from '../infrastructure/api/backendClient';
import { createMockBackendApi } from '../infrastructure/mock/mockBackendApi';
import { createConfirmCloudinaryUpload } from '../application/usecases/confirmCloudinaryUpload';

/**
 * @param {Object} [options]  (ứng dụng gọi không đối số chỉ cho chế độ mock; real cần getIdToken)
 * @param {{mode: string, baseUrl: string|null, configError: object|null}} [options.config]
 * @param {(options?: {forceRefresh?: boolean}) => Promise<string>} [options.getIdToken]
 * @param {typeof fetch} [options.fetchImpl]  chỉ để kiểm thử
 * @param {Object} [options.mockOptions]  tuỳ chọn cho Backend giả (getScenario, latencyMs, ...)
 */
export function createBackendServices({
  config = readBackendConfig(),
  getIdToken,
  fetchImpl,
  mockOptions = {},
} = {}) {
  let backendApi;
  if (config.mode === BACKEND_MODE.REAL) {
    if (typeof getIdToken !== 'function') {
      throw new TypeError('createBackendServices: chế độ real cần getIdToken (use case xác thực của H1).');
    }
    backendApi = createBackendClient({ baseUrl: config.baseUrl, getIdToken, fetchImpl });
  } else if (config.mode === BACKEND_MODE.MOCK) {
    backendApi = createMockBackendApi(mockOptions);
  } else {
    backendApi = createUnavailableBackendApi(config.configError);
  }

  return Object.freeze({
    mode: config.mode,
    isMock: config.mode === BACKEND_MODE.MOCK,
    configError: config.configError,
    useCases: Object.freeze({
      confirmCloudinaryUpload: createConfirmCloudinaryUpload({ backendApi }),
    }),
  });
}
