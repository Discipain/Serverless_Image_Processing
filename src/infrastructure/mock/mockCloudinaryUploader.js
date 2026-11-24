// INFRASTRUCTURE / MOCK — Cloudinary uploader GIẢ. KHÔNG phải upload thật.
//
// - KHÔNG gọi mạng, KHÔNG dùng XMLHttpRequest/fetch, KHÔNG gọi Cloudinary, KHÔNG tạo ảnh trên Cloudinary.
// - Cùng interface với uploader thật (port `cloudinaryUploader`, application/ports.js):
//   upload({ blob, variant, onProgress, signal }) -> Promise<CloudinaryAsset>, cùng quy tắc đầu vào (Blob image/webp,
//   không rỗng, <= 10MB, tên biến thể hợp lệ) và cùng cách báo lỗi (code + details.kind), nên Application/giao diện
//   xử lý như nhau. Không import uploader thật (cố ý, để chắc chắn MOCK không chạm tới mã upload thật).
// - Asset trả về là DỮ LIỆU GIẢ: URL dạng https://res.cloudinary.com/<mockCloud>/... KHÔNG tồn tại trên Cloudinary.
//   Chỉ dùng để chạy tiếp tới Mock Backend (vốn kiểm tra host res.cloudinary.com). Không được dùng làm src ảnh/liên kết.
// - Tiến độ giả lập (0..100, 100 chỉ khi hoàn tất), hỗ trợ AbortSignal. Không tự retry.
// Chỉ phục vụ phát triển và kiểm thử.

import { AppError, ERROR_CODE } from '../../application/errors';
import { IMAGE_VARIANTS, MAX_SIZE_BYTES } from '../../domain/constants/imageRules';

export const MOCK_UPLOAD_LABEL = 'MOCK';

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());

function mockError(code, kind, message, extra = {}) {
  return new AppError(code, message, { kind, mock: true, ...extra });
}

/**
 * @param {Object} [options]
 * @param {number} [options.latencyMs=600]  tổng thời gian giả lập MỖI file
 * @param {number} [options.steps=5]        số mốc tiến độ
 * @param {string} [options.cloudName]      tên cloud GIẢ dùng trong URL giả
 * @param {(variant: string) => (null|'network'|'timeout'|'rejected')} [options.shouldFail]  quyết định lỗi cho biến thể
 * @returns {import('../../application/ports.js').CloudinaryUploader & {debug: object}}
 */
export function createMockCloudinaryUploader({
  latencyMs = 600,
  steps = 5,
  cloudName = 'mock-cloud-not-real',
  shouldFail = () => null,
} = {}) {
  let counter = 0;
  const attempts = []; // mỗi lần gọi upload (kể cả thất bại): { variant }
  const succeeded = [];

  function checkInput(blob, variant) {
    const bad = (message) => mockError(ERROR_CODE.VALIDATION, 'INVALID_INPUT', message);
    if (variant !== undefined && !Object.hasOwn(IMAGE_VARIANTS, variant)) return bad(`Tên biến thể "${String(variant)}" không hợp lệ.`);
    if (!blob || typeof blob.size !== 'number') return bad('Dữ liệu upload không phải Blob.');
    if (blob.size <= 0) return bad('Blob rỗng (0 byte).');
    if (blob.type !== 'image/webp') return bad(`Chỉ upload Blob image/webp (nhận được "${blob.type || 'không rõ'}").`);
    if (blob.size > MAX_SIZE_BYTES) return bad('Blob vượt quá giới hạn 10MB.');
    return null;
  }

  return {
    async upload({ blob, variant, onProgress, signal } = {}) {
      const problem = checkInput(blob, variant);
      if (problem) throw problem;
      if (signal?.aborted) throw mockError(ERROR_CODE.CANCELLED, 'CANCELLED', 'Đã hủy upload (MOCK).');
      attempts.push({ variant });

      let last = -1;
      const report = (percent) => {
        if (typeof onProgress !== 'function' || percent <= last) return;
        last = percent;
        try {
          onProgress(percent);
        } catch {
          // lỗi của callback tiến độ không làm hỏng upload
        }
      };

      const failure = shouldFail(variant);
      const stepMs = latencyMs / steps;
      report(0);
      for (let i = 1; i <= steps; i += 1) {
        // Lỗi giả lập xảy ra giữa chừng (sau nửa số mốc).
        if (failure && i > Math.ceil(steps / 2)) break;
        await new Promise((resolve, reject) => {
          if (signal?.aborted) return reject(mockError(ERROR_CODE.CANCELLED, 'CANCELLED', 'Đã hủy upload (MOCK).'));
          const onAbort = () => {
            clearTimeout(timer);
            reject(mockError(ERROR_CODE.CANCELLED, 'CANCELLED', 'Đã hủy upload (MOCK).'));
          };
          const timer = setTimeout(() => {
            signal?.removeEventListener?.('abort', onAbort);
            resolve();
          }, stepMs);
          signal?.addEventListener?.('abort', onAbort, { once: true });
        });
        report(Math.min(99, Math.floor((i / steps) * 100)));
      }

      if (failure === 'network') {
        throw mockError(ERROR_CODE.NETWORK, 'NETWORK', 'MOCK: lỗi mạng giả lập khi upload.', { retryable: true });
      }
      if (failure === 'timeout') {
        throw mockError(ERROR_CODE.NETWORK, 'TIMEOUT', 'MOCK: upload giả lập quá thời gian chờ.', { retryable: true });
      }
      if (failure === 'rejected') {
        throw mockError(ERROR_CODE.UPLOAD_FAILED, 'CLOUDINARY_REJECTED', 'MOCK: Cloudinary giả lập từ chối upload (HTTP 400).', { httpStatus: 400 });
      }
      await wait(0);

      counter += 1;
      const fileName = IMAGE_VARIANTS[variant]?.fileName ?? 'image.webp';
      const publicId = `mock-${counter}/${fileName.replace(/\.webp$/, '')}`;
      report(100);
      const asset = Object.freeze({
        secureUrl: `https://res.cloudinary.com/${cloudName}/image/upload/v1/${publicId}.webp`,
        publicId,
        resourceType: 'image',
        format: 'webp',
        bytes: blob.size,
        width: null,
        height: null,
        assetId: `mock-asset-${counter}`,
      });
      succeeded.push({ variant, publicId });
      return asset;
    },

    /** Chỉ để kiểm thử/chẩn đoán, không thuộc port. */
    debug: {
      attempts: () => attempts.map((a) => a.variant),
      succeededCount: () => succeeded.length,
    },
  };
}
