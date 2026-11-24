// INFRASTRUCTURE / MOCK — ghép 5 adapter giả lập thành một bộ để đưa vào createUseCases(adapters).
// Mỗi lần gọi tạo ra KHO DỮ LIỆU RIÊNG (nên các bài kiểm thử độc lập nhau).
// Chỉ phục vụ phát triển/kiểm thử, KHÔNG phải bằng chứng Firebase thật đã hoạt động.
//
// Dùng (Bước F, tại composition root):
//   const adapters = isFirebaseConfigured ? createFirebaseAdapters() : createMockAdapters({ getScenario });
//   const useCases = createUseCases(adapters);

import { ERROR_REASON } from '../domain/constants/imageStatus';
import { IMAGE_VARIANTS } from '../domain/constants/imageRules';
import { generateId } from './generateId';
import { MOCK_IMAGES } from './mock/mockImages';
import { createMockAuthRepository } from './mock/mockAuthRepository';
import { createMockImageRepository } from './mock/mockImageRepository';
import { createMockStorageRepository } from './mock/mockStorageRepository';
import { createMockImageProcessor } from './mock/mockImageProcessor';

/**
 * Kịch bản MOCK (ví dụ chọn qua ?mock=... ở Bước F):
 *  - empty / error        : gallery trả danh sách rỗng / lỗi (giữ hành vi MOCK hiện có)
 *  - upload-fail-once     : lần upload ĐẦU TIÊN lỗi ở file medium.webp (ảnh gốc đã up, biến thể bị dọn);
 *                           lần retry sau thành công
 *  - compress-fail-once   : lần nén ĐẦU TIÊN lỗi (COMPRESS_FAIL); lần retry sau thành công
 * Các kịch bản "once" được nạp lại mỗi khi giá trị kịch bản thay đổi.
 */
export const MOCK_SCENARIOS = Object.freeze({
  NORMAL: 'normal',
  EMPTY: 'empty',
  ERROR: 'error',
  UPLOAD_FAIL_ONCE: 'upload-fail-once',
  COMPRESS_FAIL_ONCE: 'compress-fail-once',
});

/**
 * @param {Object} [options]
 * @param {() => string} [options.getScenario]  đọc LÚC GỌI (không đọc một lần), nên đổi kịch bản không cần tạo lại adapter
 * @param {number} [options.latencyMs]  nếu truyền: dùng cho MỌI adapter (kiểm thử đặt 0); bỏ trống: độ trễ mặc định từng adapter
 * @param {import('../application/ports.js').ImageProcessor} [options.imageProcessor]  thay bộ xử lý giả (vd bản thật ở E3)
 * @param {Array} [options.seed]  dữ liệu khởi tạo cho kho metadata
 * @returns {import('../application/ports.js').Adapters}
 */
export function createMockAdapters({
  getScenario = () => MOCK_SCENARIOS.NORMAL,
  latencyMs,
  imageProcessor,
  seed = MOCK_IMAGES,
} = {}) {
  const spent = { upload: false, compress: false };
  let lastScenario = null;

  // Mọi adapter đọc kịch bản qua hàm này: khi giá trị đổi thì các kịch bản "once" được nạp lại.
  function readScenario() {
    const current = getScenario();
    if (current !== lastScenario) {
      lastScenario = current;
      spent.upload = false;
      spent.compress = false;
    }
    return current;
  }

  const withLatency = (value) => (latencyMs === undefined ? {} : { [value]: latencyMs });

  const authRepository = createMockAuthRepository({ ...withLatency('latencyMs') });

  const imageRepository = createMockImageRepository({
    seed,
    getListMode: () => {
      const scenario = readScenario();
      if (scenario === MOCK_SCENARIOS.EMPTY) return 'empty';
      if (scenario === MOCK_SCENARIOS.ERROR) return 'error';
      return 'normal';
    },
    ...(latencyMs === undefined ? {} : { latencyMs, listLatencyMs: latencyMs }),
  });

  const storageRepository = createMockStorageRepository({
    ...withLatency('latencyMs'),
    // Ảnh seed không có file thật: chỉ biến thể (processed/...) có ảnh minh họa; ảnh gốc thì không (nên không retry được).
    seededPaths: seed.flatMap((doc) => (doc.variants ? Object.values(doc.variants) : [])),
    shouldFailUpload: (path) => {
      if (
        readScenario() === MOCK_SCENARIOS.UPLOAD_FAIL_ONCE &&
        !spent.upload &&
        path.endsWith(`/${IMAGE_VARIANTS.medium.fileName}`)
      ) {
        spent.upload = true;
        return true;
      }
      return false;
    },
  });

  return {
    authRepository,
    imageRepository,
    storageRepository,
    imageProcessor:
      imageProcessor ??
      createMockImageProcessor({
        ...withLatency('latencyMs'),
        shouldFail: () => {
          if (readScenario() === MOCK_SCENARIOS.COMPRESS_FAIL_ONCE && !spent.compress) {
            spent.compress = true;
            return ERROR_REASON.COMPRESS_FAIL;
          }
          return false;
        },
      }),
    generateId,
  };
}
