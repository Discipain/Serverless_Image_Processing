// INFRASTRUCTURE — phần VẬN CHUYỂN dùng chung của mọi uploader Cloudinary (unsigned H2 và signed H4B-4):
// MỘT lần POST multipart bằng XMLHttpRequest, có tiến độ, timeout, hủy bằng AbortSignal và phân loại lỗi.
//
// File này KHÔNG biết gì về preset, chữ ký hay public_id: người gọi tự dựng form (`buildForm`) và tự đọc response
// thành công (`handleSuccess`). KHÔNG tự retry, KHÔNG ghi log, KHÔNG gửi Authorization/cookie (withCredentials=false).

import { AppError, ERROR_CODE } from '../../application/errors';

export const UPLOAD_ERROR_KIND = Object.freeze({
  CONFIG: 'CONFIG', // thiếu/sai cloud name hoặc preset
  INVALID_INPUT: 'INVALID_INPUT', // Blob/biến thể không hợp lệ (không gửi request)
  NETWORK: 'NETWORK', // mất mạng, bị chặn (CORS, offline)
  TIMEOUT: 'TIMEOUT', // quá thời gian chờ
  CANCELLED: 'CANCELLED', // người dùng hủy (AbortSignal)
  CLOUDINARY_REJECTED: 'CLOUDINARY_REJECTED', // Cloudinary trả HTTP lỗi (preset sai, file bị từ chối, quota...)
  INVALID_RESPONSE: 'INVALID_RESPONSE', // HTTP 2xx nhưng nội dung không dùng được
});

export const DEFAULT_TIMEOUT_MS = 120_000; // mỗi file

const MAX_REMOTE_MESSAGE = 200;

export function uploadError(code, kind, message, extra = {}) {
  return new AppError(code, message, { kind, ...extra });
}

export const cancelledError = () => uploadError(ERROR_CODE.CANCELLED, UPLOAD_ERROR_KIND.CANCELLED, 'Đã hủy upload.');

// Lấy thông điệp lỗi ngắn của Cloudinary ({"error":{"message":"..."}}); không bao giờ ném lỗi.
export function readRemoteMessage(text) {
  try {
    const message = JSON.parse(text)?.error?.message;
    return typeof message === 'string' ? message.slice(0, MAX_REMOTE_MESSAGE) : null;
  } catch {
    return null;
  }
}

/**
 * @param {Object} args
 * @param {() => XMLHttpRequest} args.createXhr
 * @param {string} args.endpoint
 * @param {() => FormData} args.buildForm  chạy BÊN TRONG try: lỗi dựng form => lỗi NETWORK "Không gửi được yêu cầu upload."
 * @param {number} args.timeoutMs
 * @param {(text: string) => *} args.handleSuccess  nhận body của HTTP 2xx; ném AppError khi nội dung không dùng được
 * @param {(status: number, remoteMessage: string|null) => object} [args.httpErrorExtra]  chi tiết thêm cho lỗi HTTP (vd `kind`)
 * @param {(percent: number) => void} [args.onProgress]
 * @param {AbortSignal} [args.signal]
 */
export function postMultipart({ createXhr, endpoint, buildForm, timeoutMs, handleSuccess, httpErrorExtra, onProgress, signal }) {
  return new Promise((resolve, reject) => {
    let settled = false;
    let lastPercent = -1;
    const xhr = createXhr();

    const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
    const finish = (fn, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      fn(value);
    };
    // Callback của người dùng không được làm hỏng việc upload.
    const report = (percent) => {
      if (typeof onProgress !== 'function' || percent <= lastPercent) return;
      lastPercent = percent;
      try {
        onProgress(percent);
      } catch {
        // bỏ qua lỗi của callback tiến độ
      }
    };
    function onAbort() {
      try {
        xhr.abort();
      } catch {
        // abort là best-effort
      }
      finish(reject, cancelledError());
    }

    try {
      const form = buildForm();

      xhr.open('POST', endpoint, true);
      xhr.timeout = timeoutMs;
      xhr.withCredentials = false; // không gửi cookie/credential tới Cloudinary

      if (xhr.upload) {
        xhr.upload.onprogress = (event) => {
          if (event?.lengthComputable && event.total > 0) {
            // 100% chỉ báo khi Cloudinary đã phản hồi thành công.
            report(Math.min(99, Math.floor((event.loaded / event.total) * 100)));
          }
        };
      }
      xhr.onload = () => {
        const text = typeof xhr.responseText === 'string' ? xhr.responseText : '';
        const status = xhr.status;
        if (status >= 200 && status < 300) {
          try {
            const value = handleSuccess(text);
            report(100);
            finish(resolve, value);
          } catch (error) {
            finish(reject, error);
          }
          return;
        }
        if (!status) {
          finish(reject, uploadError(ERROR_CODE.NETWORK, UPLOAD_ERROR_KIND.NETWORK, 'Không kết nối được tới Cloudinary. Hãy kiểm tra mạng và thử lại.'));
          return;
        }
        const remoteMessage = readRemoteMessage(text);
        const suffix = remoteMessage ? ` (${remoteMessage})` : '';
        const code = status === 420 || status === 429 ? ERROR_CODE.QUOTA_EXCEEDED : ERROR_CODE.UPLOAD_FAILED;
        const extra = httpErrorExtra?.(status, remoteMessage) ?? {};
        finish(
          reject,
          uploadError(code, UPLOAD_ERROR_KIND.CLOUDINARY_REJECTED, `Cloudinary từ chối upload (HTTP ${status})${suffix}.`, {
            httpStatus: status,
            remoteMessage,
            ...extra,
          }),
        );
      };
      xhr.onerror = () =>
        finish(reject, uploadError(ERROR_CODE.NETWORK, UPLOAD_ERROR_KIND.NETWORK, 'Lỗi mạng khi upload lên Cloudinary. Hãy kiểm tra kết nối và thử lại.'));
      xhr.ontimeout = () =>
        finish(reject, uploadError(ERROR_CODE.NETWORK, UPLOAD_ERROR_KIND.TIMEOUT, 'Upload lên Cloudinary quá thời gian chờ. Hãy thử lại.'));
      xhr.onabort = () => finish(reject, cancelledError());

      signal?.addEventListener?.('abort', onAbort, { once: true });
      report(0);
      xhr.send(form);
    } catch (error) {
      finish(
        reject,
        uploadError(ERROR_CODE.NETWORK, UPLOAD_ERROR_KIND.NETWORK, 'Không gửi được yêu cầu upload.', { cause: error }),
      );
    }
  });
}
