// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Gắn MỘT phiên upload có chữ ký với MỘT người dùng (UID) và hủy nó khi người dùng đó không còn là người đang đăng nhập.
//
//  - UID được chốt khi bắt đầu (từ trạng thái đăng nhập, không do giao diện truyền vào) và truyền xuống use case làm `ownerUid`.
//  - Đăng xuất hoặc đổi UID giữa chừng => hủy NGAY (AbortSignal xuyên xuống authorize/upload/confirm) và kết thúc bằng lỗi
//    AUTH_CHANGED KHÔNG có `session`: không authorize, không upload biến thể mới, không confirm bằng token của người dùng mới,
//    và mọi kết quả muộn của phiên cũ (kể cả thành công) bị BỎ QUA.
//  - Session của người khác bị từ chối (use case kiểm tra `ownerUid`): grant của A không bao giờ được dùng cho B.
//  - Lưu ý: yêu cầu Cloudinary đã gửi đi có thể vẫn hoàn tất ở server sau khi trình duyệt hủy; hủy KHÔNG bảo đảm asset không tồn tại.
//    Backend chỉ xác nhận ảnh khi grant thuộc đúng người đăng nhập.

import { AppError, ERROR_CODE } from '../errors';
import { SIGNED_UPLOAD_KIND } from '../signedUploadErrors';

export const DEFAULT_AUTH_READY_TIMEOUT_MS = 10_000;

/**
 * @param {Object} deps
 * @param {(args: object) => Promise<object>} deps.uploadImageSigned
 * @param {(onChange: (user: {uid: string}|null) => void, onError?: (error: Error) => void) => (() => void)} deps.observeAuthState
 * @param {number} [deps.authReadyTimeoutMs]
 */
export function createGuardedSignedUpload({ uploadImageSigned, observeAuthState, authReadyTimeoutMs = DEFAULT_AUTH_READY_TIMEOUT_MS }) {
  return async function guardedSignedUpload(args = {}) {
    const outer = args.signal;
    const controller = new AbortController();
    const onOuterAbort = () => controller.abort();
    if (outer?.aborted) controller.abort();
    else outer?.addEventListener?.('abort', onOuterAbort, { once: true });

    let invalidated = false;
    let startUid; // undefined = chưa biết trạng thái đăng nhập
    let settleReady;
    const ready = new Promise((resolve) => {
      settleReady = resolve;
    });
    const timer = setTimeout(() => {
      if (startUid === undefined) {
        startUid = null;
        settleReady(null);
      }
    }, authReadyTimeoutMs);

    const invalidate = () => {
      invalidated = true;
      controller.abort();
    };
    const unsubscribe = observeAuthState(
      (user) => {
        const uid = typeof user?.uid === 'string' && user.uid !== '' ? user.uid : null;
        if (startUid === undefined) {
          startUid = uid;
          settleReady(uid);
        } else if (uid !== startUid) {
          invalidate();
        }
      },
      () => {
        // Lỗi của listener: không biết người dùng là ai => không tiếp tục.
        if (startUid === undefined) {
          startUid = null;
          settleReady(null);
        } else {
          invalidate();
        }
      },
    );

    const authChanged = () =>
      new AppError(ERROR_CODE.CANCELLED, 'Tài khoản đăng nhập đã thay đổi nên phiên upload đã bị hủy. Hãy chọn lại ảnh để upload.', {
        kind: SIGNED_UPLOAD_KIND.AUTH_CHANGED,
        retryable: false,
        newSessionRequired: false,
      });

    try {
      const uid = await ready;
      if (!uid) {
        throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Chưa đăng nhập nên không thể upload.', { retryable: false });
      }
      if (invalidated) throw authChanged();

      let outcome;
      try {
        outcome = await uploadImageSigned({ ...args, ownerUid: uid, signal: controller.signal });
      } catch (error) {
        if (invalidated) throw authChanged(); // lỗi muộn của phiên cũ: không lộ session/grant, không cho thử lại
        throw error;
      }
      if (invalidated) throw authChanged(); // thành công muộn của phiên cũ bị bỏ qua
      return outcome;
    } finally {
      clearTimeout(timer);
      outer?.removeEventListener?.('abort', onOuterAbort);
      unsubscribe?.();
    }
  };
}
