import { useMemo, useSyncExternalStore } from 'react';
import { createGalleryController, EMPTY_GALLERY_STATE, GALLERY_STATUS } from './galleryListController';

const subscribeNone = () => () => {};
const getEmpty = () => EMPTY_GALLERY_STATE;
const noop = () => Promise.resolve(false);

/**
 * Gallery REAL có phân trang. Trả về { ownerId, status, items, nextCursor, hasMore, loadingMore, error, loadMoreError,
 * loading, reload, loadMore }.
 *
 *  - `ownerId` null (chưa đăng nhập / đã đăng xuất): trả NGAY trạng thái rỗng, không có request.
 *  - Đổi `ownerId`: tạo controller mới; controller cũ bị hủy đăng ký (abort request, bỏ qua response muộn). Danh sách của user trước
 *    không còn được tham chiếu nên không bao giờ hiện cho user sau.
 *  - Dùng useSyncExternalStore: không setState trong effect, tương thích StrictMode (xem galleryListController.js).
 *  - KHÔNG tạo request lúc render hay lúc import; request đầu chỉ chạy sau khi component đã đăng ký (mount).
 *
 * @param {Object} options
 * @param {string|null} options.ownerId
 * @param {Function} options.listPage  từ GalleryServices (đã gắn Backend client + expectedOwnerId)
 * @param {number} [options.pageSize]
 */
export function useGalleryList({ ownerId, listPage, pageSize } = {}) {
  const controller = useMemo(
    () => (ownerId && typeof listPage === 'function' ? createGalleryController({ ownerId, listPage, pageSize }) : null),
    [ownerId, listPage, pageSize],
  );
  const snapshot = useSyncExternalStore(
    controller ? controller.subscribe : subscribeNone,
    controller ? controller.getSnapshot : getEmpty,
    controller ? controller.getSnapshot : getEmpty,
  );
  return useMemo(
    () => ({
      ...snapshot,
      loading: snapshot.status === GALLERY_STATUS.LOADING,
      loadMore: controller ? controller.loadMore : noop,
      reload: controller ? controller.reload : noop,
    }),
    [snapshot, controller],
  );
}
