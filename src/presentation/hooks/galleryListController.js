// PRESENTATION — bộ điều khiển phân trang Gallery (REAL). JavaScript thuần: KHÔNG import React, Firebase hay Infrastructure.
//
// Là một "store" nhỏ (subscribe / getSnapshot) để hook `useGalleryList` gắn vào React bằng useSyncExternalStore,
// nhờ đó test được trong Node không cần DOM. Mọi quy tắc quan trọng nằm ở đây:
//
//  - Mỗi controller thuộc về MỘT `ownerId`. Đổi user => hook tạo controller MỚI; controller cũ bị dừng và KHÔNG còn được tham chiếu,
//    nên danh sách/cursor của user trước biến mất ngay trong lần render đầu tiên của user sau.
//  - Mỗi lần dừng/reload tăng `epoch` và abort request đang bay; response đến muộn thuộc epoch cũ bị BỎ QUA (không ghi state).
//  - `loadMore` không tạo request trùng: đang tải thêm / đang tải trang đầu / hết trang => bỏ qua ngay (đồng bộ).
//  - Không ghép trùng imageId; cursor luôn là `nextCursor` của CHÍNH controller này, reload xóa cursor.
//  - Trang tiếp lỗi: giữ ảnh đã tải + cursor, `loadMoreError` được đặt, gọi `loadMore` lại để thử lại.
//  - Trang đầu lỗi (kể cả 503): status 'error', KHÔNG bao giờ thành danh sách rỗng giả.
//  - Tương thích StrictMode: request đầu được hoãn tới microtask sau khi có người đăng ký; chuỗi subscribe -> unsubscribe ->
//    subscribe đồng bộ của StrictMode chỉ tạo ĐÚNG MỘT request.

import { PAGE_SIZE } from '../../domain/constants/imageRules';
import { AppError, ERROR_CODE } from '../../application/errors';

export const GALLERY_STATUS = Object.freeze({ IDLE: 'idle', LOADING: 'loading', READY: 'ready', ERROR: 'error' });

/** Trạng thái khi chưa có user (chưa đăng nhập / đã đăng xuất): không có dữ liệu, không có request. */
export const EMPTY_GALLERY_STATE = Object.freeze({
  ownerId: null,
  status: GALLERY_STATUS.IDLE,
  items: Object.freeze([]),
  nextCursor: null,
  hasMore: false,
  loadingMore: false,
  error: null,
  loadMoreError: null,
});

const invalidResponse = (message) =>
  new AppError(ERROR_CODE.UNKNOWN, message, { kind: 'INVALID_RESPONSE', retryable: false });

/**
 * @param {Object} options
 * @param {string} options.ownerId  uid đang đăng nhập (chỉ dùng làm `expectedOwnerId` ở tầng dưới, KHÔNG gửi lên Backend)
 * @param {(args: {ownerId: string, limit: number, cursor?: string, signal: AbortSignal}) => Promise<{items: Array, nextCursor: string|null, hasMore: boolean}>} options.listPage
 * @param {number} [options.pageSize]
 */
