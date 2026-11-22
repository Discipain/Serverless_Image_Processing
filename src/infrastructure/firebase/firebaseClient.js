// INFRASTRUCTURE — nơi DUY NHẤT khởi tạo Firebase Web SDK (App, Auth, Firestore, Storage).
// Chỉ các adapter trong src/infrastructure được import file này; Domain/Application/Presentation thì không.
//
// - Cấu hình đọc từ biến môi trường VITE_FIREBASE_* (xem .env.example). Config Firebase Web là thông tin
//   PUBLIC nhưng vẫn không hardcode vào source. Bảo mật dựa vào Firestore/Storage Rules, không dựa vào việc giấu config.
// - Biến BẮT BUỘC (đủ để Auth/Firestore chạy): apiKey, authDomain, projectId. Các biến còn lại (storageBucket,
//   messagingSenderId, appId) là TÙY CHỌN: có thì truyền vào SDK, không có thì bỏ qua. Nhờ đó đăng nhập Google
//   KHÔNG phụ thuộc Storage bucket (Hybrid không dùng Firebase Storage).
// - Không có biến VITE_FIREBASE_* nào -> không khởi tạo gì, auth/db/storage = null, isFirebaseConfigured = false:
//   composition root (src/app/createAuthServices.js) chọn chế độ MOCK.
// - Có điền một phần nhưng thiếu biến bắt buộc, hoặc khởi tạo lỗi -> isFirebaseConfigured = false NHƯNG
//   hasAnyFirebaseConfig = true (hoặc firebaseInitError != null): composition root báo LỖI CẤU HÌNH, không âm thầm
//   rơi về MOCK.
// - Không ghi log config/lỗi ở đây để tránh vô tình lộ thông tin ra console.
// - Các hàm get* chỉ tạo tham chiếu, KHÔNG gọi mạng.
//   Lưu ý: Cloud Storage for Firebase yêu cầu dự án ở gói Blaze và cần Storage Rules; phần Storage (legacy) được
//   giữ nguyên nhưng tạo trong khối try riêng: lỗi Storage không được làm hỏng Auth.

import { getApp, getApps, initializeApp } from 'firebase/app';
import { getAuth } from 'firebase/auth';
import { getFirestore } from 'firebase/firestore';
import { getStorage } from 'firebase/storage';

const env = import.meta.env;

// Khóa cấu hình của Firebase SDK -> tên biến môi trường tương ứng.
const ENV_KEY_BY_CONFIG_KEY = Object.freeze({
  apiKey: 'VITE_FIREBASE_API_KEY',
  authDomain: 'VITE_FIREBASE_AUTH_DOMAIN',
  projectId: 'VITE_FIREBASE_PROJECT_ID',
  storageBucket: 'VITE_FIREBASE_STORAGE_BUCKET',
  messagingSenderId: 'VITE_FIREBASE_MESSAGING_SENDER_ID',
  appId: 'VITE_FIREBASE_APP_ID',
});

// Biến bắt buộc để Auth/Firestore chạy. Các khóa còn lại trong ENV_KEY_BY_CONFIG_KEY là tùy chọn.
const REQUIRED_CONFIG_KEYS = Object.freeze(['apiKey', 'authDomain', 'projectId']);

// Giá trị chỉ gồm khoảng trắng coi như chưa điền.
function readEnv(name) {
  const value = env[name];
  return typeof value === 'string' ? value.trim() : '';
}

const firebaseConfig = Object.fromEntries(
  Object.entries(ENV_KEY_BY_CONFIG_KEY).map(([configKey, envName]) => [configKey, readEnv(envName)]),
);

/** true nếu có ÍT NHẤT MỘT biến VITE_FIREBASE_* được điền (người dùng đã có ý định dùng Firebase thật). */
export const hasAnyFirebaseConfig = Object.values(firebaseConfig).some(Boolean);

/** Tên các biến BẮT BUỘC còn thiếu hoặc rỗng (chỉ tên, không bao giờ là giá trị). */
export const missingFirebaseConfig = REQUIRED_CONFIG_KEYS.filter((configKey) => !firebaseConfig[configKey]).map(
  (configKey) => ENV_KEY_BY_CONFIG_KEY[configKey],
);

// Chỉ truyền cho SDK những khóa đã điền (khóa tùy chọn còn trống thì bỏ hẳn, không truyền chuỗi rỗng).
const sdkConfig = Object.fromEntries(Object.entries(firebaseConfig).filter(([, value]) => value));

let app = null;
let authInstance = null;
let dbInstance = null;
let storageInstance = null;
let initError = null;

if (missingFirebaseConfig.length === 0) {
  try {
    // Dùng lại app mặc định nếu đã có (hot-reload của Vite chạy lại module này).
    const created = getApps().length > 0 ? getApp() : initializeApp(sdkConfig);
    // Auth + Firestore: hoặc có đủ hai dịch vụ, hoặc không có gì (tránh trạng thái nửa chừng).
    const auth = getAuth(created);
    const db = getFirestore(created);
    app = created;
    authInstance = auth;
    dbInstance = db;
  } catch (error) {
    initError = error;
  }

  // Storage (legacy, chưa dùng trong H1) tạo riêng: thiếu bucket hoặc lỗi ở đây KHÔNG được chặn đăng nhập.
  if (app) {
    try {
      storageInstance = getStorage(app);
    } catch {
      storageInstance = null;
    }
  }
}

export const auth = authInstance;
export const db = dbInstance;
export const storage = storageInstance;

/** true khi đủ config bắt buộc VÀ khởi tạo Auth/Firestore thành công. */
export const isFirebaseConfigured = app !== null;

/** Lỗi khởi tạo bất ngờ (nếu có). Chỉ dùng để hiển thị chẩn đoán, không chứa giá trị config. */
export const firebaseInitError = initError;

export default app;
