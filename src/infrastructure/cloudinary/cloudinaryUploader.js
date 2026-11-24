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
import { DEFAULT_TIMEOUT_MS, UPLOAD_ERROR_KIND, cancelledError, postMultipart, uploadError } from './xhrUpload';

// Vận chuyển XHR (tiến độ, timeout, hủy, phân loại lỗi) dùng CHUNG với uploader có chữ ký: xem ./xhrUpload.js.
export { DEFAULT_TIMEOUT_MS, UPLOAD_ERROR_KIND };

const WEBP_TYPE = 'image/webp';
const CLOUD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

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

      return postMultipart({
        createXhr,
        endpoint,
        timeoutMs,
        onProgress,
        signal,
        buildForm: () => {
          const form = createFormData();
          form.append('upload_preset', preset);
          form.append('file', blob, IMAGE_VARIANTS[variant]?.fileName ?? 'image.webp');
          return form;
        },
        handleSuccess: parseAsset,
      });
    },
  };
}