export function createGalleryController({ ownerId, listPage, pageSize = PAGE_SIZE } = {}) {
  if (typeof ownerId !== 'string' || ownerId === '') throw new TypeError('createGalleryController cần ownerId (uid).');
  if (typeof listPage !== 'function') throw new TypeError('createGalleryController cần hàm listPage.');

  const initial = () => Object.freeze({ ...EMPTY_GALLERY_STATE, ownerId, status: GALLERY_STATUS.LOADING });

  let state = initial();
  const listeners = new Set();
  let epoch = 0; // tăng mỗi khi dừng/reload: response thuộc epoch cũ bị bỏ qua
  let began = false; // đã bắt đầu tải (có người đăng ký và microtask khởi động đã chạy)
  let startScheduled = false;
  let moreInFlight = false;
  const aborters = new Set();

  function set(patch) {
    state = Object.freeze({ ...state, ...patch });
    for (const listener of [...listeners]) listener();
  }

  function newSignal() {
    const controller = new AbortController();
    aborters.add(controller);
    return controller;
  }

  function abortAll() {
    for (const controller of aborters) controller.abort();
    aborters.clear();
  }

  async function fetchFirst(myEpoch) {
    const ac = newSignal();
    try {
      const page = await listPage({ ownerId, limit: pageSize, cursor: undefined, signal: ac.signal });
      if (myEpoch !== epoch) return; // đã reload/dừng/đổi user: bỏ qua
      set({
        status: GALLERY_STATUS.READY,
        items: Object.freeze([...page.items]),
        nextCursor: page.nextCursor,
        hasMore: page.hasMore,
        error: null,
        loadMoreError: null,
      });
    } catch (error) {
      if (myEpoch !== epoch) return;
      set({ status: GALLERY_STATUS.ERROR, items: EMPTY_GALLERY_STATE.items, nextCursor: null, hasMore: false, error });
    } finally {
      aborters.delete(ac);
    }
  }

  function begin() {
    if (began) return;
    began = true;
    epoch += 1;
    void fetchFirst(epoch);
  }

  function stop() {
    epoch += 1; // vô hiệu hóa mọi response đang bay
    abortAll();
    began = false;
    moreInFlight = false;
    state = initial(); // lần đăng ký sau (StrictMode/remount) bắt đầu lại từ đầu, không giữ dữ liệu cũ
  }

  function subscribe(listener) {
    listeners.add(listener);
    if (!began && !startScheduled) {
      startScheduled = true;
      queueMicrotask(() => {
        startScheduled = false;
        if (listeners.size > 0 && !began) begin();
      });
    }
    return () => {
      listeners.delete(listener);
      if (listeners.size === 0) stop();
    };
  }

  /** Tải trang tiếp theo. Trả về Promise (đã resolve ngay nếu bị bỏ qua). Không bao giờ ném lỗi: lỗi nằm ở state.loadMoreError. */
  async function loadMore() {
    if (!began || state.status !== GALLERY_STATUS.READY || !state.hasMore || state.loadingMore || moreInFlight) return false;
    const myEpoch = epoch;
    const cursor = state.nextCursor;
    moreInFlight = true;
    set({ loadingMore: true, loadMoreError: null }); // đồng bộ: lần bấm thứ hai bị chặn bởi moreInFlight/loadingMore
    const ac = newSignal();
    try {
      const page = await listPage({ ownerId, limit: pageSize, cursor, signal: ac.signal });
      if (myEpoch !== epoch) return false;
      if (page.nextCursor !== null && page.nextCursor === cursor) {
        throw invalidResponse('Backend trả lại đúng cursor cũ; dừng tải thêm để tránh lặp vô hạn.');
      }
      const seen = new Set(state.items.map((item) => item.imageId));
      const fresh = page.items.filter((item) => !seen.has(item.imageId)); // không ghép trùng imageId
      set({ items: Object.freeze([...state.items, ...fresh]), nextCursor: page.nextCursor, hasMore: page.hasMore, loadingMore: false });
      return true;
    } catch (error) {
      if (myEpoch !== epoch) return false;
      set({ loadingMore: false, loadMoreError: error }); // giữ ảnh đã tải + cursor cũ để thử lại
      return false;
    } finally {
      aborters.delete(ac);
      if (myEpoch === epoch) moreInFlight = false;
    }
  }

  /** Tải lại từ trang đầu: xóa danh sách và cursor, hủy request đang bay. Bỏ qua nếu trang đầu đang tải. */
  function reload() {
    if (!began || state.status === GALLERY_STATUS.LOADING) return;
    epoch += 1;
    abortAll();
    moreInFlight = false;
    state = initial();
    for (const listener of [...listeners]) listener();
    void fetchFirst(epoch);
  }

  return Object.freeze({ ownerId, subscribe, getSnapshot: () => state, loadMore, reload });
}
