// COMPOSITION ROOT (H4A) — ghép luồng upload Hybrid bằng adapter MOCK.
//
//   Validate -> imageId -> Nén 3 WebP (THẬT, chạy cục bộ trong trình duyệt) -> Upload GIẢ -> Confirm GIẢ -> hiển thị.
//
// AN TOÀN MẠNG — file này CỐ Ý KHÔNG import và KHÔNG tạo:
//   - cloudinaryUploader / createCloudinaryServices (upload Cloudinary thật, XMLHttpRequest),
//   - backendClient / createBackendServices (fetch tới FastAPI thật, ID token thật),
//   - bất kỳ thứ gì của Firebase/Firestore.
//   Nó cũng KHÔNG đọc VITE_CLOUDINARY_* và không đọc ID token. Vì vậy dù .env.local đã có cấu hình Cloudinary hay
//   VITE_BACKEND_MODE=real, luồng này vẫn chỉ dùng MOCK (không có đường nào để "tự chuyển thành REAL", cũng không có
//   đường fallback REAL -> MOCK). Chế độ thật là việc của H3B/H4B và phải được nối tường minh ở nơi khác.
//   `mode` khác 'mock' bị từ chối ngay.
// Nén ảnh dùng browserImageProcessor THẬT nhưng chỉ xử lý trong bộ nhớ trình duyệt, không gửi đi đâu.

import { createUploadImageHybrid } from '../application/usecases/uploadImageHybrid';
import { createUploadVariantsToCloudinary } from '../application/usecases/uploadVariantsToCloudinary';
import { createConfirmCloudinaryUpload } from '../application/usecases/confirmCloudinaryUpload';
import { createMockCloudinaryUploader } from '../infrastructure/mock/mockCloudinaryUploader';
import { createMockBackendApi, MOCK_BACKEND_SCENARIOS as BACKEND } from '../infrastructure/mock/mockBackendApi';
import { readBackendConfig, BACKEND_MODE } from '../infrastructure/api/backendConfig';
import { browserImageProcessor } from '../infrastructure/image-processing/browserImageProcessor';
import { generateId as defaultGenerateId } from '../infrastructure/generateId';

/** Kịch bản MOCK chọn qua ?mock=... trên trang Upload. Các kịch bản "once" lỗi lần đầu, lần thử lại thành công. */
export const UPLOAD_MOCK_SCENARIOS = Object.freeze({
  NORMAL: 'normal',
  UPLOAD_FAIL_ONCE: 'upload-fail-once',
  UPLOAD_NETWORK: 'upload-network',
  CONFIRM_FAIL_ONCE: 'confirm-fail-once',
  CONFIRM_UNAUTHENTICATED: 'confirm-unauthenticated',
  CONFIRM_FORBIDDEN: 'confirm-forbidden',
  CONFIRM_SERVER_ERROR: 'confirm-server-error',
  CONFIRM_INVALID_RESPONSE: 'confirm-invalid-response',
});

const SCENARIO_LABELS = Object.freeze({
  [UPLOAD_MOCK_SCENARIOS.NORMAL]: 'Bình thường',
  [UPLOAD_MOCK_SCENARIOS.UPLOAD_FAIL_ONCE]: 'Upload lỗi 1 lần',
  [UPLOAD_MOCK_SCENARIOS.UPLOAD_NETWORK]: 'Upload lỗi mạng',
  [UPLOAD_MOCK_SCENARIOS.CONFIRM_FAIL_ONCE]: 'Confirm lỗi 1 lần',
  [UPLOAD_MOCK_SCENARIOS.CONFIRM_UNAUTHENTICATED]: 'Confirm 401',
  [UPLOAD_MOCK_SCENARIOS.CONFIRM_FORBIDDEN]: 'Confirm 403',
  [UPLOAD_MOCK_SCENARIOS.CONFIRM_SERVER_ERROR]: 'Confirm lỗi máy chủ',
  [UPLOAD_MOCK_SCENARIOS.CONFIRM_INVALID_RESPONSE]: 'Confirm phản hồi sai',
});

const KNOWN = new Set(Object.values(UPLOAD_MOCK_SCENARIOS));

