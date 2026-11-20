import { createContext } from 'react';

/**
 * Giá trị context:
 * {
 *   user: { uid, displayName, email } | null,
 *   initializing: boolean,   // true khi đang kiểm tra phiên đăng nhập (Firebase sau này)
 *   isMock: boolean,         // true = đăng nhập giả lập, không phải Firebase thật
 *   login: () => Promise<user>,
 *   logout: () => Promise<void>,
 * }
 */
export const AuthContext = createContext(null);
