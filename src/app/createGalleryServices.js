// COMPOSITION ROOT (INT-3B) — chọn nguồn dữ liệu Gallery: MOCK (mặc định) hoặc REAL (Backend localhost, tường minh).
//
//   VITE_GALLERY_MODE trống / "mock"  -> MOCK. Mọi biến khác (VITE_BACKEND_MODE, VITE_API_BASE_URL, VITE_FIREBASE_*,
//                                        VITE_CLOUDINARY_*) bị BỎ QUA: có .env.local đầy đủ cũng KHÔNG tự bật REAL.
//   VITE_GALLERY_MODE=real            -> REAL, nhưng CHỈ khi đồng thời thỏa TẤT CẢ:
//        1. VITE_BACKEND_MODE=real và VITE_API_BASE_URL hợp lệ (readBackendConfig);
//        2. Backend ở localhost (localhost / 127.0.0.1 / [::1]) — giai đoạn INT-3B chưa hỗ trợ Backend từ xa;
//        3. môi trường development (npm run dev), không phải bản build production;
//        4. Firebase Authentication THẬT (authServices.mode === 'firebase'), có getIdToken.
//      Thiếu một điều kiện => mode 'invalid' kèm configError (liệt kê TÊN biến/điều kiện, không in giá trị).
//   giá trị khác của VITE_GALLERY_MODE  -> 'invalid'.
//
// KHÔNG BAO GIỜ fallback ngầm: 'invalid' không bao giờ trả dữ liệu MOCK. KHÔNG gọi mạng khi khởi tạo (chỉ khi listPage được gọi).
// Dependency Injection: env, isDev, authServices, fetchImpl đều truyền được từ test.

import { readBackendConfig, BACKEND_MODE } from '../infrastructure/api/backendConfig';
import { createBackendServices } from './createBackendServices';

import { GALLERY_ENV, GALLERY_MODE, INVALID_MODE_MESSAGE, parseGalleryModeSetting } from '../application/galleryMode';

// Cách diễn giải VITE_GALLERY_MODE nằm ở application/galleryMode.js và được dùng chung với nhánh "thiếu Provider".
export { GALLERY_ENV, GALLERY_MODE };

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]']);

const invalid = (problems, missing = []) => ({
  mode: GALLERY_MODE.INVALID,
  backendConfig: null,
  configError: {
    message: `Gallery REAL chưa dùng được: ${problems.join(' ')} Hãy sửa cấu hình rồi khởi động lại "npm run dev", hoặc bỏ ${GALLERY_ENV.mode} để dùng MOCK.`,
    missing,
  },
});

/**
 * Hàm thuần: quyết định chế độ Gallery. Không gọi mạng, không đọc import.meta.
 * @param {{env: Record<string, unknown>, isDev: boolean, authMode?: string, hasIdToken?: boolean}} input
 * @returns {{mode: 'mock'|'real'|'invalid', backendConfig: object|null, configError: null|{message: string, missing: string[]}}}
 */
export function resolveGalleryConfig({ env, isDev, authMode, hasIdToken }) {
  const setting = parseGalleryModeSetting(env?.[GALLERY_ENV.mode]);
  if (setting === GALLERY_MODE.MOCK) return { mode: GALLERY_MODE.MOCK, backendConfig: null, configError: null };
  if (setting === GALLERY_MODE.INVALID) return invalid([INVALID_MODE_MESSAGE], [GALLERY_ENV.mode]);

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
      problems.push('Giai đoạn INT-3B chỉ hỗ trợ Backend localhost (localhost, 127.0.0.1 hoặc [::1]); VITE_API_BASE_URL đang trỏ nơi khác.');
    }
  }
  if (isDev !== true) problems.push('Gallery REAL chỉ chạy trong môi trường development (npm run dev), không chạy trong bản build.');
  if (authMode !== 'firebase') {
    problems.push(`Cần Firebase Authentication thật (điền đủ VITE_FIREBASE_*); chế độ xác thực hiện tại là "${String(authMode ?? 'không rõ')}".`);
  } else if (!hasIdToken) {
    problems.push('Thiếu getIdToken của Firebase Authentication.');
  }
  if (problems.length > 0) return invalid(problems, missing);
  return { mode: GALLERY_MODE.REAL, backendConfig, configError: null };
}

/**
 * @param {Object} [options]
 * @param {Record<string, unknown>} [options.env]  mặc định import.meta.env
 * @param {boolean} [options.isDev]  mặc định import.meta.env.DEV
 * @param {{mode: string, useCases: {getIdToken: Function}}} [options.authServices]  kết quả createAuthServices()
 * @param {typeof fetch} [options.fetchImpl]  chỉ để kiểm thử
 */
export function createGalleryServices({
  env = import.meta.env,
  isDev = import.meta.env.DEV === true,
  authServices,
  fetchImpl,
} = {}) {
  const getIdToken = authServices?.useCases?.getIdToken;
  const resolved = resolveGalleryConfig({ env, isDev, authMode: authServices?.mode, hasIdToken: typeof getIdToken === 'function' });

  let listPage = null;
  if (resolved.mode === GALLERY_MODE.REAL) {
    const backend = createBackendServices({ config: resolved.backendConfig, getIdToken, fetchImpl });
    // ownerId (uid đang đăng nhập) chỉ làm `expectedOwnerId` kiểm tra phòng thủ ở client; KHÔNG được gửi lên Backend.
    listPage = ({ ownerId, limit, cursor, signal }) =>
      backend.useCases.listGalleryImages({ limit, cursor, expectedOwnerId: ownerId, signal });
  }

  return Object.freeze({
    mode: resolved.mode,
    isMock: resolved.mode === GALLERY_MODE.MOCK,
    configError: resolved.configError,
    listPage,
  });
}
