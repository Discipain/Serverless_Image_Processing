// ============================================================
// AUTH MOCK — KHÔNG gọi Firebase Authentication.
// Bước sau sẽ thay phần thân bằng signInWithPopup(GoogleAuthProvider)
// + onAuthStateChanged, giữ nguyên giá trị context để UI không phải sửa.
// ============================================================

import { useCallback, useMemo, useState } from 'react';
import { AuthContext } from './AuthContext';
import { MOCK_USER } from '../services/mock/mockImages';

// Lưu phiên MOCK trong sessionStorage để F5 không bị đăng xuất khi phát triển.
const STORAGE_KEY = 'sip.mockUser';
const MOCK_LOGIN_DELAY_MS = 500;

function readStoredUser() {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch {
    return null; // trình duyệt chặn storage -> coi như chưa đăng nhập
  }
}

function writeStoredUser(user) {
  try {
    if (user) sessionStorage.setItem(STORAGE_KEY, JSON.stringify(user));
    else sessionStorage.removeItem(STORAGE_KEY);
  } catch {
    // Bỏ qua: chỉ mất khả năng nhớ phiên khi F5.
  }
}

export function AuthProvider({ children }) {
  const [user, setUser] = useState(readStoredUser);

  const login = useCallback(async () => {
    await new Promise((resolve) => setTimeout(resolve, MOCK_LOGIN_DELAY_MS));
    writeStoredUser(MOCK_USER);
    setUser(MOCK_USER);
    return MOCK_USER;
  }, []);

  const logout = useCallback(async () => {
    writeStoredUser(null);
    setUser(null);
  }, []);

  const value = useMemo(
    () => ({ user, initializing: false, isMock: true, login, logout }),
    [user, login, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}
