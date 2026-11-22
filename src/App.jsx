import { Navigate, Route, Routes } from 'react-router';
import { ROUTES } from './presentation/constants/routes';
import { ProtectedRoute } from './presentation/components/layout/ProtectedRoute';
import { AppLayout } from './presentation/components/layout/AppLayout';
import { LoginPage } from './presentation/pages/LoginPage';
import { UploadPage } from './presentation/pages/UploadPage';
import { GalleryPage } from './presentation/pages/GalleryPage';
import { NotFoundPage } from './presentation/pages/NotFoundPage';

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
