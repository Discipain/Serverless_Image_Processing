// COMPOSITION ROOT (H1) — nơi DUY NHẤT nối Application với Infrastructure cho Authentication.
//
// Chỉ ghép các use case xác thực với MỘT adapter xác thực; KHÔNG khởi tạo adapter ảnh/Storage/Firestore
// (chưa cần ở H1) và KHÔNG phải container tổng quát. Presentation không import file này trực tiếp:
// src/main.jsx gọi createAuthServices() rồi truyền kết quả vào <AuthProvider services={...}> (Dependency Injection).
//
// Chọn chế độ:
//   - 'firebase'      : đủ biến bắt buộc VITE_FIREBASE_* và khởi tạo thành công -> Firebase Authentication thật.
//   - 'mock'          : KHÔNG điền biến VITE_FIREBASE_* nào -> đăng nhập GIẢ LẬP (không có token thật).
//   - 'misconfigured' : ĐÃ điền (một phần) hoặc khởi tạo lỗi -> báo LỖI CẤU HÌNH, KHÔNG âm thầm dùng MOCK.

import {
  createFirebaseAuthRepository,
  createMockAuthRepository,
  createUnavailableAuthRepository,
  firebaseClientState,
} from '../infrastructure/authAdapters';
import {
  createGetIdToken,
  createLoginWithGoogle,
  createLogout,
  createObserveAuthState,
} from '../application/usecases/auth';

export const AUTH_MODE = Object.freeze({
  FIREBASE: 'firebase',
  MOCK: 'mock',
  MISCONFIGURED: 'misconfigured',
});

/**
 * Hàm thuần: từ trạng thái firebaseClient suy ra chế độ. Thông báo KHÔNG chứa giá trị cấu hình (chỉ tên biến).
 * @returns {{mode: string, configError: null | {message: string, missing: string[]}}}
 */
export function resolveAuthMode({ isFirebaseConfigured, hasAnyFirebaseConfig, missingFirebaseConfig, firebaseInitError }) {
  if (isFirebaseConfigured) return { mode: AUTH_MODE.FIREBASE, configError: null };
  if (!hasAnyFirebaseConfig) return { mode: AUTH_MODE.MOCK, configError: null };

  if (missingFirebaseConfig.length > 0) {
    return {
      mode: AUTH_MODE.MISCONFIGURED,
      configError: {
        message: `Cấu hình Firebase chưa đầy đủ: thiếu ${missingFirebaseConfig.join(', ')} trong .env.local. Hãy bổ sung rồi khởi động lại "npm run dev".`,
        missing: [...missingFirebaseConfig],
      },
    };
  }
  return {
    mode: AUTH_MODE.MISCONFIGURED,
    configError: {
      message: firebaseInitError
        ? 'Không khởi tạo được Firebase với cấu hình hiện tại. Hãy kiểm tra lại các biến VITE_FIREBASE_* trong .env.local.'
        : 'Cấu hình Firebase không hợp lệ. Hãy kiểm tra lại các biến VITE_FIREBASE_* trong .env.local.',
      missing: [],
    },
  };
}

/**
 * @param {Object} [options]  (tham số để kiểm thử; ứng dụng gọi createAuthServices() không đối số)
 * @param {Object} [options.client]  trạng thái cấu hình Firebase (mặc định: firebaseClientState thật)
 * @param {Function} [options.createFirebaseRepository]
 * @param {Function} [options.createMockRepository]
 */
export function createAuthServices({
  client = firebaseClientState,
  createFirebaseRepository = createFirebaseAuthRepository,
  createMockRepository = createMockAuthRepository,
} = {}) {
  const { mode, configError } = resolveAuthMode(client);

  let authRepository;
  if (mode === AUTH_MODE.FIREBASE) {
    authRepository = createFirebaseRepository({ auth: client.auth });
  } else if (mode === AUTH_MODE.MOCK) {
    authRepository = createMockRepository();
  } else {
    authRepository = createUnavailableAuthRepository(configError);
  }

  return Object.freeze({
    mode,
    isMock: mode === AUTH_MODE.MOCK,
    configError,
    useCases: Object.freeze({
      observeAuthState: createObserveAuthState({ authRepository }),
      loginWithGoogle: createLoginWithGoogle({ authRepository }),
      logout: createLogout({ authRepository }),
      getIdToken: createGetIdToken({ authRepository }),
    }),
  });
}
