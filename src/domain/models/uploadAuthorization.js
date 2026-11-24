// DOMAIN — JavaScript thuần: không import React, Firebase hay lớp khác.
//
// Dựng request và KIỂM TRA response của POST /images/cloudinary/authorize (Backend H4B-2, commit 30318ee).
// Đối chiếu với code Backend thực tế (upload_authorization.py, cloudinary_signing.py), không phải bản thiết kế:
//
//  REQUEST  : { imageId, originalSize, variants: {thumbnail|medium|webp: {bytes, width, height}} }
//             + tùy chọn { fileName, width, height }. Field lạ ở BẤT KỲ cấp nào => Backend trả 400.
//             imageId là UUID v4 chữ thường. Cạnh dài tối đa: thumbnail 200, medium 800, webp 65535. KHÔNG gửi ownerId/UID/public_id/folder.
//  RESPONSE : { imageId, expiresAt (UTC "YYYY-MM-DDTHH:MM:SSZ"), uploadUrl, apiKey,
//               uploads: {variant: {fields: {public_id, timestamp, overwrite, allowed_formats, context, tags, api_key, signature}}} }
//
// Frontend chỉ dùng response để KIỂM TRA SỚM và để gửi nguyên văn lên Cloudinary; Backend vẫn là bên xác minh cuối cùng
// (Admin API, grant, chủ sở hữu...). Frontend không tự ký, không sửa bất kỳ tham số nào Backend đã ký.
// Thông báo lỗi KHÔNG bao giờ chứa giá trị chữ ký/api_key.

import { IMAGE_VARIANTS, MAX_SIZE_BYTES } from '../constants/imageRules';
import { calcVariantSize } from './image';

export const VARIANT_KEYS = Object.freeze(Object.keys(IMAGE_VARIANTS)); // thumbnail, medium, webp

export const UUID_V4_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export const AUTHORIZE_TOP_FIELDS = Object.freeze(['imageId', 'originalSize', 'variants', 'fileName', 'width', 'height']);
export const AUTHORIZE_VARIANT_FIELDS = Object.freeze(['bytes', 'width', 'height']);

/** ĐÚNG tám trường form Backend ký/đính kèm cho mỗi biến thể (thứ tự gửi lên Cloudinary). Không có `file`, `upload_preset`. */
export const SIGNED_FIELD_NAMES = Object.freeze([
  'public_id',
  'timestamp',
  'overwrite',
  'allowed_formats',
  'context',
  'tags',
  'api_key',
  'signature',
]);

export const CLOUDINARY_UPLOAD_HOST = 'api.cloudinary.com';
export const CLOUD_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;

const MAX_DIMENSION = 65535; // cùng giới hạn của Backend
const MAX_FILE_NAME_LENGTH = 255;
// Ký tự Backend từ chối trong fileName: điều khiển, dấu phân cách đường dẫn, ký tự đảo chiều hiển thị.
function hasForbiddenFileNameChar(text) {
  for (const char of text) {
    const code = char.codePointAt(0);
    if (
      code <= 0x1f ||
      code === 0x7f ||
      char === '/' ||
      char === '\\' ||
      code === 0x200e ||
      code === 0x200f ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069)
    ) {
      return true;
    }
  }
  return false;
}
const VARIANT_MAX_SIDE = Object.freeze({
  thumbnail: IMAGE_VARIANTS.thumbnail.maxSize,
  medium: IMAGE_VARIANTS.medium.maxSize,
  webp: MAX_DIMENSION,
});
const PUBLIC_ID_ROLE = Object.freeze({ thumbnail: 'thumb', medium: 'medium', webp: 'full' });
const ENV_PATTERN = '[a-z0-9][a-z0-9-]{0,19}';
const EXPIRES_AT_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;
const API_KEY_PATTERN = /^[A-Za-z0-9_-]{4,64}$/;
const SIGNATURE_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/; // SHA-1 hoặc SHA-256 (hex)
const TIMESTAMP_PATTERN = /^[1-9]\d{8,11}$/;
const SECRET_KEY_PATTERN = /secret/i;

/** Lỗi dữ liệu authorize; `problems` là danh sách thông báo tiếng Việt (không chứa chữ ký/api_key). */
export class UploadAuthorizationError extends Error {
  constructor(problems) {
    super(`Dữ liệu cấp quyền upload không hợp lệ: ${problems.join('; ')}`);
    this.name = 'UploadAuthorizationError';
    this.problems = problems;
  }
}

const isInt = (n, min, max) => Number.isInteger(n) && n >= min && n <= max;

/**
 * fileName gửi cho authorize VÀ confirm phải GIỐNG HỆT nhau (Backend so sánh). Trả chuỗi đã cắt khoảng trắng, hoặc null
 * (=> bỏ field ở cả hai nơi) khi Backend sẽ từ chối: rỗng, quá 255 ký tự, có ký tự điều khiển/phân cách/đảo chiều.
 */
