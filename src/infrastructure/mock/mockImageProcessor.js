// INFRASTRUCTURE / MOCK — BỘ XỬ LÝ ẢNH GIẢ LẬP. KHÔNG nén, KHÔNG giải mã, KHÔNG tạo WebP hợp lệ.
// Chỉ trả về 3 Blob "giả" (dữ liệu vô nghĩa, bắt đầu bằng chuỗi MOCK_MARKER) có dung lượng tỉ lệ với file nguồn,
// để kiểm thử luồng của Application (PENDING -> PROCESSING -> DONE/FAILED) mà không cần trình duyệt thật.
// Kết quả KHÔNG hiển thị được như ảnh. Trình nén thật là browserImageProcessor (Bước E3).
// Không dùng kết quả của file này làm bằng chứng rằng việc nén/WebP đã hoạt động.

import { ERROR_REASON } from '../../domain/constants/imageStatus';

export const MOCK_MARKER = 'MOCK-NOT-A-REAL-WEBP';

// Tỉ lệ dung lượng giả so với file gốc (chỉ để số liệu "tiết kiệm" trông hợp lý, không đo thật).
const SIZE_RATIO = Object.freeze({ thumbnail: 0.02, medium: 0.08, webp: 0.35 });
const FAKE_WIDTH = 1600;
const FAKE_HEIGHT = 1200;

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function fakeBlob(size) {
  const marker = new TextEncoder().encode(MOCK_MARKER);
  const bytes = new Uint8Array(Math.max(size, marker.length)); // phần còn lại là số 0
  bytes.set(marker);
  // Cố ý KHÔNG đặt type 'image/webp' vì đây không phải WebP.
  return new Blob([bytes], { type: 'application/x-mock-image' });
}

/**
 * @param {Object} [options]
 * @param {number} [options.latencyMs=300]
 * @param {(source: Blob) => (false|true|string)} [options.shouldFail]
 *   true -> lỗi COMPRESS_FAIL; một chuỗi thuộc ERROR_REASON -> lỗi với đúng lý do đó; false -> thành công
 * @returns {import('../../application/ports.js').ImageProcessor}
 */
export function createMockImageProcessor({ latencyMs = 300, shouldFail = () => false } = {}) {
  return {
    async process(source) {
      const startedAt = performance.now();
      await wait(latencyMs);

      if (!source || typeof source.size !== 'number' || !(source.size > 0)) {
        throw Object.assign(new Error('MOCK: file nguồn rỗng hoặc không hợp lệ.'), {
          errorReason: ERROR_REASON.INVALID_IMAGE,
        });
      }

      const failure = shouldFail(source);
      if (failure) {
        const errorReason = Object.values(ERROR_REASON).includes(failure)
          ? failure
          : ERROR_REASON.COMPRESS_FAIL;
        throw Object.assign(new Error('MOCK: nén ảnh thất bại (lỗi giả lập).'), { errorReason });
      }

      return {
        blobs: {
          thumbnail: fakeBlob(Math.round(source.size * SIZE_RATIO.thumbnail)),
          medium: fakeBlob(Math.round(source.size * SIZE_RATIO.medium)),
          webp: fakeBlob(Math.round(source.size * SIZE_RATIO.webp)),
        },
        width: FAKE_WIDTH,
        height: FAKE_HEIGHT,
        processingMs: Math.max(0, Math.round(performance.now() - startedAt)),
        isMock: true, // đánh dấu để không ai nhầm với kết quả nén thật
      };
    },
  };
}
