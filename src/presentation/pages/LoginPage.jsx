import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import { ROUTES } from '../constants/routes';
import { ERROR_CODE } from '../../application/errors';
import { MockBadge } from '../components/common/MockBadge';
import { LoadingState } from '../components/common/LoadingState';

// Phân biệt các loại lỗi đăng nhập để người dùng biết phải làm gì.
// CANCELLED (đóng popup) KHÔNG phải lỗi đăng nhập thật nên chỉ hiện thông tin trung tính.
const ERROR_TITLES = {
  [ERROR_CODE.POPUP_BLOCKED]: 'Trình duyệt đã chặn cửa sổ đăng nhập',
  [ERROR_CODE.NETWORK]: 'Lỗi kết nối mạng',
  [ERROR_CODE.CONFIG]: 'Lỗi cấu hình Firebase',
  [ERROR_CODE.PERMISSION_DENIED]: 'Tài khoản không được phép',
};

function describeError(error) {
  if (error?.code === ERROR_CODE.CANCELLED) {
    return { tone: 'info', title: null, text: 'Bạn đã đóng cửa sổ đăng nhập. Bạn chưa được đăng nhập.' };
  }
  return {
    tone: 'error',
    title: ERROR_TITLES[error?.code] ?? 'Đăng nhập thất bại',
    text: error?.message || 'Đăng nhập thất bại, vui lòng thử lại.',
  };
}

export function LoginPage() {
  const { user, initializing, isMock, mode, configError, authError, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Trang người dùng định vào trước khi bị chuyển sang /login.
  const redirectTo = location.state?.from?.pathname || ROUTES.gallery;

  if (initializing) {
    return <LoadingState message="Đang kiểm tra đăng nhập…" fullPage />;
  }

  if (user) {
    return <Navigate to={redirectTo} replace />;
  }

  async function handleLogin() {
    setSubmitting(true);
    setError(null);
    try {
      await login();
      navigate(redirectTo, { replace: true });
    } catch (err) {
      setError(err);
      setSubmitting(false);
    }
  }

  const misconfigured = mode === 'misconfigured';
  // Lỗi cấu hình đã có khung riêng bên dưới, tránh hiển thị trùng.
  const shownError = error ?? (misconfigured ? null : authError);
  const described = shownError ? describeError(shownError) : null;

  return (
    <main className="login">
      <section className="login__card" aria-labelledby="login-title">
        <h1 id="login-title" className="login__title">
          Image Processing
        </h1>
        <p className="login__subtitle">
          Đăng nhập để tải ảnh lên và xem thư viện ảnh của bạn.
        </p>

        <button
          type="button"
          className="btn btn--primary btn--block"
          onClick={handleLogin}
          disabled={submitting || misconfigured}
        >
          {submitting ? 'Đang đăng nhập…' : isMock ? 'Đăng nhập (MOCK)' : 'Đăng nhập với Google'}
        </button>

        {misconfigured && configError && (
          <div className="login__error" role="alert">
            <strong className="login__error-title">Lỗi cấu hình Firebase</strong>
            <p className="login__error-text">{configError.message}</p>
            <p className="login__error-text">
              Ứng dụng KHÔNG tự chuyển sang MOCK vì bạn đã điền cấu hình Firebase. Muốn chạy MOCK, hãy xóa hết
              các biến VITE_FIREBASE_* trong .env.local.
            </p>
          </div>
        )}

        {described && described.tone === 'error' && (
          <div className="login__error" role="alert">
            <strong className="login__error-title">{described.title}</strong>
            <p className="login__error-text">{described.text}</p>
          </div>
        )}

        {described && described.tone === 'info' && (
          <p className="login__info" role="status">
            {described.text}
          </p>
        )}

        {isMock && (
          <p className="login__note">
            <MockBadge /> Đây là đăng nhập giả lập: không dùng Firebase Authentication và không có Firebase ID
            token thật. Để đăng nhập Google thật, tạo .env.local với các biến VITE_FIREBASE_* (xem .env.example).
          </p>
        )}

        {mode === 'firebase' && (
          <p className="login__note">Đăng nhập bằng Firebase Authentication (Google).</p>
        )}
      </section>
    </main>
  );
}
