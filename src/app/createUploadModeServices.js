// COMPOSITION ROOT (H4B-5) — chọn luồng upload của trang Upload: MOCK (mặc định) hoặc REAL (Signed Upload của H4B-4, tường minh).
//
//   VITE_UPLOAD_MODE trống / "mock"  -> MOCK (luồng H4A). Mọi biến khác (VITE_BACKEND_MODE, VITE_API_BASE_URL, VITE_FIREBASE_*,
//                                       VITE_CLOUDINARY_*) bị BỎ QUA: có .env.local đầy đủ cũng KHÔNG tự bật REAL.
//   VITE_UPLOAD_MODE=real            -> REAL, nhưng CHỈ khi đồng thời thỏa TẤT CẢ:
//        1. VITE_BACKEND_MODE=real và VITE_API_BASE_URL hợp lệ (readBackendConfig);
//        2. Backend ở loopback (localhost / 127.0.0.1 / [::1]) — giai đoạn phát triển, chưa hỗ trợ Backend từ xa;
//        3. môi trường development (npm run dev), không phải bản build production;
//        4. Firebase Authentication THẬT (authServices.mode === 'firebase') có getIdToken và observeAuthState;
//        5. VITE_CLOUDINARY_CLOUD_NAME hợp lệ (giá trị PUBLIC; REAL KHÔNG đọc VITE_CLOUDINARY_UPLOAD_PRESET).
//      Thiếu một điều kiện => mode 'invalid' kèm configError (liệt kê TÊN biến/điều kiện, không in giá trị).
//   giá trị khác của VITE_UPLOAD_MODE -> 'invalid'.
//
// KHÔNG BAO GIỜ fallback ngầm: 'invalid' không bao giờ chạy MOCK, không bao giờ upload không ký, không gọi authorize, không gọi mạng.
// Chỉ khi mode 'real' mới dựng dịch vụ Signed Upload (backend client + uploader Cloudinary có chữ ký); MOCK không khởi tạo gì của REAL.
// KHÔNG gọi mạng khi khởi tạo hay import. Dependency Injection: env, isDev, authServices, fetchImpl, signedOptions (bộ xử lý ảnh, XHR giả...)
// đều truyền được từ test; auth giả CHỈ vào được qua tham số `authServices` do harness truyền tường minh.

import { readBackendConfig, BACKEND_MODE } from '../infrastructure/api/backendConfig';
import { readCloudinaryConfig } from '../infrastructure/cloudinary/cloudinaryConfig';
import { CLOUD_NAME_PATTERN } from '../domain/models/uploadAuthorization';
import {
  INVALID_UPLOAD_MODE_MESSAGE,
  UPLOAD_ENV,
  UPLOAD_MODE,
  createUnavailableUploadServices,
  parseUploadModeSetting,
} from '../application/uploadMode';
import { createSignedUploadServices } from './createSignedUploadServices';

export { UPLOAD_ENV, UPLOAD_MODE };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);
const NO_SCENARIOS = Object.freeze([]);
const NO_SCENARIO_CONTROL = Object.freeze({ get: () => 'normal', set: () => {} });

const invalid = (problems, missing = []) => ({
  mode: UPLOAD_MODE.INVALID,
  backendConfig: null,
  cloudName: null,
  configError: {
    message: `Upload REAL chưa dùng được: ${problems.join(' ')} Hãy sửa cấu hình rồi khởi động lại "npm run dev", hoặc bỏ ${UPLOAD_ENV.mode} để dùng MOCK.`,
    missing,
  },
});

/**
 * Hàm thuần: quyết định chế độ Upload. Không gọi mạng, không đọc import.meta.
 * @param {{env: Record<string, unknown>, isDev: boolean, authMode?: string, hasIdToken?: boolean, hasObserveAuth?: boolean}} input
 * @returns {{mode: 'mock'|'real'|'invalid', backendConfig: object|null, cloudName: string|null, configError: null|{message: string, missing: string[]}}}
 */
