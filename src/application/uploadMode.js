// APPLICATION — diễn giải giá trị VITE_UPLOAD_MODE ở MỘT nơi duy nhất. JavaScript thuần: không import React/Firebase/Infrastructure, không đọc import.meta,
// không gọi mạng. Dùng chung cho:
//   - composition root (src/app/createUploadModeServices.js) khi quyết định MOCK / REAL / invalid;
//   - nhánh "thiếu UploadServicesContext.Provider" (src/presentation/hooks/useUploadServices.js).
// Nhờ vậy không có hai chỗ diễn giải cấu hình khác nhau (cùng mẫu với application/galleryMode.js, bài học F1 của Gallery).
//
//   trống / "mock"   -> MOCK (mặc định)
//   "real"           -> Signed Upload THẬT (chỉ khi composition root thấy ĐỦ điều kiện, xem createUploadModeServices.js)
//   giá trị khác     -> 'invalid': lỗi cấu hình, KHÔNG fallback MOCK, KHÔNG fallback unsigned.

import { AppError, ERROR_CODE } from './errors';

export const UPLOAD_ENV = Object.freeze({ mode: 'VITE_UPLOAD_MODE' });
export const UPLOAD_MODE = Object.freeze({ MOCK: 'mock', REAL: 'real', INVALID: 'invalid' });

/**
 * Giá trị thô của VITE_UPLOAD_MODE -> 'mock' | 'real' | 'invalid'.
 * Trống / thiếu / chỉ có khoảng trắng / "mock" (không phân biệt hoa thường) => MOCK. "real" => REAL. Mọi giá trị khác => INVALID.
 */
export function parseUploadModeSetting(value) {
  const raw = (typeof value === 'string' ? value.trim() : '').toLowerCase();
  if (raw === '' || raw === UPLOAD_MODE.MOCK) return UPLOAD_MODE.MOCK;
  if (raw === UPLOAD_MODE.REAL) return UPLOAD_MODE.REAL;
  return UPLOAD_MODE.INVALID;
}

export const INVALID_UPLOAD_MODE_MESSAGE = `${UPLOAD_ENV.mode} không hợp lệ (chỉ nhận "mock" hoặc "real").`;
export const MISSING_UPLOAD_PROVIDER = 'UploadServicesContext.Provider';

const NO_SCENARIOS = Object.freeze([]);
const NO_SCENARIO_CONTROL = Object.freeze({ get: () => 'normal', set: () => {} });

/**
 * Dịch vụ upload "không dùng được": mọi lần upload báo lỗi CONFIG rõ ràng, KHÔNG gọi mạng, KHÔNG MOCK, KHÔNG unsigned.
 * Cùng hình dạng với dịch vụ thật để giao diện không phải rẽ nhánh theo kiểu object.
 */
export function createUnavailableUploadServices({ message, missing = [], missingProvider = false }) {
  return Object.freeze({
    mode: UPLOAD_MODE.INVALID,
    isMock: false,
    configError: Object.freeze({ message, missing: Object.freeze([...missing]) }),
    notice: null,
    missingProvider,
    async uploadImage() {
      throw new AppError(ERROR_CODE.CONFIG, message, { kind: 'CONFIG', retryable: false });
    },
    scenarios: NO_SCENARIOS,
    scenario: NO_SCENARIO_CONTROL,
  });
}

/**
 * Dịch vụ khi KHÔNG có Provider (composition root không chạy), suy ra từ VITE_UPLOAD_MODE:
 *   - MOCK (trống hoặc "mock"): dịch vụ MOCK-CHƯA-NỐI kèm CẢNH BÁO thiếu Provider. Presentation không import composition root nên không tự dựng
 *     được luồng MOCK; trang hiện cảnh báo và việc upload báo lỗi CONFIG (không có request mạng).
 *   - REAL: lỗi cấu hình, KHÔNG MOCK, KHÔNG unsigned, không có đường gọi authorize.
 *   - giá trị lạ: lỗi cấu hình, KHÔNG MOCK.
 */
export function resolveMissingUploadProvider(rawSetting) {
  const setting = parseUploadModeSetting(rawSetting);
  // Trả về CÙNG một đối tượng cho cùng cấu hình: React không được thấy "dịch vụ mới" ở mỗi lần render (sẽ tạo lại controller).
  if (!missingCache.has(setting)) missingCache.set(setting, buildMissingProvider(setting));
  return missingCache.get(setting);
}

const missingCache = new Map();

function buildMissingProvider(setting) {
  if (setting === UPLOAD_MODE.MOCK) {
    const notice = `Trang Upload đang ở chế độ MOCK nhưng ứng dụng thiếu ${MISSING_UPLOAD_PROVIDER} (${UPLOAD_ENV.mode} trống hoặc là "mock"), nên chưa có luồng upload nào để chạy. Không có request nào tới Backend hay Cloudinary. Hãy nối ${MISSING_UPLOAD_PROVIDER} ở composition root (src/main.jsx).`;
    return Object.freeze({
      ...createUnavailableUploadServices({ message: notice, missing: [MISSING_UPLOAD_PROVIDER], missingProvider: true }),
      mode: UPLOAD_MODE.MOCK,
      isMock: true,
      configError: null,
      notice,
    });
  }
  if (setting === UPLOAD_MODE.REAL) {
    return createUnavailableUploadServices({
      message: `Cấu hình yêu cầu Upload REAL (${UPLOAD_ENV.mode}=real) nhưng ứng dụng thiếu ${MISSING_UPLOAD_PROVIDER}, nên không có luồng upload REAL. Upload KHÔNG dùng MOCK hay upload không ký thay thế. Hãy nối ${MISSING_UPLOAD_PROVIDER} ở composition root (src/main.jsx).`,
      missing: [MISSING_UPLOAD_PROVIDER],
      missingProvider: true,
    });
  }
  return createUnavailableUploadServices({
    message: `${INVALID_UPLOAD_MODE_MESSAGE} Ngoài ra ứng dụng thiếu ${MISSING_UPLOAD_PROVIDER}. Upload KHÔNG dùng MOCK thay thế; hãy sửa cấu hình.`,
    missing: [UPLOAD_ENV.mode, MISSING_UPLOAD_PROVIDER],
    missingProvider: true,
  });
}
