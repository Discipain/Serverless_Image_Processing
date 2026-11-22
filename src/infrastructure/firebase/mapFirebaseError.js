// INFRASTRUCTURE — chuyển lỗi của Firebase SDK (Auth / Firestore / Storage) thành lỗi của adapter,
// với `code` thuộc ERROR_CODE của Application (application/errors.js).
//
// File này KHÔNG import Firebase SDK: chỉ đọc `error.code` (chuỗi), nên kiểm thử được bằng Node thuần.
//
// Nguyên tắc:
//  - PERMISSION_DENIED và NOT_FOUND là hai việc khác nhau; không bao giờ đổi cái này thành cái kia.
//    Mã không nhận ra -> UNKNOWN (không bao giờ NOT_FOUND).
//  - Không làm mất lỗi gốc: `originalCode` (mã gốc của SDK), `cause` (đối tượng lỗi gốc), `service`, `operation`.
//  - `message` dành cho NGƯỜI DÙNG: tiếng Việt, cố định theo mã, KHÔNG chép thông báo gốc của SDK
//    (có thể chứa mã dự án, đường dẫn, URL console). Chi tiết gốc chỉ nằm ở `cause`.
//  - Idempotent: lỗi đã được map (hoặc đã mang mã của Application) được trả về nguyên vẹn.
//  - Không đụng tới ERROR_REASON (lý do lỗi xử lý ảnh) — đó là việc của Domain.

import { ERROR_CODE } from '../../application/errors';

const C = ERROR_CODE;

/**
 * Bảng mã lỗi SDK -> [mã Application, thông báo cho người dùng].
 * Mã Firestore không có tiền tố ('permission-denied'); Auth có 'auth/'; Storage có 'storage/'.
 */
