// INFRASTRUCTURE — "mặt tiền" cho composition root (src/app/createAuthServices.js): gom mọi thứ về xác thực
// mà composition root cần (trạng thái cấu hình Firebase + 3 adapter xác thực) vào MỘT điểm import.
//
// Nhờ vậy src/app không phải import trực tiếp các module nằm trong thư mục infrastructure/firebase/.
// (Quy tắc lint chặn Firebase SDK ngoài Infrastructure đang so khớp theo tên thư mục "firebase", nên import
// đường dẫn đó từ ngoài Infrastructure bị báo lỗi dù không dùng SDK.) File này KHÔNG chứa logic.

import {
  auth,
  firebaseInitError,
  hasAnyFirebaseConfig,
  isFirebaseConfigured,
  missingFirebaseConfig,
} from './firebase/firebaseClient';

export { createFirebaseAuthRepository } from './firebase/firebaseAuthRepository';
export { createMockAuthRepository } from './mock/mockAuthRepository';
export { createUnavailableAuthRepository } from './unavailableAuthRepository';

/** Ảnh chụp trạng thái cấu hình Firebase lúc khởi động (chỉ tên biến thiếu, không chứa giá trị cấu hình). */
export const firebaseClientState = Object.freeze({
  auth,
  isFirebaseConfigured,
  hasAnyFirebaseConfig,
  missingFirebaseConfig,
  firebaseInitError,
});
