// INFRASTRUCTURE — cài port `cloudinaryUploader` (application/ports.js): upload MỘT Blob WebP lên Cloudinary
// bằng UNSIGNED upload (phương án nhóm đã chốt), trực tiếp từ trình duyệt.
//
//   POST https://api.cloudinary.com/v1_1/{cloud_name}/image/upload   (multipart/form-data)
//   Chỉ gửi ĐÚNG hai trường: `file` (Blob) và `upload_preset`.
//
// KHÔNG gửi: API key/secret, chữ ký, timestamp, Authorization/ID token, `folder`, `asset_folder`, `public_id`.
//   (Chưa có xác nhận của Hưng là preset cho phép tùy chỉnh folder/public_id -> dùng mặc định của preset. Cũng
//   chưa có imageId do Backend cấp nên không đưa vào upload.) Tên file multipart chỉ là nhãn của Blob, không phải public_id.
//
// - XMLHttpRequest (để có tiến độ upload). Có timeout, hủy bằng AbortSignal. KHÔNG tự retry, KHÔNG tự upload lại.
// - Phân loại lỗi qua `error.code` (ERROR_CODE của Application) và `error.details.kind` (UPLOAD_ERROR_KIND).
// - KHÔNG ghi log nào (không console): không lộ Blob, response hay cấu hình.
// - Kết quả CHỈ lấy từ response của Cloudinary; không tự dựng URL/public_id từ tên file.
//
// CHƯA KIỂM CHỨNG VỚI CLOUDINARY THẬT: các bài kiểm thử dùng XMLHttpRequest giả lập.

import { AppError, ERROR_CODE } from '../../application/errors';
import { IMAGE_VARIANTS, MAX_SIZE_BYTES } from '../../domain/constants/imageRules';

export const UPLOAD_ERROR_KIND = Object.freeze({
  CONFIG: 'CONFIG', // thiếu/sai cloud name hoặc preset
  INVALID_INPUT: 'INVALID_INPUT', // Blob/biến thể không hợp lệ (không gửi request)
  NETWORK: 'NETWORK', // mất mạng, bị chặn (CORS, offline)
  TIMEOUT: 'TIMEOUT', // quá thời gian chờ
  CANCELLED: 'CANCELLED', // người dùng hủy (AbortSignal)
  CLOUDINARY_REJECTED: 'CLOUDINARY_REJECTED', // Cloudinary trả HTTP lỗi (preset sai, file bị từ chối, quota...)
  INVALID_RESPONSE: 'INVALID_RESPONSE', // HTTP 2xx nhưng nội dung không dùng được
});

export const DEFAULT_TIMEOUT_MS = 120_000; // mỗi file

const WEBP_TYPE = 'image/webp';
const CLOUD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const MAX_REMOTE_MESSAGE = 200;

function uploadError(code, kind, message, extra = {}) {
  return new AppError(code, message, { kind, ...extra });
}

const cancelledError = () =>
  uploadError(ERROR_CODE.CANCELLED, UPLOAD_ERROR_KIND.CANCELLED, 'Đã hủy upload.');

// Lấy thông điệp lỗi ngắn của Cloudinary ({"error":{"message":"..."}}); không bao giờ ném lỗi.
function readRemoteMessage(text) {
  try {
    const message = JSON.parse(text)?.error?.message;
    return typeof message === 'string' ? message.slice(0, MAX_REMOTE_MESSAGE) : null;
  } catch {
    return null;
  }
}

const isNumber = (value) => typeof value === 'number' && Number.isFinite(value);

/**
 * Kiểm tra response 2xx của Cloudinary và rút ra thông tin cần giữ.
 * Bắt buộc: secure_url (https), public_id, resource_type = 'image'. Các trường còn lại không có thì là null.
 */
