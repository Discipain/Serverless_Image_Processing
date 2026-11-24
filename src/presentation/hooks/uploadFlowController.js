// Presentation — controller THUẦN (không import React; kiểm thử được bằng Node) cho MỘT trang Upload, dùng được với useSyncExternalStore
// (cùng mẫu với galleryListController: tương thích StrictMode, không setState trong effect).
//
//  Single-flight: tối đa MỘT lần chạy đang hoạt động (`run`), kiểm tra ĐỒNG BỘ ngay đầu mỗi thao tác — không chỉ dựa vào `disabled` của nút.
//    Bấm đúp/bấm liên tục chọn file, Thử lại, Bắt đầu lại đều bị bỏ qua khi đang chạy. StrictMode (effect chạy 2 lần) không tạo thêm lần chạy
//    nào vì `attach`/`setOwner` là idempotent và không bắt đầu upload.
//  Phiên đăng nhập: `setOwner(uid, token)` — `token` là định danh của PHIÊN đăng nhập (đối tượng user từ AuthProvider). Đổi UID, đăng xuất, hoặc
//    đăng nhập lại (kể cả cùng UID: đối tượng user mới) đều HỦY lần chạy (AbortSignal), xóa session/file/lỗi/mốc đếm ngược và đưa giao diện về
//    trạng thái rỗng. Kết quả muộn của lần chạy đã hủy bị BỎ QUA (không dispatch). Phiên mới của cùng UID không bao giờ tự tiếp tục việc đã hủy.
//  Thử lại THỦ CÔNG: `retry` chỉ chạy khi người dùng gọi; Retry-After của Backend được lưu thành mốc `retryNotBefore` và `retry` bị CHẶN cho tới mốc đó
//    (tự chặn, không chỉ nút bị vô hiệu hóa). Hết mốc KHÔNG tự gửi request.
//  Bắt đầu lại (`restart`): chỉ khi lỗi báo newSessionRequired kèm restartFile của CHÍNH phiên đăng nhập hiện tại; tạo imageId MỚI (use case sinh).
//  Không log, không lưu session/chữ ký/token vào storage; chỉ giữ session trong bộ nhớ của controller.

import { initialUploadState, toErrorView, uploadFlowReducer } from './uploadFlowReducer';

const UNSET = Symbol('owner-unset');

/**
 * @param {Object} options
 * @param {{uploadImage: (args: object) => Promise<object>}} options.services
 * @param {() => number} [options.now]  mặc định Date.now (tiêm để kiểm thử)
 */
export function createUploadFlowController({ services, now = Date.now }) {
  let state = initialUploadState;
  const listeners = new Set();
  let run = null; // { abort: AbortController } của lần chạy ĐANG hoạt động
  let session = null; // session của lần lỗi gần nhất (chỉ trong bộ nhớ)
  let restartInfo = null; // { file, ownerToken }
  let retryNotBefore = 0;
  let ownerToken = UNSET;
  let ownerUid = null;
  let attached = false;

  const dispatch = (action) => {
    const next = uploadFlowReducer(state, action);
    if (next === state) return;
    state = next;
    for (const listener of [...listeners]) listener();
  };

  function abortRun() {
    if (!run) return;
    const current = run;
    run = null; // bỏ qua mọi kết quả muộn của lần chạy này
    current.abort.abort();
  }

  function clearMemory() {
    session = null;
    restartInfo = null;
    retryNotBefore = 0;
  }

  async function execute(args) {
    const abort = new AbortController();
    const mine = { abort };
    run = mine;
    const live = (action) => {
      if (run === mine) dispatch(action);
    };
    try {
      const outcome = await services.uploadImage({
        ...args,
        signal: abort.signal,
        onStage: (event) => live({ type: 'STAGE', ...event }),
        onProgress: (progress) => live({ type: 'PROGRESS', ...progress }),
      });
      if (run !== mine) return;
      clearMemory();
      dispatch({ type: 'DONE', result: outcome });
    } catch (error) {
      if (run !== mine) return; // lần chạy đã bị hủy/thay thế: bỏ qua lỗi muộn
      session = error?.details?.session ?? null;
      restartInfo = error?.details?.restartFile ? { file: error.details.restartFile, ownerToken } : null;
      const view = toErrorView(error, { now: now() });
      retryNotBefore = view.retryNotBefore ?? 0;
      dispatch({ type: 'FAILED', error: view });
    } finally {
      if (run === mine) run = null;
    }
  }

  const controller = {
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    getSnapshot: () => state,

    /** Gắn controller vào vòng đời component. Trả về hàm gỡ (hủy lần chạy đang có). Idempotent với StrictMode. */
    attach() {
      attached = true;
      return () => {
        attached = false;
        abortRun();
      };
    },

    /** Báo phiên đăng nhập hiện tại. Lần gọi đầu chỉ ghi nhận; sau đó mọi thay đổi (UID hoặc đối tượng phiên) hủy và xóa sạch. */
    setOwner(uid, token) {
      if (ownerToken === UNSET) {
        ownerToken = token;
        ownerUid = uid;
        return;
      }
      if (token === ownerToken && uid === ownerUid) return;
      ownerToken = token;
      ownerUid = uid;
      abortRun();
      clearMemory();
      dispatch({ type: 'RESET' });
    },

    selectFile(file) {
      if (!file || run) return undefined; // single-flight
      clearMemory();
      dispatch({ type: 'START', fileName: file.name, fileSize: file.size });
      return execute({ file });
    },

    retry() {
      if (!session || run) return undefined;
      if (now() < retryNotBefore) return undefined; // đang trong thời gian chờ Retry-After: tự chặn, không phụ thuộc nút
      dispatch({ type: 'RESUME' });
      return execute({ session });
    },

    restart() {
      if (!restartInfo || run) return undefined;
      const { file, ownerToken: token } = restartInfo;
      restartInfo = null;
      if (token !== ownerToken) return undefined; // restartFile của phiên đăng nhập khác: không dùng
      return controller.selectFile(file);
    },

    cancel() {
      run?.abort.abort(); // lần chạy tự kết thúc bằng lỗi CANCELLED (giữ session để thử lại)
    },

    reset() {
      abortRun();
      clearMemory();
      dispatch({ type: 'RESET' });
    },

    /** Chỉ để kiểm thử/chẩn đoán. */
    debug: {
      isRunning: () => run !== null,
      hasSession: () => session !== null,
      hasRestart: () => restartInfo !== null,
      isAttached: () => attached,
      retryNotBefore: () => retryNotBefore,
    },
  };
  return controller;
}
