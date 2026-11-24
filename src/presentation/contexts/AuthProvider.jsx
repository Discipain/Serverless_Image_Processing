// Presentation — cung cấp trạng thái xác thực cho React.
// KHÔNG import Firebase SDK, adapter hay firebaseClient: chỉ dùng các use case xác thực do composition root
// (src/app/createAuthServices.js, được gọi ở src/main.jsx) truyền vào qua prop `services` (Dependency Injection).
// Chế độ MOCK / Firebase / lỗi cấu hình do composition root quyết định; component này không tự đoán.

import { useCallback, useEffect, useMemo, useState } from 'react';
import { AuthContext } from './AuthContext';

/**
 * @param {Object} props
 * @param {{
 *   mode: string, isMock: boolean, configError: ({message: string, missing: string[]}|null),
 *   useCases: { observeAuthState: Function, loginWithGoogle: Function, logout: Function, getIdToken: Function }
 * }} props.services  kết quả của createAuthServices()
 */
export function AuthProvider({ services, children }) {
  const { useCases, mode, isMock, configError } = services;
  const [session, setSession] = useState({ user: null, initializing: true });
  const [authError, setAuthError] = useState(null);

  // Theo dõi phiên đăng nhập (Firebase: khôi phục phiên sau khi F5). Hủy đăng ký khi unmount.
  useEffect(() => {
    return useCases.observeAuthState(
      (user) => {
        setSession({ user, initializing: false });
        if (user) setAuthError(null);
      },
      (error) => {
        // Lỗi listener: giữ nguyên người dùng hiện tại, chỉ kết thúc trạng thái "đang khởi tạo" và báo lỗi.
        setAuthError(error);
        setSession((current) => (current.initializing ? { ...current, initializing: false } : current));
      },
    );
  }, [useCases]);

  const login = useCallback(async () => {
    const user = await useCases.loginWithGoogle();
    setSession({ user, initializing: false });
    setAuthError(null);
    return user;
  }, [useCases]);

  const logout = useCallback(async () => {
    await useCases.logout();
    setSession({ user: null, initializing: false });
  }, [useCases]);

  // Token KHÔNG được giữ trong state/storage: chỉ đi qua hàm này tới nơi gọi (nút "Sao chép ID token").
  const getIdToken = useCallback((options) => useCases.getIdToken(options), [useCases]);

  const value = useMemo(
    () => ({
      user: session.user,
      initializing: session.initializing,
      isMock,
      mode,
      configError,
      authError,
      login,
      logout,
      getIdToken,
    }),
    [session, isMock, mode, configError, authError, login, logout, getIdToken],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
