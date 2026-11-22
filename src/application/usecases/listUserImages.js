// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.

import { PAGE_SIZE } from '../../domain/constants/imageRules';
import { AppError, ERROR_CODE } from '../errors';

// Ép limit về khoảng 1..PAGE_SIZE (SCHEMA.md: limit <= 20); giá trị không hợp lệ -> PAGE_SIZE.
export function clampLimit(limit) {
  if (!Number.isFinite(limit)) return PAGE_SIZE;
  return Math.min(Math.max(1, Math.floor(limit)), PAGE_SIZE);
}

/**
 * Lấy một trang ảnh của CHÍNH người dùng (where ownerId == uid, createdAt giảm dần).
 * `cursor` là giá trị mờ do repository trả về ở lần gọi trước; `nextCursor === null` nghĩa là hết dữ liệu.
 */
export function createListUserImages({ imageRepository }) {
  return async function listUserImages({ ownerId, limit, cursor } = {}) {
    if (!ownerId) {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Cần đăng nhập để xem thư viện ảnh.');
    }
    const result = await imageRepository.list({ ownerId, limit: clampLimit(limit), cursor });
    return { items: result?.items ?? [], nextCursor: result?.nextCursor ?? null };
  };
}
