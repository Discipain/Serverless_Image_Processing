import { Navigate, Route, Routes } from 'react-router';
import { ROUTES } from './constants/routes';
import { ProtectedRoute } from './components/layout/ProtectedRoute';
import { AppLayout } from './components/layout/AppLayout';
import { LoginPage } from './pages/LoginPage';
import { UploadPage } from './pages/UploadPage';
import { GalleryPage } from './pages/GalleryPage';
import { NotFoundPage } from './pages/NotFoundPage';

export default function App() {
  return (
    <Routes>
      {/* Trang công khai */}
      <Route path={ROUTES.login} element={<LoginPage />} />

      {/* Các trang cần đăng nhập, dùng chung layout có header */}
      <Route element={<ProtectedRoute />}>
        <Route element={<AppLayout />}>
          <Route path={ROUTES.home} element={<Navigate to={ROUTES.gallery} replace />} />
          <Route path={ROUTES.upload} element={<UploadPage />} />
          <Route path={ROUTES.gallery} element={<GalleryPage />} />
        </Route>
      </Route>

      <Route path="*" element={<NotFoundPage />} />
    </Routes>
  );
}