export function resolveUploadConfig({ env, isDev, authMode, hasIdToken, hasObserveAuth }) {
  const setting = parseUploadModeSetting(env?.[UPLOAD_ENV.mode]);
  if (setting === UPLOAD_MODE.MOCK) return { mode: UPLOAD_MODE.MOCK, backendConfig: null, cloudName: null, configError: null };
  if (setting === UPLOAD_MODE.INVALID) return invalid([INVALID_UPLOAD_MODE_MESSAGE], [UPLOAD_ENV.mode]);

  const problems = [];
  const missing = [];
  const backendConfig = readBackendConfig(env);
  if (backendConfig.mode !== BACKEND_MODE.REAL) {
    problems.push(
      backendConfig.mode === BACKEND_MODE.INVALID
        ? `Cấu hình Backend sai: ${backendConfig.configError.message}`
        : 'Cần VITE_BACKEND_MODE=real và VITE_API_BASE_URL (Backend localhost).',
    );
    missing.push('VITE_BACKEND_MODE', 'VITE_API_BASE_URL');
  } else {
    let hostname;
    try {
      hostname = new URL(backendConfig.baseUrl).hostname;
    } catch {
      hostname = undefined;
    }
    if (!LOCAL_HOSTS.has(hostname)) {
      problems.push('Giai đoạn phát triển chỉ hỗ trợ Backend localhost (localhost, 127.0.0.1 hoặc [::1]); VITE_API_BASE_URL đang trỏ nơi khác.');
    }
  }
  if (isDev !== true) problems.push('Upload REAL chỉ chạy trong môi trường development (npm run dev), không chạy trong bản build.');
  if (authMode !== 'firebase') {
    problems.push(`Cần Firebase Authentication thật (điền đủ VITE_FIREBASE_*); chế độ xác thực hiện tại là "${String(authMode ?? 'không rõ')}".`);
  } else if (!hasIdToken || !hasObserveAuth) {
    problems.push('Thiếu getIdToken hoặc observeAuthState của Firebase Authentication.');
  }
  const cloudName = readCloudinaryConfig(env).cloudName;
  if (!CLOUD_NAME_PATTERN.test(cloudName)) {
    problems.push('Cần VITE_CLOUDINARY_CLOUD_NAME hợp lệ (chỉ gồm chữ, số, "-" và "_").');
    missing.push('VITE_CLOUDINARY_CLOUD_NAME');
  }
  if (problems.length > 0) return invalid(problems, missing);
  return { mode: UPLOAD_MODE.REAL, backendConfig, cloudName, configError: null };
}

/**
 * @param {Object} [options]
 * @param {Record<string, unknown>} [options.env]  mặc định import.meta.env
 * @param {boolean} [options.isDev]  mặc định import.meta.env.DEV
 * @param {{mode: string, useCases: {getIdToken: Function, observeAuthState: Function}}} [options.authServices]  kết quả createAuthServices()
 * @param {() => object} options.createMockServices  nhà máy dịch vụ MOCK H4A (main.jsx truyền createUploadServices); chỉ được gọi khi mode MOCK
 * @param {typeof fetch} [options.fetchImpl]  chỉ để kiểm thử
 * @param {Object} [options.signedOptions]  chỉ để kiểm thử: { imageProcessor, generateId, uploaderOptions, now } cho createSignedUploadServices
 */
export function createUploadModeServices({
  env = import.meta.env,
  isDev = import.meta.env.DEV === true,
  authServices,
  createMockServices,
  fetchImpl,
  signedOptions = {},
} = {}) {
  const getIdToken = authServices?.useCases?.getIdToken;
  const observeAuthState = authServices?.useCases?.observeAuthState;
  const resolved = resolveUploadConfig({
    env,
    isDev,
    authMode: authServices?.mode,
    hasIdToken: typeof getIdToken === 'function',
    hasObserveAuth: typeof observeAuthState === 'function',
  });

  if (resolved.mode === UPLOAD_MODE.MOCK) {
    if (typeof createMockServices !== 'function') throw new TypeError('createUploadModeServices cần createMockServices (luồng MOCK H4A) cho chế độ MOCK.');
    return createMockServices();
  }
  if (resolved.mode === UPLOAD_MODE.INVALID) {
    return createUnavailableUploadServices(resolved.configError);
  }

  // signedOptions đứng TRƯỚC: không thể ghi đè cấu hình đã được kiểm tra (Backend, cloud name, xác thực).
  const signed = createSignedUploadServices({
    ...signedOptions,
    backendConfig: resolved.backendConfig,
    cloudName: resolved.cloudName,
    getIdToken,
    observeAuthState,
    fetchImpl,
  });
  return Object.freeze({
    mode: UPLOAD_MODE.REAL,
    isMock: false,
    configError: signed.configError,
    notice: null,
    missingProvider: false,
    uploadImage: signed.uploadImage,
    scenarios: NO_SCENARIOS,
    scenario: NO_SCENARIO_CONTROL,
  });
}
