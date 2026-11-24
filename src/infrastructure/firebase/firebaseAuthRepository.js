// INFRASTRUCTURE — cài port `authRepository` (application/ports.js) bằng Firebase Authentication.
// Chỉ nơi này (và các adapter Firebase khác) được import Firebase SDK. Application chỉ thấy port.
//
// - Đăng nhập Google bằng popup (signInWithPopup). Người dùng đóng popup -> lỗi code 'CANCELLED',
//   trình duyệt chặn popup -> 'POPUP_BLOCKED'; hai trường hợp này KHÁC lỗi đăng nhập thật.
// - Mọi lỗi SDK đi qua mapFirebaseError: có `code` (ERROR_CODE), `originalCode`, `cause`, thông báo an toàn cho người dùng.
// - Dependency Injection: `auth` bắt buộc (từ firebaseClient hoặc Auth Emulator); `sdk` cho phép thay từng hàm SDK
//   (kiểm thử bằng lỗi tiêm, hoặc thay popup bằng signInWithCredential khi chạy với Auth Emulator).
//
// CHƯA KIỂM CHỨNG VỚI GOOGLE THẬT: popup Google và tài khoản thật chỉ kiểm được trên Firebase Project thật.

import { GoogleAuthProvider, onAuthStateChanged, signInWithPopup, signOut } from 'firebase/auth';
import { AdapterError, mapFirebaseError } from './mapFirebaseError';
import { ERROR_CODE } from '../../application/errors';

function createGoogleProvider() {
  const provider = new GoogleAuthProvider();
  // Luôn cho chọn tài khoản (tránh tự đăng nhập lại bằng tài khoản Google cũ trên máy dùng chung).
  provider.setCustomParameters({ prompt: 'select_account' });
  return provider;
}

/** Firebase User -> AuthUser của Application ({ uid, displayName, email }). */
function toAuthUser(user) {
  if (!user || typeof user.uid !== 'string' || user.uid === '') {
    throw new AdapterError(
      ERROR_CODE.UNKNOWN,
      'Firebase không trả về thông tin người dùng hợp lệ.',
      { service: 'auth', operation: 'toAuthUser' },
    );
  }
  return {
    uid: user.uid,
    displayName: user.displayName ?? null,
    email: user.email ?? null,
  };
}

/**
 * @param {Object} options
 * @param {import('firebase/auth').Auth} options.auth  bắt buộc (null khi Firebase chưa cấu hình -> dùng MOCK)
 * @param {Object} [options.sdk]  thay thế từng hàm SDK để kiểm thử:
 *   { signInWithPopup(auth, provider), signOut(auth), onAuthStateChanged(auth, next, error), createProvider() }
 * @returns {import('../../application/ports.js').AuthRepository}
 */
export function createFirebaseAuthRepository({ auth, sdk = {} } = {}) {
  if (!auth) {
    throw new Error(
      'createFirebaseAuthRepository cần đối tượng auth (Firebase chưa được cấu hình thì hãy dùng adapter MOCK).',
    );
  }
  const impl = {
    signInWithPopup,
    signOut,
    onAuthStateChanged,
    createProvider: createGoogleProvider,
    ...sdk,
  };

  let lastListenerError = null; // lỗi listener gần nhất của repository này

  return {
    async signInWithGoogle() {
      let credential;
      try {
        credential = await impl.signInWithPopup(auth, impl.createProvider());
      } catch (error) {
        throw mapFirebaseError(error, { service: 'auth', operation: 'signInWithGoogle' });
      }
      return toAuthUser(credential?.user ?? auth.currentUser);
    },

    async signOut() {
      try {
        await impl.signOut(auth);
      } catch (error) {
        throw mapFirebaseError(error, { service: 'auth', operation: 'signOut' });
      }
    },

    /**
     * Firebase ID token THẬT của người dùng hiện tại (JWT). Không log, không lưu: chỉ trả về cho nơi gọi.
     * Chưa đăng nhập -> UNAUTHENTICATED. Lỗi SDK được map (thường là NETWORK).
     */
    async getIdToken(forceRefresh = false) {
      const user = auth.currentUser;
      if (!user) {
        throw new AdapterError(
          ERROR_CODE.UNAUTHENTICATED,
          'Chưa đăng nhập nên không có Firebase ID token.',
          { service: 'auth', operation: 'getIdToken' },
        );
      }
      try {
        return await user.getIdToken(forceRefresh === true);
      } catch (error) {
        throw mapFirebaseError(error, { service: 'auth', operation: 'getIdToken' });
      }
    },

    /**
     * Theo dõi trạng thái đăng nhập: onChange(user|null) khi đã biết trạng thái, và mỗi lần đổi.
     * `onError` là THAM SỐ TÙY CHỌN (Application truyền từ H1): lỗi của listener được map và
     * chuyển cho nó. Nếu không có `onError`, lỗi KHÔNG bị biến thành "đã đăng xuất" (trạng thái giữ nguyên) —
     * thông tin lỗi chỉ còn ở `debug.lastListenerError()`.
     */
    onAuthChanged(onChange, onError) {
      if (typeof onChange !== 'function') {
        throw new TypeError('onAuthChanged cần hàm onChange.');
      }
      let active = true;
      const reportError = (error) => {
        if (!active) return;
        const mapped = mapFirebaseError(error, { service: 'auth', operation: 'onAuthChanged' });
        lastListenerError = mapped;
        if (typeof onError === 'function') onError(mapped);
      };

      const stop = impl.onAuthStateChanged(
        auth,
        (user) => {
          if (!active) return;
          let mapped;
          try {
            mapped = user ? toAuthUser(user) : null;
          } catch (error) {
            reportError(error); // dữ liệu người dùng hỏng: báo lỗi, không giả vờ đã đăng xuất
            return;
          }
          onChange(mapped);
        },
        reportError,
      );

      return function unsubscribe() {
        if (!active) return; // gọi nhiều lần an toàn
        active = false;
        if (typeof stop === 'function') stop();
      };
    },

    /** Chỉ để kiểm thử/chẩn đoán, không thuộc port. */
    debug: { lastListenerError: () => lastListenerError },
  };
}
