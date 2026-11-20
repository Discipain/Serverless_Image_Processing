import { Link } from 'react-router';
import { ROUTES } from '../constants/routes';
import { EmptyState } from '../components/common/EmptyState';

export function NotFoundPage() {
  return (
    <main className="main container">
      <EmptyState title="Không tìm thấy trang" description="Đường dẫn bạn mở không tồn tại.">
        <Link to={ROUTES.gallery} className="btn btn--primary">
          Về thư viện ảnh
        </Link>
      </EmptyState>
    </main>
  );
}
