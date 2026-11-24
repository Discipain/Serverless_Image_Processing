// INFRASTRUCTURE / MOCK — KHÔNG gọi Firebase Storage. File nằm trong bộ nhớ, mất khi tải lại trang.
// Cài port `storageRepository` (application/ports.js) để phát triển và kiểm thử.
// KHÔNG phải bằng chứng Storage thật đã hoạt động: không mô phỏng Storage Rules, CORS hay gói Blaze.

import { ERROR_CODE } from '../../application/errors';

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const fail = (code, message) => Object.assign(new Error(message), { code });

const PROGRESS_STEPS = 4;
const FAIL_AT_STEP = 2; // lỗi giả lập xảy ra GIỮA chừng, sau khi đã báo một phần tiến trình

// Ảnh minh họa (SVG) cho đường dẫn của ảnh seed — ảnh seed không có file thật.
function placeholderUrl(path) {
  let hash = 0;
  for (const ch of path) hash = (hash * 31 + ch.charCodeAt(0)) % 100003;
  const hue = Math.round((hash * 137.508) % 360);
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="150">` +
    `<rect width="100%" height="100%" fill="hsl(${hue} 60% 70%)"/>` +
    `<text x="50%" y="50%" font-family="sans-serif" font-size="20" text-anchor="middle" ` +
    `dominant-baseline="middle" fill="#fff">MOCK</text></svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}

/**
 * @param {Object} [options]
 * @param {number} [options.latencyMs=100]   tổng thời gian một lần upload (chia đều cho các bước tiến trình)
 * @param {(path: string) => boolean} [options.shouldFailUpload]  trả true để upload đường dẫn đó thất bại
 * @param {Iterable<string>} [options.seededPaths]  đường dẫn của ảnh seed: getDownloadUrl trả ảnh minh họa
 * @param {(blob: Blob) => string} [options.createObjectURL]
 * @param {(url: string) => void} [options.revokeObjectURL]
 * @returns {import('../../application/ports.js').StorageRepository & { debug: { paths: () => string[], objectUrlCount: () => number } }}
 */
export function createMockStorageRepository({
  latencyMs = 100,
  shouldFailUpload = () => false,
  seededPaths = [],
  createObjectURL = (blob) => URL.createObjectURL(blob),
  revokeObjectURL = (url) => URL.revokeObjectURL(url),
} = {}) {
  const objects = new Map(); // path -> { blob, contentType }
  const objectUrls = new Map(); // path -> blob URL đã cấp (phải thu hồi)
  const seeded = new Set(seededPaths);

  function dropUrl(path) {
    const url = objectUrls.get(path);
    if (url) {
      revokeObjectURL(url);
      objectUrls.delete(path);
    }
  }

  const notFound = (path) => fail(ERROR_CODE.NOT_FOUND, `MOCK: object không tồn tại: ${path}`);

  return {
    async upload({ path, blob, contentType, onProgress }) {
      if (!path || typeof path !== 'string') throw new Error('upload cần path.');
      if (!blob || typeof blob.size !== 'number') throw new Error('upload cần blob có size.');
      const willFail = Boolean(shouldFailUpload(path));

      for (let step = 1; step <= PROGRESS_STEPS; step += 1) {
        await wait(latencyMs / PROGRESS_STEPS);
        if (willFail && step === FAIL_AT_STEP) {
          throw new Error('MOCK: upload thất bại (lỗi giả lập).');
        }
        if (typeof onProgress === 'function') {
          onProgress(Math.round((blob.size * step) / PROGRESS_STEPS), blob.size);
        }
      }

      dropUrl(path); // ghi đè: URL của bản cũ không còn đúng
      objects.set(path, { blob, contentType });
    },

    async getDownloadUrl(path) {
      await wait(latencyMs / PROGRESS_STEPS);
      const stored = objects.get(path);
      if (stored) {
        if (!objectUrls.has(path)) objectUrls.set(path, createObjectURL(stored.blob));
        return objectUrls.get(path);
      }
      if (seeded.has(path)) return placeholderUrl(path);
      throw notFound(path);
    },

    async download(path) {
      await wait(latencyMs / PROGRESS_STEPS);
      const stored = objects.get(path);
      if (!stored) throw notFound(path);
      return stored.blob;
    },

    async remove(path) {
      await wait(latencyMs / PROGRESS_STEPS);
      dropUrl(path); // thu hồi URL để không rò bộ nhớ
      objects.delete(path); // không tồn tại = đã xóa, không ném lỗi
    },

    /** Chỉ để kiểm thử, không thuộc port. */
    debug: {
      paths: () => [...objects.keys()].sort(),
      objectUrlCount: () => objectUrls.size,
    },
  };
}
