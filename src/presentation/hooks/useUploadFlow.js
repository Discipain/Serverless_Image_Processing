import { useContext, useEffect, useMemo, useSyncExternalStore } from 'react';
import { AuthContext } from '../contexts/AuthContext';
import { createUploadFlowController } from './uploadFlowController';
import { useUploadServices } from './useUploadServices';

/**
 * Điều khiển một lần upload (MOCK ở H4A, REAL/Signed Upload ở H4B-5) và giữ `session` của lần thất bại gần nhất để thử lại ĐÚNG bước hỏng.
 * Toàn bộ logic nằm ở uploadFlowController (thuần, kiểm thử được); hook này chỉ gắn nó vào React bằng useSyncExternalStore.
 *
 *  - Đổi UID / đăng xuất / đăng nhập lại: controller hủy lần chạy và xóa sạch file, session, lỗi, mốc đếm ngược (xem controller).
 *  - Không có request nào lúc render hay lúc mount: upload chỉ bắt đầu khi người dùng chọn ảnh (selectFile).
 * Trả về { state, selectFile, retry, restart, cancel, reset }.
 */
export function useUploadFlow() {
  const services = useUploadServices();
  const user = useContext(AuthContext)?.user ?? null;
  const controller = useMemo(() => createUploadFlowController({ services }), [services]);
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot);

  useEffect(() => controller.attach(), [controller]);
  useEffect(() => {
    controller.setOwner(user?.uid ?? null, user);
  }, [controller, user]);

  return useMemo(
    () => ({
      state,
      selectFile: controller.selectFile,
      retry: controller.retry,
      restart: controller.restart,
      cancel: controller.cancel,
      reset: controller.reset,
    }),
    [state, controller],
  );
}
