import { Navigate, Outlet, useLocation } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { ROUTES } from '../../constants/routes';
import { LoadingState } from '../common/LoadingState';

// Chặn các trang cần đăng nhập. Ghi nhớ trang đang muốn vào (state.from)
// để sau khi đăng nhập quay lại đúng trang đó.
export function ProtectedRoute() {
  const { user, initializing } = useAuth();
  const location = useLocation();

  if (initializing) {
    return <LoadingState message="Đang kiểm tra đăng nhập…" fullPage />;
  }

  if (!user) {
    return <Navigate to={ROUTES.login} replace state={{ from: location }} />;
  }

  return <Outlet />;
}
