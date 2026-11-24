// INFRASTRUCTURE — kiểm tra tham số và ÁNH XẠ response của Backend (GET /images, GET /images/{id}) sang model Gallery.
//
// Thuần JavaScript: không gọi mạng, không import React/Firebase. Dùng chung cho backendClient (thật) và mockBackendApi (giả),
// nên hai bên cùng một luật kiểm tra.
//
// Nguồn schema: CONTRACT.md mục 4-5 VÀ hành vi thực của Backend (be-clean 842d3f7), vốn trả nguyên tài liệu Firestore:
//   - ảnh Cloudinary : fileName, original{size,width,height}, variants{thumbnail,medium,webp} (URL https), previewUrl, ...
//   - ảnh Google Drive: originalName, sizeBytes, variants/previewUrl là đường dẫn TƯƠNG ĐỐI "/images/preview/<id>"
//                       (cần fetch kèm Bearer, KHÔNG dùng được trong <img src>) -> ánh xạ thành null.
//   - thời gian là chuỗi ISO 8601 có múi giờ ("2026-01-02T03:04:05.123456+00:00").
//
// Nguyên tắc: FAIL-CLOSED. Response sai cấu trúc => lỗi INVALID_RESPONSE, KHÔNG hiển thị một phần, KHÔNG đoán.
// Chỉ giữ các field UI cần; field nội bộ của Backend (assetIds, publicIds, storagePath, pipelineFolders, driveFileId,
// cloudinaryPublicId...) KHÔNG đi vào model.

import { ERROR_CODE } from '../../application/errors';
import { PAGE_SIZE } from '../../domain/constants/imageRules';
import { IMAGE_STATUS } from '../../domain/constants/imageStatus';
import { BACKEND_ERROR_KIND as KIND, backendError } from './backendErrors';

export const GALLERY_LIST_PATH = '/images';
export const MAX_CURSOR_LENGTH = 1024;

// Cùng ký tự với Backend (image_service.py: _CURSOR_CHARS_RE, _CURSOR_IMAGE_ID_RE).
const IMAGE_ID_RE = /^[A-Za-z0-9_-]{1,128}$/;
const CURSOR_RE = /^[A-Za-z0-9_-]+$/;
const MAX_NAME_LENGTH = 255;
const MAX_URL_LENGTH = 2048;
const STATUSES = new Set(Object.values(IMAGE_STATUS));
const PROVIDERS = new Set(['cloudinary', 'google_drive']);
const VARIANT_KEYS = ['thumbnail', 'medium', 'webp'];

const isObject = (v) => v !== null && typeof v === 'object' && !Array.isArray(v);

function invalid(reason) {
  return backendError(ERROR_CODE.UNKNOWN, KIND.INVALID_RESPONSE, `Backend trả về dữ liệu thư viện không hợp lệ (${reason}).`, {
    retryable: false,
  });
}

function badRequest(message) {
  return backendError(ERROR_CODE.VALIDATION, KIND.BAD_REQUEST, message);
}

// ---------- tham số gửi đi (kiểm tra TRƯỚC khi gọi mạng) ----------

/**
 * Chuẩn hóa tham số danh sách. `limit` bỏ trống => không gửi (Backend mặc định 20); có thì phải là số nguyên 1..PAGE_SIZE.
 * `cursor` bỏ trống/null => trang đầu; có thì phải là chuỗi mờ đúng ký tự (nguyên văn `nextCursor` của trang trước).
 * @returns {{limit?: number, cursor?: string}}
 */
export function normalizeListParams({ limit, cursor } = {}) {
  const out = {};
  if (limit !== undefined && limit !== null) {
    if (!Number.isInteger(limit) || limit < 1 || limit > PAGE_SIZE) {
      throw badRequest(`limit phải là số nguyên từ 1 đến ${PAGE_SIZE}.`);
    }
    out.limit = limit;
  }
  if (cursor !== undefined && cursor !== null && cursor !== '') {
    if (typeof cursor !== 'string' || cursor.length > MAX_CURSOR_LENGTH || !CURSOR_RE.test(cursor)) {
      throw badRequest('cursor không hợp lệ (phải là nextCursor nguyên văn của trang trước).');
    }
    out.cursor = cursor;
  }
  return out;
}

