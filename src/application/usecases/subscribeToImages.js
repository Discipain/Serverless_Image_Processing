// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.

import { AppError, ERROR_CODE } from '../errors';
import { clampLimit } from './listUserImages';

/**
 * Theo dõi realtime danh sách ảnh của CHÍNH người dùng (onSnapshot ở Infrastructure).
 * Trả về hàm `unsubscribe` — hook PHẢI gọi trong cleanup của useEffect để không rò rỉ listener.
 * Sau khi unsubscribe, mọi callback đến muộn đều bị bỏ qua; gọi unsubscribe nhiều lần là an toàn.
 *
 * Lưu ý: chỉ theo dõi trang đầu (tối đa PAGE_SIZE ảnh mới nhất); các trang sau lấy bằng listUserImages + cursor.
 */
export function createSubscribeToImages({ imageRepository }) {
  return function subscribeToImages({ ownerId, limit, onData, onError }) {
    if (!ownerId) {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Cần đăng nhập để theo dõi thư viện ảnh.');
    }
    if (typeof onData !== 'function') {
      throw new AppError(ERROR_CODE.VALIDATION, 'subscribeToImages cần hàm onData.');
    }

    let active = true;
    const stop = imageRepository.subscribe(
      { ownerId, limit: clampLimit(limit) },
      (items) => {
        if (active) onData(items);
      },
      (error) => {
        if (active && typeof onError === 'function') onError(error);
      },
    );
    if (typeof stop !== 'function') {
      active = false;
      throw new AppError(
        ERROR_CODE.INVALID_STATE,
        'imageRepository.subscribe phải trả về hàm hủy listener.',
      );
    }

    return function unsubscribe() {
      if (!active) return;
      active = false;
      stop();
    };
  };
}
