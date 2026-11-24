// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
// Các use case xác thực rất mỏng, nhưng giúp Presentation chỉ nói chuyện với Application
// (không đụng trực tiếp adapter).

import { AppError, ERROR_CODE } from '../errors';

/** Đăng nhập Google; trả về { uid, displayName, email }. Lỗi của adapter (vd code 'CANCELLED') được giữ nguyên. */
export function createLoginWithGoogle({ authRepository }) {
  return async function loginWithGoogle() {
    const user = await authRepository.signInWithGoogle();
    if (!user?.uid) {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Đăng nhập không trả về người dùng hợp lệ.');
    }
    return user;
  };
}

export function createLogout({ authRepository }) {
  return async function logout() {
    await authRepository.signOut();
  };
}

/**
 * Theo dõi trạng thái đăng nhập; trả về hàm hủy đăng ký (gọi trong cleanup của useEffect).
 * `onError` (tùy chọn) nhận lỗi của listener đã được adapter map (có `code` thuộc ERROR_CODE).
 */
export function createObserveAuthState({ authRepository }) {
  return function observeAuthState(onChange, onError) {
    if (typeof onChange !== 'function') {
      throw new AppError(ERROR_CODE.VALIDATION, 'observeAuthState cần hàm onChange.');
    }
    let active = true;
    const stop = authRepository.onAuthChanged(
      (user) => {
        if (active) onChange(user);
      },
      (error) => {
        if (active && typeof onError === 'function') onError(error);
      },
    );
    return function unsubscribe() {
      if (!active) return;
      active = false;
      if (typeof stop === 'function') stop();
    };
  };
}

/**
 * Lấy Firebase ID token THẬT của người dùng hiện tại (để dán vào Postman khi kiểm thử Backend).
 * Chỉ gọi khi người dùng chủ động yêu cầu. Token trả về cho nơi gọi; use case này KHÔNG log, KHÔNG lưu.
 * Chưa đăng nhập / đang ở MOCK: adapter reject (UNAUTHENTICATED) — không bao giờ trả token giả.
 */
export function createGetIdToken({ authRepository }) {
  return async function getIdToken({ forceRefresh = false } = {}) {
    const token = await authRepository.getIdToken(forceRefresh === true);
    if (typeof token !== 'string' || token === '') {
      throw new AppError(ERROR_CODE.UNAUTHENTICATED, 'Không lấy được ID token của người dùng hiện tại.');
    }
    return token;
  };
}