export const FIREBASE_ERROR_MAP = Object.freeze({
  // ----- Firestore -----
  'permission-denied': [C.PERMISSION_DENIED, 'Bạn không có quyền thực hiện thao tác này (hoặc dữ liệu không thuộc về bạn).'],
  'not-found': [C.NOT_FOUND, 'Không tìm thấy dữ liệu yêu cầu.'],
  unauthenticated: [C.UNAUTHENTICATED, 'Cần đăng nhập (hoặc phiên đăng nhập đã hết hạn).'],
  unavailable: [C.NETWORK, 'Không kết nối được tới máy chủ. Hãy kiểm tra mạng và thử lại.'],
  'deadline-exceeded': [C.NETWORK, 'Máy chủ phản hồi quá lâu. Hãy kiểm tra mạng và thử lại.'],
  aborted: [C.NETWORK, 'Thao tác bị gián đoạn do xung đột hoặc mạng không ổn định. Hãy thử lại.'],
  cancelled: [C.CANCELLED, 'Thao tác đã bị hủy.'],
  'resource-exhausted': [C.QUOTA_EXCEEDED, 'Đã vượt hạn mức dịch vụ. Hãy thử lại sau hoặc liên hệ quản trị viên.'],
  // 'failed-precondition' xử lý riêng bên dưới (thiếu index -> CONFIG, còn lại -> UNKNOWN)
  'already-exists': [C.UNKNOWN, 'Dữ liệu đã tồn tại.'],
  'invalid-argument': [C.UNKNOWN, 'Yêu cầu gửi lên Firebase không hợp lệ (lỗi lập trình).'],
  'out-of-range': [C.UNKNOWN, 'Giá trị nằm ngoài phạm vi cho phép.'],
  unimplemented: [C.UNKNOWN, 'Tính năng chưa được hỗ trợ trong môi trường hiện tại.'],
  internal: [C.UNKNOWN, 'Máy chủ gặp lỗi nội bộ. Hãy thử lại sau.'],
  'data-loss': [C.UNKNOWN, 'Dữ liệu bị mất hoặc hỏng.'],
  unknown: [C.UNKNOWN, 'Đã xảy ra lỗi không xác định.'],

  // ----- Storage -----
  'storage/unauthorized': [C.PERMISSION_DENIED, 'Bạn không có quyền với tệp này.'],
  'storage/unauthenticated': [C.UNAUTHENTICATED, 'Cần đăng nhập (hoặc phiên đăng nhập đã hết hạn).'],
  'storage/object-not-found': [C.NOT_FOUND, 'Không tìm thấy tệp.'],
  'storage/retry-limit-exceeded': [C.NETWORK, 'Hết thời gian chờ khi truyền tệp. Hãy kiểm tra mạng và thử lại.'],
  'storage/canceled': [C.CANCELLED, 'Thao tác với tệp đã bị hủy.'],
  'storage/quota-exceeded': [C.QUOTA_EXCEEDED, 'Dịch vụ lưu trữ đã vượt hạn mức hoặc dự án chưa bật gói phù hợp.'],
  'storage/bucket-not-found': [C.CONFIG, 'Chưa có bucket lưu trữ. Hãy liên hệ người quản trị.'],
  'storage/no-default-bucket': [C.CONFIG, 'Cấu hình chưa có bucket lưu trữ mặc định.'],
  'storage/invalid-default-bucket': [C.CONFIG, 'Tên bucket lưu trữ trong cấu hình không hợp lệ.'],
  'storage/project-not-found': [C.CONFIG, 'Dự án Firebase chưa bật dịch vụ lưu trữ.'],
  'storage/unauthorized-app': [C.CONFIG, 'Ứng dụng chưa được phép dùng dịch vụ lưu trữ.'],
  'storage/invalid-checksum': [C.UNKNOWN, 'Tệp tải lên không khớp mã kiểm tra. Hãy thử lại.'],
  'storage/server-file-wrong-size': [C.UNKNOWN, 'Tệp trên máy chủ không khớp dung lượng. Hãy thử lại.'],
  'storage/cannot-slice-blob': [C.UNKNOWN, 'Tệp nguồn đã thay đổi trong lúc tải lên. Hãy chọn lại tệp.'],
  'storage/unknown': [C.UNKNOWN, 'Đã xảy ra lỗi không xác định với dịch vụ lưu trữ.'],

  // ----- Authentication -----
  'auth/popup-closed-by-user': [C.CANCELLED, 'Bạn đã đóng cửa sổ đăng nhập.'],
  'auth/cancelled-popup-request': [C.CANCELLED, 'Yêu cầu đăng nhập đã bị thay thế bằng yêu cầu khác.'],
  'auth/popup-blocked': [C.POPUP_BLOCKED, 'Trình duyệt đã chặn cửa sổ đăng nhập. Hãy cho phép cửa sổ bật lên rồi thử lại.'],
  'auth/network-request-failed': [C.NETWORK, 'Lỗi kết nối mạng khi đăng nhập. Hãy kiểm tra mạng và thử lại.'],
  'auth/timeout': [C.NETWORK, 'Đăng nhập quá thời gian chờ. Hãy thử lại.'],
  'auth/unauthorized-domain': [C.CONFIG, 'Tên miền này chưa được phép đăng nhập. Hãy liên hệ người quản trị.'],
  'auth/operation-not-allowed': [C.CONFIG, 'Phương thức đăng nhập này chưa được bật. Hãy liên hệ người quản trị.'],
  'auth/operation-not-supported-in-this-environment': [C.CONFIG, 'Môi trường hiện tại không hỗ trợ đăng nhập bằng cửa sổ popup.'],
  'auth/web-storage-unsupported': [C.CONFIG, 'Trình duyệt đang chặn lưu trữ cần cho đăng nhập (cookie/bộ nhớ cục bộ).'],
  'auth/invalid-api-key': [C.CONFIG, 'Cấu hình Firebase không hợp lệ (khóa API).'],
  'auth/api-key-not-valid.-please-pass-a-valid-api-key.': [C.CONFIG, 'Cấu hình Firebase không hợp lệ (khóa API).'],
  'auth/configuration-not-found': [C.CONFIG, 'Dịch vụ đăng nhập chưa được cấu hình. Hãy liên hệ người quản trị.'],
  'auth/app-not-authorized': [C.CONFIG, 'Ứng dụng chưa được phép dùng dịch vụ đăng nhập.'],
  'auth/invalid-app-credential': [C.CONFIG, 'Cấu hình ứng dụng đăng nhập không hợp lệ.'],
  'auth/user-disabled': [C.PERMISSION_DENIED, 'Tài khoản này đã bị vô hiệu hóa.'],
  'auth/user-token-expired': [C.UNAUTHENTICATED, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.'],
  'auth/id-token-expired': [C.UNAUTHENTICATED, 'Phiên đăng nhập đã hết hạn. Hãy đăng nhập lại.'],
  'auth/requires-recent-login': [C.UNAUTHENTICATED, 'Cần đăng nhập lại để thực hiện thao tác này.'],
  'auth/invalid-credential': [C.UNAUTHENTICATED, 'Thông tin đăng nhập không hợp lệ hoặc đã hết hạn.'],
  'auth/user-not-found': [C.UNAUTHENTICATED, 'Không tìm thấy tài khoản đăng nhập.'],
  'auth/too-many-requests': [C.UNKNOWN, 'Quá nhiều yêu cầu đăng nhập. Hãy thử lại sau.'],
  'auth/account-exists-with-different-credential': [C.UNKNOWN, 'Email này đã được dùng với phương thức đăng nhập khác.'],
  'auth/internal-error': [C.UNKNOWN, 'Dịch vụ đăng nhập gặp lỗi nội bộ. Hãy thử lại sau.'],
});

const UNKNOWN_MESSAGE = 'Đã xảy ra lỗi không xác định.';
const INDEX_MESSAGE = 'Truy vấn cần một chỉ mục (index) chưa được tạo. Hãy liên hệ người quản trị.';
const CONDITION_MESSAGE = 'Thao tác không thực hiện được ở trạng thái hiện tại của dữ liệu.';
const NETWORK_MESSAGE = 'Lỗi kết nối mạng. Hãy kiểm tra Internet và thử lại.';

const APP_CODES = new Set(Object.values(ERROR_CODE));

/** Lỗi do adapter ném lên. `message` an toàn để hiển thị; chi tiết gốc nằm ở `cause`. */
export class AdapterError extends Error {
  constructor(code, message, { originalCode, cause, service, operation } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = 'AdapterError';
    this.code = code;
    this.originalCode = originalCode;
    this.service = service;
    this.operation = operation;
  }
}

/** true nếu lỗi đã ở dạng của adapter/Application (không cần map lại). */
export function isMappedError(error) {
  if (error instanceof AdapterError) return true;
  // Lỗi đã mang mã của Application (vd MOCK hoặc AppError): mã Firebase luôn viết thường, ERROR_CODE viết hoa.
  return Boolean(error) && typeof error === 'object' && typeof error.code === 'string' && APP_CODES.has(error.code);
}

const textOf = (error) => (error && typeof error === 'object' && typeof error.message === 'string' ? error.message : '');

// Lỗi mạng của trình duyệt không có mã Firebase (vd fetch bị chặn): TypeError "Failed to fetch".
function looksLikeNetworkFailure(error) {
  if (!error || typeof error !== 'object') return false;
  if (error.name === 'NetworkError') return true;
  return error.name === 'TypeError' && /failed to fetch|network|load failed/i.test(textOf(error));
}

/**
 * @param {unknown} error  lỗi bắt được từ Firebase SDK (hoặc bất cứ thứ gì bị ném ra)
 * @param {{service?: 'auth'|'firestore'|'storage', operation?: string}} [context]  chỉ để ghi lại, không ảnh hưởng mã
 * @returns {AdapterError|Error}  luôn là lỗi có `code` thuộc ERROR_CODE
 */
export function mapFirebaseError(error, context = {}) {
  if (isMappedError(error)) return error;

  const { service, operation } = context;
  const originalCode =
    error && typeof error === 'object' && typeof error.code === 'string' ? error.code : undefined;
  const meta = { originalCode, cause: error, service, operation };

  if (originalCode !== undefined) {
    if (originalCode === 'failed-precondition') {
      // Thiếu composite index thật sự là lỗi cấu hình; điều kiện tiên quyết khác chỉ là UNKNOWN.
      return /index/i.test(textOf(error))
        ? new AdapterError(C.CONFIG, INDEX_MESSAGE, meta)
        : new AdapterError(C.UNKNOWN, CONDITION_MESSAGE, meta);
    }
    // Object.hasOwn: tránh nhầm với các khóa kế thừa (vd 'constructor').
    if (Object.hasOwn(FIREBASE_ERROR_MAP, originalCode)) {
      const [code, message] = FIREBASE_ERROR_MAP[originalCode];
      return new AdapterError(code, message, meta);
    }
  }

  if (looksLikeNetworkFailure(error)) return new AdapterError(C.NETWORK, NETWORK_MESSAGE, meta);

  // Không nhận ra: UNKNOWN. Tuyệt đối không đoán là NOT_FOUND hay PERMISSION_DENIED.
  return new AdapterError(C.UNKNOWN, UNKNOWN_MESSAGE, meta);
}