/** Đường dẫn + query của GET /images. Dùng URLSearchParams nên không thể chèn tham số lạ (đặc biệt: không có ownerId/uid). */
export function buildListPath(params) {
  const { limit, cursor } = normalizeListParams(params);
  const query = new URLSearchParams();
  if (limit !== undefined) query.set('limit', String(limit));
  if (cursor !== undefined) query.set('cursor', cursor);
  const qs = query.toString();
  return qs ? `${GALLERY_LIST_PATH}?${qs}` : GALLERY_LIST_PATH;
}

/** Đường dẫn GET /images/{imageId}; imageId sai dạng bị chặn trước khi gọi (không thể thoát khỏi đoạn đường dẫn). */
export function buildImagePath(imageId) {
  if (typeof imageId !== 'string' || !IMAGE_ID_RE.test(imageId)) {
    throw badRequest('imageId không hợp lệ.');
  }
  return `${GALLERY_LIST_PATH}/${encodeURIComponent(imageId)}`;
}

// ---------- ánh xạ response ----------

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const nonNegative = (v) => (num(v) !== null && v >= 0 ? v : null);
const str = (v) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : null);

function httpsUrl(v) {
  if (typeof v !== 'string' || v.length > MAX_URL_LENGTH || !v.startsWith('https://')) return null; // "/images/preview/..." => null
  try {
    const u = new URL(v);
    return u.protocol === 'https:' && !u.username && !u.password ? v : null;
  } catch {
    return null;
  }
}

const ISO_RE = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d+))?(Z|[+-]\d{2}:\d{2})$/;

/** Chuỗi ISO 8601 CÓ múi giờ -> Date. Thiếu múi giờ / sai định dạng -> null (không đoán giờ địa phương). */
export function parseIsoTimestamp(value) {
  if (typeof value !== 'string') return null;
  const m = ISO_RE.exec(value);
  if (!m) return null;
  // Tự kiểm tra từng thành phần: Date của V8 KHÔNG từ chối "2026-02-30" mà lặng lẽ đổi thành 02/03.
  const [year, month, day] = m[1].slice(0, 10).split('-').map(Number);
  const [hour, minute, second] = m[1].slice(11).split(':').map(Number);
  const daysInMonth = new Date(Date.UTC(year, month, 0)).getUTCDate();
  if (month < 1 || month > 12 || day < 1 || day > daysInMonth || hour > 23 || minute > 59 || second > 59) return null;
  if (m[3] !== 'Z' && (Number(m[3].slice(1, 3)) > 23 || Number(m[3].slice(4, 6)) > 59)) return null;
  const date = new Date(`${m[1]}.${`${m[2] ?? ''}000`.slice(0, 3)}${m[3]}`); // Backend trả micro giây; JS chỉ giữ mili giây
  return Number.isNaN(date.getTime()) ? null : date;
}

/**
 * Một phần tử Backend -> model Gallery. Chỉ ném lỗi khi thiếu thứ BẮT BUỘC (imageId, status); field tùy chọn sai kiểu -> null.
 * @param {*} raw
 * @param {{isMock?: boolean}} [options]
 * @returns {import('../../application/ports.js').GalleryImage}
 */
