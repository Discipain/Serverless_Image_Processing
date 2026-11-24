// INFRASTRUCTURE — uploader Cloudinary CÓ CHỮ KÝ (H4B-4): upload MỘT Blob WebP bằng các tham số do BACKEND đã ký.
//
//   POST https://api.cloudinary.com/v1_1/{cloud_name}/image/upload   (multipart/form-data)
//   Gửi ĐÚNG: tám trường Backend cấp (public_id, timestamp, overwrite, allowed_formats, context, tags, api_key, signature)
//   NGUYÊN VĂN + `file`. Không gì khác.
//
// KHÔNG BAO GIỜ: gửi `upload_preset` (không dùng unsigned preset), gửi Firebase Bearer/Authorization, tự đặt/đổi public_id,
// overwrite, context, tags, timestamp, ký bằng secret (Frontend không có secret), ghi log, tự retry hay xóa asset.
// Tiến độ/timeout/hủy/phân loại lỗi HTTP dùng chung với uploader unsigned qua ./xhrUpload.js.
//
// Response của Cloudinary chỉ để KIỂM TRA SỚM phía trình duyệt; Backend vẫn xác minh lại bằng Admin API khi confirm.
// Mọi giá trị thiếu hoặc lệch (public_id, resource_type, type, format, bytes, width, height, version, secure_url, asset_id) => lỗi,
// không suy đoán. `existing: true` (overwrite=false và asset đã có sẵn) KHÔNG được coi là upload mới: asset được trả về
// kèm `existing: true` và chỉ được chấp nhận khi toàn bộ số đo khớp đúng Blob vừa nén; bước confirm vẫn bắt buộc.
//
// CHƯA KIỂM CHỨNG VỚI CLOUDINARY THẬT: các bài kiểm thử dùng XMLHttpRequest giả lập.

import { ERROR_CODE } from '../../application/errors';
import { SIGNED_UPLOAD_KIND } from '../../application/signedUploadErrors';
import { IMAGE_VARIANTS, MAX_SIZE_BYTES } from '../../domain/constants/imageRules';
import {
  CLOUD_NAME_PATTERN,
  SIGNED_FIELD_NAMES,
  expectedUploadUrl,
} from '../../domain/models/uploadAuthorization';
import {
  DEFAULT_TIMEOUT_MS,
  UPLOAD_ERROR_KIND,
  cancelledError,
  postMultipart,
  uploadError,
} from './xhrUpload';

export { DEFAULT_TIMEOUT_MS, UPLOAD_ERROR_KIND };

const WEBP_TYPE = 'image/webp';
const ASSET_ID_PATTERN = /^[0-9a-f]{32}$/;
const PUBLIC_ID_SUFFIX = Object.freeze({ thumbnail: 'thumb', medium: 'medium', webp: 'full' });
const SIGNATURE_PROBLEM = /signature|stale|timestamp/i;

const isInt = (value) => Number.isInteger(value);