export function normalizeFileName(name) {
  if (typeof name !== 'string') return null;
  const trimmed = name.trim();
  if (trimmed === '' || trimmed.length > MAX_FILE_NAME_LENGTH || hasForbiddenFileNameChar(trimmed)) return null;
  return trimmed;
}

/** Kích thước THẬT của từng biến thể: ưu tiên số đo của bộ xử lý ảnh (stats), nếu không có thì dùng đúng hàm nó dùng (calcVariantSize). */
function variantDimensions(processed, key, problems) {
  const measured = processed?.stats?.variants?.[key];
  if (measured && measured.width !== undefined) {
    return { width: measured.width, height: measured.height };
  }
  const { width, height } = processed ?? {};
  if (!isInt(width, 1, MAX_DIMENSION) || !isInt(height, 1, MAX_DIMENSION)) {
    problems.push('thiếu kích thước ảnh gốc để tính kích thước biến thể');
    return { width: undefined, height: undefined };
  }
  return calcVariantSize(width, height, IMAGE_VARIANTS[key].maxSize);
}

/**
 * @param {Object} input
 * @param {string} input.imageId      UUID v4 chữ thường, do Frontend tạo MỘT lần (không đổi khi thử lại)
 * @param {{size: number}} input.file file GỐC (size bắt buộc)
 * @param {string|null} [input.fileName]  đã qua normalizeFileName (null/undefined => bỏ)
 * @param {{width: number, height: number, blobs: object, stats?: object}} input.processed  kết quả của imageProcessor
 * @returns {{imageId: string, originalSize: number, variants: object, fileName?: string, width: number, height: number}}
 * @throws {UploadAuthorizationError}
 */
export function buildAuthorizePayload({ imageId, file, fileName, processed } = {}) {
  const problems = [];
  if (typeof imageId !== 'string' || !UUID_V4_PATTERN.test(imageId)) problems.push('imageId phải là UUID v4 chữ thường');
  if (!isInt(file?.size, 1, MAX_SIZE_BYTES)) problems.push('originalSize phải là số nguyên từ 1 đến 10MB');

  const { width, height } = processed ?? {};
  if (!isInt(width, 1, MAX_DIMENSION)) problems.push('width ảnh gốc không hợp lệ');
  if (!isInt(height, 1, MAX_DIMENSION)) problems.push('height ảnh gốc không hợp lệ');

  const variants = {};
  for (const key of VARIANT_KEYS) {
    const blob = processed?.blobs?.[key];
    const bytes = blob?.size;
    if (!isInt(bytes, 1, MAX_SIZE_BYTES)) {
      problems.push(`dung lượng thật của biến thể "${key}" phải là số nguyên từ 1 đến 10MB`);
      continue;
    }
    const measured = processed?.stats?.variants?.[key];
    if (measured?.bytes !== undefined && measured.bytes !== bytes) {
      problems.push(`số đo dung lượng của "${key}" không khớp Blob thật`);
      continue;
    }
    const dims = variantDimensions(processed, key, problems);
    if (!isInt(dims.width, 1, MAX_DIMENSION) || !isInt(dims.height, 1, MAX_DIMENSION)) {
      problems.push(`kích thước của biến thể "${key}" không hợp lệ`);
      continue;
    }
    if (Math.max(dims.width, dims.height) > VARIANT_MAX_SIDE[key]) {
      problems.push(`cạnh dài của biến thể "${key}" vượt ${VARIANT_MAX_SIDE[key]}px`);
      continue;
    }
    variants[key] = { bytes, width: dims.width, height: dims.height };
  }

  if (problems.length > 0) throw new UploadAuthorizationError([...new Set(problems)]);

  const payload = { imageId, originalSize: file.size, width, height, variants };
  const name = normalizeFileName(fileName);
  if (name !== null) payload.fileName = name;
  return payload;
}

// ---------------------------------------------------------------------------------------------------------------------

function findSecretKey(value, depth = 0) {
  if (depth > 6 || !value || typeof value !== 'object') return false;
  for (const [key, inner] of Object.entries(value)) {
    if (SECRET_KEY_PATTERN.test(key) || findSecretKey(inner, depth + 1)) return true;
  }
  return false;
}

const sameKeys = (object, expected) => {
  const keys = Object.keys(object);
  return keys.length === expected.length && expected.every((key) => Object.hasOwn(object, key));
};

/** URL upload DUY NHẤT được chấp nhận cho cloud đã cấu hình. */
export const expectedUploadUrl = (cloudName) => `https://${CLOUDINARY_UPLOAD_HOST}/v1_1/${cloudName}/image/upload`;

/**
 * Kiểm tra response authorize. Thiếu/thừa/sai BẤT KỲ thứ gì => ném lỗi (không dùng một phần).
 * @param {unknown} body
 * @param {{expectedImageId: string, cloudName: string, nowMs: number}} context
 * @returns {Readonly<{imageId: string, expiresAt: string, expiresAtMs: number, uploadUrl: string, apiKey: string, environment: string,
 *   uploads: Readonly<Record<string, Readonly<{fields: Readonly<Record<string, string>>}>>>}>}
 * @throws {UploadAuthorizationError}
 */
