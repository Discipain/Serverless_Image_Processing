import { useState } from 'react';
import { Navigate, useLocation, useNavigate } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import { ROUTES } from '../constants/routes';
import { MockBadge } from '../components/common/MockBadge';

export function LoginPage() {
  const { user, isMock, login } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState(null);

  // Trang người dùng định vào trước khi bị chuyển sang /login.
  const redirectTo = location.state?.from?.pathname || ROUTES.gallery;

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
      setError(err?.message || 'Đăng nhập thất bại, vui lòng thử lại.');
      setSubmitting(false);
    }
  }

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
          disabled={submitting}
        >
          {submitting ? 'Đang đăng nhập…' : isMock ? 'Đăng nhập (MOCK)' : 'Đăng nhập với Google'}
        </button>

        {error && (
          <p className="login__error" role="alert">
            {error}
          </p>
        )}

        {isMock && (
          <p className="login__note">
            <MockBadge /> Đây là đăng nhập giả lập, chưa dùng Firebase Authentication. Google
            Sign-In sẽ được tích hợp khi nhóm trưởng đăng ký Web App.
          </p>
        )}
      </section>
    </main>
  );
}