/** Kiểm tra response 2xx; trả CloudinaryAsset (secureUrl, publicId, ..., existing). Ném AppError khi lệch. */
function parseSignedAsset(text, { fields, expected, cloudName }) {
  const invalid = (reason) =>
    uploadError(ERROR_CODE.UPLOAD_FAILED, UPLOAD_ERROR_KIND.INVALID_RESPONSE, `Cloudinary trả về dữ liệu không hợp lệ (${reason}).`);

  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw invalid('không phải JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw invalid('không phải đối tượng JSON');

  if (body.existing !== undefined && typeof body.existing !== 'boolean') throw invalid('trường existing không phải boolean');
  const existing = body.existing === true;
  const mismatch = (what) =>
    uploadError(
      ERROR_CODE.UPLOAD_FAILED,
      existing ? SIGNED_UPLOAD_KIND.EXISTING_ASSET_MISMATCH : SIGNED_UPLOAD_KIND.UPLOAD_RESPONSE_MISMATCH,
      existing
        ? `Cloudinary báo asset đã tồn tại (existing=true) nhưng ${what}; không dùng asset này.`
        : `Cloudinary trả về ${what}, không khớp ảnh vừa upload.`,
      { retryable: false, newSessionRequired: true, existing },
    );

  if (typeof body.public_id !== 'string' || body.public_id !== fields.public_id) throw mismatch('public_id khác public_id được cấp');
  if (body.resource_type !== 'image') throw mismatch('resource_type không phải image');
  if (body.type !== 'upload') throw mismatch('type không phải upload');
  if (body.format !== 'webp') throw mismatch('format không phải webp');
  if (!isInt(body.bytes) || body.bytes !== expected.bytes) throw mismatch('dung lượng (bytes) khác Blob đã nén');
  if (!isInt(body.width) || !isInt(body.height) || body.width !== expected.width || body.height !== expected.height) {
    throw mismatch('kích thước (width/height) khác biến thể đã khai báo');
  }
  if (!isInt(body.version) || body.version < 1) throw mismatch('version không hợp lệ');
  if (typeof body.asset_id !== 'string' || !ASSET_ID_PATTERN.test(body.asset_id)) throw mismatch('asset_id không hợp lệ');

  let url;
  try {
    url = new URL(body.secure_url);
  } catch {
    throw mismatch('secure_url không hợp lệ');
  }
  const expectedPath = `/${cloudName}/image/upload/v${body.version}/${body.public_id}.webp`;
  if (
    url.protocol !== 'https:' ||
    url.hostname !== 'res.cloudinary.com' ||
    url.port !== '' ||
    url.username !== '' ||
    url.password !== '' ||
    url.search !== '' ||
    url.hash !== '' ||
    url.pathname !== expectedPath
  ) {
    throw mismatch('secure_url không thuộc cloud/asset đã cấp');
  }

  return Object.freeze({
    secureUrl: body.secure_url,
    publicId: body.public_id,
    resourceType: 'image',
    format: 'webp',
    bytes: body.bytes,
    width: body.width,
    height: body.height,
    assetId: body.asset_id,
    version: body.version,
    existing,
  });
}

/**
 * @param {Object} options
 * @param {string} options.cloudName  cloud name PUBLIC (VITE_CLOUDINARY_CLOUD_NAME). KHÔNG nhận upload preset.
 * @param {number} [options.timeoutMs=120000]
 * @param {() => XMLHttpRequest} [options.createXhr]
 * @param {() => FormData} [options.createFormData]
 */
export function createSignedCloudinaryUploader({
  cloudName,
  timeoutMs = DEFAULT_TIMEOUT_MS,
  createXhr = () => new XMLHttpRequest(),
  createFormData = () => new FormData(),
} = {}) {
  const name = typeof cloudName === 'string' ? cloudName.trim() : '';
  const configProblem = CLOUD_NAME_PATTERN.test(name)
    ? null
    : 'Thiếu hoặc sai VITE_CLOUDINARY_CLOUD_NAME (chỉ gồm chữ, số, "-" và "_").';
  const endpoint = configProblem ? null : expectedUploadUrl(name);

  function checkInput({ blob, variant, uploadUrl, fields, expected }) {
    const bad = (message) => uploadError(ERROR_CODE.VALIDATION, UPLOAD_ERROR_KIND.INVALID_INPUT, message, { retryable: false });
    if (!Object.hasOwn(IMAGE_VARIANTS, variant)) {
      return bad(`Tên biến thể "${String(variant)}" không hợp lệ (chỉ: ${Object.keys(IMAGE_VARIANTS).join(', ')}).`);
    }
    if (uploadUrl !== endpoint) return bad('uploadUrl không phải endpoint upload ảnh của cloud đã cấu hình.');
    const keys = fields && typeof fields === 'object' ? Object.keys(fields) : [];
    if (keys.length !== SIGNED_FIELD_NAMES.length || !SIGNED_FIELD_NAMES.every((key) => typeof fields[key] === 'string' && fields[key] !== '')) {
      return bad('Các trường ký do Backend cấp thiếu hoặc thừa (chỉ nhận đúng tám trường đã ký).');
    }
    if (!fields.public_id.endsWith(`/${PUBLIC_ID_SUFFIX[variant]}`)) return bad('public_id không đúng vai trò của biến thể.');
    if (!expected || !isInt(expected.bytes) || !isInt(expected.width) || !isInt(expected.height)) {
      return bad('Thiếu số đo khai báo (bytes/width/height) để đối chiếu response.');
    }
    const isBlob = typeof Blob === 'function' ? blob instanceof Blob : Boolean(blob);
    if (!isBlob || typeof blob.size !== 'number') return bad('Dữ liệu upload không phải Blob.');
    if (blob.size <= 0) return bad('Blob rỗng (0 byte).');
    if (blob.type !== WEBP_TYPE) return bad(`Chỉ upload Blob ${WEBP_TYPE} (nhận được "${blob.type || 'không rõ'}").`);
    if (blob.size > MAX_SIZE_BYTES) return bad('Blob vượt quá giới hạn 10MB.');
    if (blob.size !== expected.bytes) return bad('Dung lượng Blob khác dung lượng đã khai báo khi xin quyền upload.');
    return null;
  }

  return {
    /**
     * @param {Object} args
     * @param {Blob} args.blob
     * @param {'thumbnail'|'medium'|'webp'} args.variant
     * @param {string} args.uploadUrl  do Backend cấp (đã được kiểm tra ở Application và kiểm tra lại ở đây)
     * @param {Record<string, string>} args.fields  đúng tám trường Backend đã ký, gửi NGUYÊN VĂN
     * @param {{bytes: number, width: number, height: number}} args.expected  số đo đã khai báo cho biến thể này
     * @param {(percent: number) => void} [args.onProgress]
     * @param {AbortSignal} [args.signal]
     * @returns {Promise<import('../../application/ports.js').CloudinaryAsset>}
     */
    upload({ blob, variant, uploadUrl, fields, expected, onProgress, signal } = {}) {
      if (configProblem) {
        return Promise.reject(uploadError(ERROR_CODE.CONFIG, UPLOAD_ERROR_KIND.CONFIG, configProblem, { retryable: false }));
      }
      const inputProblem = checkInput({ blob, variant, uploadUrl, fields, expected });
      if (inputProblem) return Promise.reject(inputProblem);
      if (signal?.aborted) return Promise.reject(cancelledError());

      const sent = Object.freeze({ ...fields }); // bản chụp: đổi `fields` sau đó không ảnh hưởng response được kiểm tra
      return postMultipart({
        createXhr,
        endpoint,
        timeoutMs,
        onProgress,
        signal,
        buildForm: () => {
          const form = createFormData();
          for (const key of SIGNED_FIELD_NAMES) form.append(key, sent[key]);
          form.append('file', blob, IMAGE_VARIANTS[variant].fileName); // `file` đặt cuối; tên file chỉ là nhãn, không phải public_id
          return form;
        },
        handleSuccess: (text) => parseSignedAsset(text, { fields: sent, expected, cloudName: name }),
        httpErrorExtra: (status, remoteMessage) =>
          status === 401 || status === 403 || (status === 400 && SIGNATURE_PROBLEM.test(remoteMessage ?? ''))
            ? { kind: SIGNED_UPLOAD_KIND.SIGNATURE_REJECTED, retryable: false }
            : {},
      });
    },
  };
}