export function parseAuthorizeResponse(body, { expectedImageId, cloudName, nowMs } = {}) {
  const problems = [];
  const fail = () => {
    throw new UploadAuthorizationError(problems);
  };

  if (!CLOUD_NAME_PATTERN.test(cloudName ?? '')) {
    problems.push('thiếu cloud name hợp lệ ở Frontend để kiểm tra uploadUrl');
    fail();
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    problems.push('response không phải đối tượng JSON');
    fail();
  }
  if (findSecretKey(body)) {
    problems.push('response chứa trường bí mật (không được phép có ở phía trình duyệt)');
    fail();
  }
  if (!sameKeys(body, ['imageId', 'expiresAt', 'uploadUrl', 'apiKey', 'uploads'])) {
    problems.push('response có trường thiếu hoặc ngoài hợp đồng');
    fail();
  }

  if (body.imageId !== expectedImageId) problems.push('imageId không khớp với yêu cầu');

  let expiresAtMs = Number.NaN;
  if (typeof body.expiresAt !== 'string' || !EXPIRES_AT_PATTERN.test(body.expiresAt)) {
    problems.push('expiresAt không đúng định dạng UTC');
  } else {
    expiresAtMs = Date.parse(body.expiresAt);
    if (!Number.isFinite(expiresAtMs)) problems.push('expiresAt không phải ngày giờ hợp lệ');
    else if (expiresAtMs <= nowMs) problems.push('quyền upload đã hết hạn ngay khi nhận');
  }

  if (body.uploadUrl !== expectedUploadUrl(cloudName)) problems.push('uploadUrl không phải endpoint upload ảnh của cloud đã cấu hình');
  if (typeof body.apiKey !== 'string' || !API_KEY_PATTERN.test(body.apiKey)) problems.push('apiKey không hợp lệ');

  const uploads = body.uploads;
  let environment = null;
  const normalized = {};
  if (!uploads || typeof uploads !== 'object' || Array.isArray(uploads) || !sameKeys(uploads, VARIANT_KEYS)) {
    problems.push('uploads phải có đúng 3 biến thể thumbnail, medium, webp');
  } else {
    const publicIdPattern = (key) => new RegExp(`^hybrid/(${ENV_PATTERN})/([^/]+)/${PUBLIC_ID_ROLE[key]}$`);
    for (const key of VARIANT_KEYS) {
      const entry = uploads[key];
      const fields = entry && typeof entry === 'object' ? entry.fields : null;
      if (!entry || typeof entry !== 'object' || !sameKeys(entry, ['fields']) || !fields || typeof fields !== 'object' || !sameKeys(fields, SIGNED_FIELD_NAMES)) {
        problems.push(`biến thể "${key}" thiếu hoặc thừa trường ký`);
        continue;
      }
      if (SIGNED_FIELD_NAMES.some((name) => typeof fields[name] !== 'string')) {
        problems.push(`biến thể "${key}" có trường ký không phải chuỗi`);
        continue;
      }
      const match = publicIdPattern(key).exec(fields.public_id);
      if (!match || match[2] !== expectedImageId) {
        problems.push(`public_id của "${key}" không đúng vai trò biến thể hoặc không thuộc imageId`);
        continue;
      }
      if (environment === null) environment = match[1];
      else if (environment !== match[1]) problems.push('các public_id thuộc môi trường khác nhau');
      if (!TIMESTAMP_PATTERN.test(fields.timestamp)) problems.push(`timestamp của "${key}" không hợp lệ`);
      if (fields.overwrite !== 'false') problems.push(`overwrite của "${key}" phải là false`);
      if (fields.allowed_formats !== 'webp') problems.push(`allowed_formats của "${key}" phải là webp`);
      if (fields.context !== `app=hybrid|imageId=${body.imageId}|variant=${key}`) problems.push(`context của "${key}" không khớp imageId/biến thể`);
      if (fields.tags !== `hybrid,${match[1]}`) problems.push(`tags của "${key}" không khớp môi trường`);
      if (fields.api_key !== body.apiKey) problems.push(`api_key của "${key}" không khớp apiKey`);
      if (!SIGNATURE_PATTERN.test(fields.signature)) problems.push(`signature của "${key}" không phải chuỗi hex hợp lệ`);
      normalized[key] = Object.freeze({ fields: Object.freeze(Object.fromEntries(SIGNED_FIELD_NAMES.map((name) => [name, fields[name]]))) });
    }
  }

  if (problems.length > 0) fail();

  return Object.freeze({
    imageId: body.imageId,
    expiresAt: body.expiresAt,
    expiresAtMs,
    uploadUrl: body.uploadUrl,
    apiKey: body.apiKey,
    environment,
    uploads: Object.freeze(normalized),
  });
}
