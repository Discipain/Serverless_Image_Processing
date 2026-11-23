// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Đọc Gallery từ Backend (GET /images, GET /images/{id}) qua port `backendApi`. CHƯA nối vào giao diện (INT-3A).
//
// Quyền truy cập do BACKEND quyết định từ Firebase ID token. Frontend KHÔNG gửi ownerId/uid để chọn dữ liệu.
// `expectedOwnerId` (tùy chọn, thường là uid đang đăng nhập) CHỈ là kiểm tra phòng thủ thêm ở phía client: nếu Backend lỡ
// trả ảnh có ownerId khác thì coi cả response là không hợp lệ (fail-closed), không hiển thị metadata của người khác.

import { PAGE_SIZE } from '../../domain/constants/imageRules';
import { AppError, ERROR_CODE } from '../errors';
import { clampLimit } from './listUserImages';

// Giá trị trùng BACKEND_ERROR_KIND.INVALID_RESPONSE (Application không import Infrastructure nên ghi lại hằng chuỗi).
const INVALID_RESPONSE_KIND = 'INVALID_RESPONSE';

function foreignOwnerError() {
  return new AppError(
    ERROR_CODE.UNKNOWN,
    'Backend trả về ảnh không thuộc tài khoản đang đăng nhập; dữ liệu đã bị bỏ qua.',
    { kind: INVALID_RESPONSE_KIND, retryable: false },
  );
}

export function assertOwnedBy(images, expectedOwnerId) {
  if (expectedOwnerId === undefined || expectedOwnerId === null) return;
  if (typeof expectedOwnerId !== 'string' || expectedOwnerId === '') {
    throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Cần đăng nhập để xem thư viện ảnh.');
  }
  for (const image of images) {
    if (image.ownerId !== expectedOwnerId) throw foreignOwnerError();
  }
}

/**
 * Một trang ảnh của CHÍNH người dùng (Backend: mới nhất trước). `cursor` = `nextCursor` nguyên văn của trang trước.
 * @returns {(args?: {limit?: number, cursor?: string|null, expectedOwnerId?: string, signal?: AbortSignal}) =>
 *   Promise<{items: import('../ports.js').GalleryImage[], nextCursor: string|null, hasMore: boolean, isMock: boolean}>}
 */
export function createListGalleryImages({ backendApi }) {
  return async function listGalleryImages({ limit, cursor, expectedOwnerId, signal } = {}) {
    const page = await backendApi.listImages(
      { limit: limit === undefined ? PAGE_SIZE : clampLimit(limit), cursor: cursor || undefined },
      { signal },
    );
    assertOwnedBy(page.items, expectedOwnerId);
    return page;
  };
}
