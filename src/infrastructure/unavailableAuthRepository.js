// INFRASTRUCTURE — cài port `authRepository` cho trường hợp Firebase ĐÃ ĐƯỢC CHỌN (có điền VITE_FIREBASE_*)
// nhưng cấu hình sai hoặc khởi tạo lỗi.
//
// Mục đích: KHÔNG âm thầm rơi về MOCK. Mọi thao tác đăng nhập/lấy token đều báo lỗi CONFIG rõ ràng, và
// listener báo lỗi đó qua `onError` để giao diện hiển thị. Không gọi Firebase, không chứa giá trị cấu hình
// (chỉ nhận thông báo đã được soạn sẵn, vd tên biến còn thiếu).

import { AppError, ERROR_CODE } from '../application/errors';

/**
 * @param {Object} options
 * @param {string} options.message  thông báo cho người dùng (không chứa giá trị cấu hình)
 * @param {string[]} [options.missing]  tên biến môi trường còn thiếu (chỉ tên)
 * @returns {import('../application/ports.js').AuthRepository}
 */
export function createUnavailableAuthRepository({ message, missing = [] }) {
  const fail = () => new AppError(ERROR_CODE.CONFIG, message, { missing, unavailable: true });

  return {
    async signInWithGoogle() {
      throw fail();
    },

    async signOut() {
      // Không có phiên nào để đăng xuất.
    },

    async getIdToken() {
      throw fail();
    },

    onAuthChanged(onChange, onError) {
      let active = true;
      // Báo bất đồng bộ (giống Firebase): chưa có người dùng, kèm lỗi cấu hình.
      Promise.resolve().then(() => {
        if (!active) return;
        onChange(null);
        if (typeof onError === 'function') onError(fail());
      });
      return () => {
        active = false;
      };
    },
  };
}