/**
 * @param {Object} [options]  (ứng dụng gọi không đối số; tham số chỉ để kiểm thử)
 * @param {'mock'} [options.mode='mock']  chỉ hỗ trợ 'mock' trong H4A
 * @param {import('../application/ports.js').ImageProcessor} [options.imageProcessor]
 * @param {() => string} [options.generateId]
 * @param {number} [options.latencyMs]  nếu truyền: độ trễ của MỌI adapter giả (kiểm thử đặt 0)
 */
export function createUploadServices({
  mode = 'mock',
  imageProcessor = browserImageProcessor,
  generateId = defaultGenerateId,
  latencyMs,
} = {}) {
  if (mode !== 'mock') {
    throw new Error('createUploadServices (H4A) chỉ hỗ trợ mode "mock". Chế độ thật thuộc H3B/H4B và chưa được nối.');
  }

  // Trạng thái kịch bản: các kịch bản "once" được nạp lại mỗi khi đổi kịch bản.
  const state = { value: UPLOAD_MOCK_SCENARIOS.NORMAL, last: null, spentUpload: false, spentConfirm: false };
  const read = () => {
    if (state.value !== state.last) {
      state.last = state.value;
      state.spentUpload = false;
      state.spentConfirm = false;
    }
    return state.value;
  };

  const S = UPLOAD_MOCK_SCENARIOS;
  const mockUploader = createMockCloudinaryUploader({
    ...(latencyMs === undefined ? {} : { latencyMs }),
    shouldFail: (variant) => {
      const scenario = read();
      if (variant !== 'medium') return null; // thumbnail đã "lên" trước, medium lỗi => minh họa ảnh mồ côi giả lập
      if (scenario === S.UPLOAD_NETWORK) return 'network';
      if (scenario === S.UPLOAD_FAIL_ONCE && !state.spentUpload) {
        state.spentUpload = true;
        return 'network';
      }
      return null;
    },
  });

  const mockBackend = createMockBackendApi({
    ...(latencyMs === undefined ? {} : { latencyMs }),
    getScenario: () => {
      const scenario = read();
      if (scenario === S.CONFIRM_FAIL_ONCE && !state.spentConfirm) {
        state.spentConfirm = true;
        return BACKEND.NETWORK;
      }
      if (scenario === S.CONFIRM_UNAUTHENTICATED) return BACKEND.UNAUTHENTICATED;
      if (scenario === S.CONFIRM_FORBIDDEN) return BACKEND.FORBIDDEN;
      if (scenario === S.CONFIRM_SERVER_ERROR) return BACKEND.SERVER_ERROR;
      if (scenario === S.CONFIRM_INVALID_RESPONSE) return BACKEND.INVALID_RESPONSE;
      return BACKEND.SUCCESS;
    },
  });

  const uploadImage = createUploadImageHybrid({
    imageProcessor,
    uploadVariantsToCloudinary: createUploadVariantsToCloudinary({ cloudinaryUploader: mockUploader }),
    confirmCloudinaryUpload: createConfirmCloudinaryUpload({ backendApi: mockBackend }),
    generateId,
  });

  // Nhắc người dùng nếu .env.local chọn Backend thật: trang này VẪN chỉ dùng MOCK (không gọi gì ra ngoài).
  // readBackendConfig chỉ đọc biến môi trường, không gọi mạng.
  const backendConfig = readBackendConfig();
  const notice =
    backendConfig.mode === BACKEND_MODE.MOCK
      ? null
      : 'Cấu hình Backend trong .env.local đang chọn chế độ thật, nhưng trang Upload ở bước H4A LUÔN dùng MOCK và không gọi Backend/Cloudinary thật.';

  return Object.freeze({
    mode: 'mock',
    isMock: true,
    notice,
    uploadImage,
    scenarios: Object.freeze(Object.values(S).map((value) => Object.freeze({ value, label: SCENARIO_LABELS[value] }))),
    scenario: Object.freeze({
      get: () => state.value,
      set: (value) => {
        state.value = KNOWN.has(value) ? value : S.NORMAL;
      },
    }),
    /** Chỉ để kiểm thử/chẩn đoán. */
    debug: Object.freeze({
      uploadAttempts: () => mockUploader.debug.attempts(),
      uploadsSucceeded: () => mockUploader.debug.succeededCount(),
      confirmAttempts: (imageId) => mockBackend.debug.attemptsFor(imageId),
      storedCount: () => mockBackend.debug.storedCount(),
    }),
  });
}
