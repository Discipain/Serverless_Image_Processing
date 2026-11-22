import { createContext } from 'react';

/**
 * Giá trị context:
 * {
 *   user: { uid, displayName, email } | null,
 *   initializing: boolean,   // true khi đang khôi phục/kiểm tra phiên đăng nhập
 *   isMock: boolean,         // true = đăng nhập giả lập (MOCK), không phải Firebase thật
 *   mode: 'firebase' | 'mock' | 'misconfigured',
 *   configError: { message, missing[] } | null,  // chỉ có khi mode = 'misconfigured'
 *   authError: Error | null, // lỗi của listener xác thực (đã map, có `code`)
 *   login: () => Promise<user>,   // reject Error có `code` (CANCELLED, POPUP_BLOCKED, NETWORK, CONFIG, ...)
 *   logout: () => Promise<void>,
 *   getIdToken: (options?: { forceRefresh?: boolean }) => Promise<string>,
 *     // Firebase ID token THẬT, chỉ khi người dùng chủ động yêu cầu; MOCK/chưa đăng nhập -> reject.
 * }
 */
export const AuthContext = createContext(null);