export function mapGalleryImage(raw, { isMock = false } = {}) {
  if (!isObject(raw)) throw invalid('phần tử ảnh không phải đối tượng');
  if (typeof raw.imageId !== 'string' || !IMAGE_ID_RE.test(raw.imageId)) throw invalid('imageId thiếu hoặc sai dạng');
  if (typeof raw.status !== 'string' || !STATUSES.has(raw.status)) throw invalid('status không thuộc PENDING/PROCESSING/DONE/FAILED');

  const rawVariants = isObject(raw.variants) ? raw.variants : {};
  const variants = {};
  for (const key of VARIANT_KEYS) variants[key] = httpsUrl(rawVariants[key]);
  const original = isObject(raw.original) ? raw.original : {};

  const name = (str(raw.fileName) ?? str(raw.originalName) ?? raw.imageId).slice(0, MAX_NAME_LENGTH);
  const retryCount = Number.isInteger(raw.retryCount) && raw.retryCount >= 0 ? raw.retryCount : null;

  return Object.freeze({
    imageId: raw.imageId,
    status: raw.status,
    ownerId: str(raw.ownerId),
    provider: PROVIDERS.has(raw.provider) ? raw.provider : null,
    name,
    previewUrl: httpsUrl(raw.previewUrl) ?? variants.thumbnail,
    variants: Object.freeze(variants),
    originalSize: nonNegative(original.size) ?? nonNegative(raw.sizeBytes), // Cloudinary: original.size; Drive: sizeBytes
    width: nonNegative(original.width),
    height: nonNegative(original.height),
    processedSize: nonNegative(raw.processedSize),
    processingMs: nonNegative(raw.processingMs),
    savedPercent: num(raw.savedPercent),
    retryCount,
    errorReason: str(raw.errorReason),
    createdAt: parseIsoTimestamp(raw.createdAt),
    updatedAt: parseIsoTimestamp(raw.updatedAt),
    createdAtEstimated: raw.createdAtEstimated === true,
    isMock,
  });
}

/**
 * Trang danh sách {items, nextCursor, hasMore} -> {items: GalleryImage[], nextCursor, hasMore, isMock}.
 * Chặt: items phải là mảng (không quá `maxItems`), imageId không trùng, nextCursor null hoặc chuỗi cursor hợp lệ,
 * hasMore phải là boolean và KHỚP với nextCursor (hasMore <=> nextCursor khác null).
 */
export function mapGalleryPage(raw, { maxItems = PAGE_SIZE, isMock = false } = {}) {
  if (!isObject(raw)) throw invalid('trang danh sách không phải đối tượng JSON');
  if (!Array.isArray(raw.items)) throw invalid('thiếu mảng items');
  if (raw.items.length > maxItems) throw invalid(`items vượt quá ${maxItems} phần tử đã yêu cầu`);

  const { nextCursor, hasMore } = raw;
  if (nextCursor !== null && (typeof nextCursor !== 'string' || nextCursor.length > MAX_CURSOR_LENGTH || !CURSOR_RE.test(nextCursor))) {
    throw invalid('nextCursor phải là null hoặc chuỗi cursor hợp lệ');
  }
  if (typeof hasMore !== 'boolean') throw invalid('hasMore phải là boolean');
  if (hasMore !== (nextCursor !== null)) throw invalid('hasMore không khớp với nextCursor');

  const items = raw.items.map((item) => mapGalleryImage(item, { isMock }));
  if (new Set(items.map((i) => i.imageId)).size !== items.length) throw invalid('imageId bị trùng trong cùng một trang');
  return Object.freeze({ items: Object.freeze(items), nextCursor, hasMore, isMock });
}

/** Phản hồi GET /images/{id}: đối tượng ảnh có imageId ĐÚNG bằng id đã yêu cầu. */
export function mapGalleryDetail(raw, expectedImageId, { isMock = false } = {}) {
  const image = mapGalleryImage(raw, { isMock });
  if (image.imageId !== expectedImageId) throw invalid('imageId không khớp với yêu cầu');
  return image;
}

/** Parse thân response (chuỗi) thành JSON; không phải JSON => INVALID_RESPONSE. */
export function parseJsonBody(text) {
  try {
    return JSON.parse(text);
  } catch {
    throw invalid('không phải JSON');
  }
}