function parseAsset(text) {
  const invalid = (reason) =>
    uploadError(
      ERROR_CODE.UPLOAD_FAILED,
      UPLOAD_ERROR_KIND.INVALID_RESPONSE,
      `Cloudinary trả về dữ liệu không hợp lệ (${reason}).`,
    );

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid('không phải JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('không phải đối tượng JSON');

  if (typeof body.secure_url !== 'string' || !body.secure_url.startsWith('https://')) {
    throw invalid('thiếu secure_url https');
  }
  if (typeof body.public_id !== 'string' || body.public_id === '') throw invalid('thiếu public_id');
  if (body.resource_type !== 'image') throw invalid('resource_type không phải image');

  return Object.freeze({
    secureUrl: body.secure_url,
    publicId: body.public_id,
    resourceType: body.resource_type,
    format: typeof body.format === 'string' ? body.format : null,
    bytes: isNumber(body.bytes) ? body.bytes : null,
    width: isNumber(body.width) ? body.width : null,
    height: isNumber(body.height) ? body.height : null,
    assetId: typeof body.asset_id === 'string' ? body.asset_id : null,
  });
}

/**
 * @param {Object} options
 * @param {string} options.cloudName     VITE_CLOUDINARY_CLOUD_NAME
 * @param {string} options.uploadPreset  VITE_CLOUDINARY_UPLOAD_PRESET (UNSIGNED)
 * @param {number} [options.timeoutMs=120000]  thời gian chờ MỖI lần upload
 * @param {() => XMLHttpRequest} [options.createXhr]  điểm tiêm để kiểm thử
 * @param {() => FormData} [options.createFormData]  điểm tiêm để kiểm thử
 * @returns {import('../../application/ports.js').CloudinaryUploader}
 */
export function createCloudinaryUploader({
  cloudName,
  uploadPreset,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createXhr = () => new XMLHttpRequest(),
  createFormData = () => new FormData(),
} = {}) {
  const name = typeof cloudName === 'string' ? cloudName.trim() : '';
  const preset = typeof uploadPreset === 'string' ? uploadPreset.trim() : '';

  // Lỗi cấu hình được báo khi upload (không làm sập ứng dụng lúc khởi tạo).
  const missing = [];
  if (!name) missing.push('VITE_CLOUDINARY_CLOUD_NAME');
  if (!preset) missing.push('VITE_CLOUDINARY_UPLOAD_PRESET');
  let configProblem = null;
  if (missing.length > 0) {
    configProblem = `Thiếu cấu hình Cloudinary: ${missing.join(', ')} (điền trong .env.local rồi chạy lại "npm run dev").`;
  } else if (!CLOUD_NAME_PATTERN.test(name)) {
    configProblem = 'VITE_CLOUDINARY_CLOUD_NAME không hợp lệ (chỉ gồm chữ, số, "-" và "_").';
  }

  const endpoint = configProblem
    ? null
    : `https://api.cloudinary.com/v1_1/${encodeURIComponent(name)}/image/upload`;

  function checkInput(blob, variant) {
    const bad = (message) => uploadError(ERROR_CODE.VALIDATION, UPLOAD_ERROR_KIND.INVALID_INPUT, message);
    if (variant !== undefined && !Object.hasOwn(IMAGE_VARIANTS, variant)) {
      return bad(`Tên biến thể "${String(variant)}" không hợp lệ (chỉ: ${Object.keys(IMAGE_VARIANTS).join(', ')}).`);
    }
    const isBlob = typeof Blob === 'function' ? blob instanceof Blob : Boolean(blob);
    if (!isBlob || typeof blob.size !== 'number') return bad('Dữ liệu upload không phải Blob.');
    if (blob.size <= 0) return bad('Blob rỗng (0 byte).');
    if (blob.type !== WEBP_TYPE) return bad(`Chỉ upload Blob ${WEBP_TYPE} (nhận được "${blob.type || 'không rõ'}").`);
    if (blob.size > MAX_SIZE_BYTES) return bad('Blob vượt quá giới hạn 10MB của preset.');
    return null;
  }

  return {
    /**
     * @param {{blob: Blob, variant?: 'thumbnail'|'medium'|'webp', onProgress?: (percent: number) => void, signal?: AbortSignal}} args
     * @returns {Promise<import('../../application/ports.js').CloudinaryAsset>}
     */
    upload({ blob, variant, onProgress, signal } = {}) {
      if (configProblem) {
        return Promise.reject(
          uploadError(ERROR_CODE.CONFIG, UPLOAD_ERROR_KIND.CONFIG, configProblem, { missing }),
        );
      }
      const inputProblem = checkInput(blob, variant);
      if (inputProblem) return Promise.reject(inputProblem);
      if (signal?.aborted) return Promise.reject(cancelledError());

      return new Promise((resolve, reject) => {
        let settled = false;
        let lastPercent = -1;
        const xhr = createXhr();

        const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
        const finish = (fn, value) => {
          if (settled) return;
          settled = true;
          cleanup();
          fn(value);
        };
        // Callback của người dùng không được làm hỏng việc upload.
        const report = (percent) => {
          if (typeof onProgress !== 'function' || percent <= lastPercent) return;
          lastPercent = percent;
          try {
            onProgress(percent);
          } catch {
            // bỏ qua lỗi của callback tiến độ
          }
        };
        function onAbort() {
          try {
            xhr.abort();
          } catch {
            // abort là best-effort
          }
          finish(reject, cancelledError());
        }

        try {
          const form = createFormData();
          form.append('upload_preset', preset);
          form.append('file', blob, IMAGE_VARIANTS[variant]?.fileName ?? 'image.webp');

          xhr.open('POST', endpoint, true);
          xhr.timeout = timeoutMs;
          xhr.withCredentials = false; // không gửi cookie/credential tới Cloudinary

          if (xhr.upload) {
            xhr.upload.onprogress = (event) => {
              if (event?.lengthComputable && event.total > 0) {
                // 100% chỉ báo khi Cloudinary đã phản hồi thành công.
                report(Math.min(99, Math.floor((event.loaded / event.total) * 100)));
              }
            };
          }
          xhr.onload = () => {
            const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
            const status = xhr.status;
            if (status >= 200 && status < 300) {
              try {
                const asset = parseAsset(text);
                report(100);
                finish(resolve, asset);
              } catch (error) {
                finish(reject, error);
              }
              return;
            }
            if (!status) {
              finish(reject, uploadError(ERROR_CODE.NETWORK, UPLOAD_ERROR_KIND.NETWORK, 'Không kết nối được tới Cloudinary. Hãy kiểm tra mạng và thử lại.'));
              return;
            }
            const remoteMessage = readRemoteMessage(text);
            const suffix = remoteMessage ? ` (${remoteMessage})` : '';
            const code = status === 420 || status === 429 ? ERROR_CODE.QUOTA_EXCEEDED : ERROR_CODE.UPLOAD_FAILED;
            finish(
              reject,
              uploadError(code, UPLOAD_ERROR_KIND.CLOUDINARY_REJECTED, `Cloudinary từ chối upload (HTTP ${status})${suffix}.`, {
                httpStatus: status,
                remoteMessage,
              }),
            );
          };
          xhr.onerror = () =>
            finish(reject, uploadError(ERROR_CODE.NETWORK, UPLOAD_ERROR_KIND.NETWORK, 'Lỗi mạng khi upload lên Cloudinary. Hãy kiểm tra kết nối và thử lại.'));
          xhr.ontimeout = () =>
            finish(reject, uploadError(ERROR_CODE.NETWORK, UPLOAD_ERROR_KIND.TIMEOUT, 'Upload lên Cloudinary quá thời gian chờ. Hãy thử lại.'));
          xhr.onabort = () => finish(reject, cancelledError());

          signal?.addEventListener?.('abort', onAbort, { once: true });
          report(0);
          xhr.send(form);
        } catch (error) {
          finish(
            reject,
            uploadError(ERROR_CODE.NETWORK, UPLOAD_ERROR_KIND.NETWORK, 'Không gửi được yêu cầu upload.', { cause: error }),
          );
        }
      });
    },
  };
}
