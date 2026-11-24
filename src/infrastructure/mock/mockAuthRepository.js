// INFRASTRUCTURE / MOCK — KHÔNG gọi Firebase Authentication.
// Cài port `authRepository` (application/ports.js) bằng đăng nhập GIẢ LẬP.
// Chỉ phục vụ phát triển và kiểm thử: không phải bằng chứng Google Sign-In thật đã hoạt động.

import { AppError, ERROR_CODE } from '../../application/errors';
import { MOCK_USER } from './mockImages';

// Cùng khóa với AuthProvider hiện tại, để phiên MOCK nhất quán khi Bước F chuyển sang dùng adapter này.
const STORAGE_KEY = 'sip.mockUser';

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function defaultSessionStorage() {
  try {
    return globalThis.sessionStorage ?? null;
  } catch {
    return null; // trình duyệt chặn truy cập storage
  }
}

/**
 * @param {Object} [options]
 * @param {number} [options.latencyMs=500]  độ trễ của signInWithGoogle (giữ như đăng nhập MOCK hiện tại)
 * @param {{getItem: Function, setItem: Function, removeItem: Function}|null} [options.storage]  nơi giữ phiên
 * @param {{uid: string, displayName: string, email: string}} [options.user]
 * @returns {import('../../application/ports.js').AuthRepository}
 */
export function createMockAuthRepository({
  latencyMs = 500,
  storage = defaultSessionStorage(),
  user = MOCK_USER,
} = {}) {
  const listeners = new Set();

  function readStored() {
    try {
      const raw = storage?.getItem(STORAGE_KEY);
      const parsed = raw ? JSON.parse(raw) : null;
      return parsed && typeof parsed.uid === 'string' ? parsed : null;
    } catch {
      return null;
    }
  }

  function writeStored(value) {
    try {
      if (value) storage?.setItem(STORAGE_KEY, JSON.stringify(value));
      else storage?.removeItem(STORAGE_KEY);
    } catch {
      // Chỉ mất khả năng khôi phục phiên sau khi tải lại trang.
    }
  }

  let current = readStored();
  const snapshot = () => (current ? { ...current } : null);

  function notify() {
    for (const listener of [...listeners]) {
      if (listeners.has(listener)) listener(snapshot());
    }
  }

  return {
    async signInWithGoogle() {
      await wait(latencyMs);
      current = { ...user };
      writeStored(current);
      notify();
      return snapshot();
    },

    async signOut() {
      current = null;
      writeStored(null);
      notify();
    },

    // MOCK không có Firebase ID token thật và KHÔNG bao giờ tạo token giả.
    async getIdToken() {
      throw new AppError(
        ERROR_CODE.UNAUTHENTICATED,
        'Đang ở chế độ MOCK: không có Firebase ID token thật. Hãy cấu hình Firebase (.env.local) và đăng nhập Google.',
        { mock: true },
      );
    },

    onAuthChanged(onChange) {
      listeners.add(onChange);
      // Giống Firebase: báo trạng thái hiện tại BẤT ĐỒNG BỘ một lần, sau đó mỗi lần có thay đổi.
      Promise.resolve().then(() => {
        if (listeners.has(onChange)) onChange(snapshot());
      });
      return () => {
        listeners.delete(onChange);
      };
    },
  };
}
