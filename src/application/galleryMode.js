// APPLICATION — diễn giải giá trị VITE_GALLERY_MODE ở MỘT nơi duy nhất. JavaScript thuần: không import React/Firebase, không đọc import.meta,
// không gọi mạng. Dùng chung cho:
//   - composition root (src/app/createGalleryServices.js) khi quyết định MOCK / REAL / invalid;
//   - nhánh "thiếu GalleryServicesContext.Provider" (src/presentation/hooks/useGalleryServices.js).
// Nhờ vậy không có hai chỗ diễn giải cấu hình khác nhau.

export const GALLERY_ENV = Object.freeze({ mode: 'VITE_GALLERY_MODE' });
export const GALLERY_MODE = Object.freeze({ MOCK: 'mock', REAL: 'real', INVALID: 'invalid' });

/**
 * Giá trị thô của VITE_GALLERY_MODE -> 'mock' | 'real' | 'invalid'.
 * Trống / thiếu / chỉ có khoảng trắng / "mock" (không phân biệt hoa thường) => MOCK. "real" => REAL. Mọi giá trị khác => INVALID.
 */
export function parseGalleryModeSetting(value) {
  const raw = (typeof value === 'string' ? value.trim() : '').toLowerCase();
  if (raw === '' || raw === GALLERY_MODE.MOCK) return GALLERY_MODE.MOCK;
  if (raw === GALLERY_MODE.REAL) return GALLERY_MODE.REAL;
  return GALLERY_MODE.INVALID;
}

export const INVALID_MODE_MESSAGE = `${GALLERY_ENV.mode} không hợp lệ (chỉ nhận "mock" hoặc "real").`;

export const MISSING_PROVIDER = 'GalleryServicesContext.Provider';

// Giá trị cố định (đóng băng) để trả về cùng một đối tượng, tránh tạo mới ở mỗi lần render.
const MISSING_MOCK = Object.freeze({
  mode: GALLERY_MODE.MOCK,
  isMock: true,
  configError: null,
  listPage: null,
  missingProvider: true,
  notice: `Gallery đang dùng dữ liệu MOCK vì ứng dụng thiếu ${MISSING_PROVIDER} (${GALLERY_ENV.mode} trống hoặc là "mock"). Không có request nào tới Backend.`,
});
const MISSING_REAL = Object.freeze({
  mode: GALLERY_MODE.INVALID,
  isMock: false,
  configError: Object.freeze({
    message: `Cấu hình yêu cầu Gallery REAL (${GALLERY_ENV.mode}=real) nhưng ứng dụng thiếu ${MISSING_PROVIDER}, nên không có nguồn dữ liệu REAL. Gallery KHÔNG dùng MOCK thay thế. Hãy nối ${MISSING_PROVIDER} ở composition root (src/main.jsx).`,
    missing: Object.freeze([MISSING_PROVIDER]),
  }),
  listPage: null,
  missingProvider: true,
});
const MISSING_INVALID = Object.freeze({
  mode: GALLERY_MODE.INVALID,
  isMock: false,
  configError: Object.freeze({
    message: `${INVALID_MODE_MESSAGE} Ngoài ra ứng dụng thiếu ${MISSING_PROVIDER}. Gallery KHÔNG dùng MOCK thay thế; hãy sửa cấu hình.`,
    missing: Object.freeze([GALLERY_ENV.mode, MISSING_PROVIDER]),
  }),
  listPage: null,
  missingProvider: true,
});

/**
 * Nguồn dữ liệu Gallery khi KHÔNG có Provider (composition root không chạy), suy ra từ giá trị VITE_GALLERY_MODE:
 *   - MOCK (trống hoặc "mock"): giữ MOCK để tương thích H1, đánh dấu `missingProvider` để giao diện NÓI RÕ đang dùng MOCK vì thiếu Provider.
 *   - REAL: lỗi cấu hình (mode 'invalid'), KHÔNG MOCK, không listPage => không có đường gọi Backend.
 *   - giá trị lạ: lỗi cấu hình, KHÔNG MOCK.
 * Không tự tạo Provider hay dịch vụ mới; không gọi mạng.
 */
export function resolveMissingProviderServices(rawSetting) {
  const setting = parseGalleryModeSetting(rawSetting);
  if (setting === GALLERY_MODE.MOCK) return MISSING_MOCK;
  if (setting === GALLERY_MODE.REAL) return MISSING_REAL;
  return MISSING_INVALID;
}
