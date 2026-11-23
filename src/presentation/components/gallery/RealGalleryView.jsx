import { Link } from 'react-router';
import { ROUTES } from '../../constants/routes';
import { PAGE_SIZE } from '../../../domain/constants/imageRules';
import { LoadingState } from '../common/LoadingState';
import { EmptyState } from '../common/EmptyState';
import { ErrorState } from '../common/ErrorState';
import { RealBadge } from '../common/RealBadge';
import { GalleryGrid } from './GalleryGrid';

/**
 * Giao diện Gallery chế độ REAL (thuần trình bày: nhận state từ useGalleryList).
 * Không có nhãn MOCK, không có thanh kịch bản MOCK. Lỗi (kể cả 503) luôn hiện thành lỗi, không bao giờ thành "Chưa có ảnh".
 * @param {{list: object, onReload: () => void, onLoadMore: () => void}} props
 */
export function RealGalleryView({ list, onReload, onLoadMore }) {
  const { status, items, hasMore, loadingMore, error, loadMoreError } = list;
  const initialLoading = status === 'loading' || status === 'idle';

  let content;
  if (initialLoading) {
    content = <LoadingState message="Đang tải danh sách ảnh…" />;
  } else if (status === 'error') {
    content = <ErrorState title="Không tải được thư viện" error={error} onRetry={onReload} />;
  } else if (items.length === 0) {
    content = (
      <EmptyState title="Chưa có ảnh nào" description="Hãy tải ảnh đầu tiên lên để bắt đầu.">
        <Link to={ROUTES.upload} className="btn btn--primary">
          Tải ảnh lên
        </Link>
      </EmptyState>
    );
  } else {
    content = (
      <>
        <GalleryGrid images={items} />
        <div className="gallery-more">
          {loadMoreError && (
            <p className="gallery-more__error" role="alert">
              Không tải thêm được: {loadMoreError.message || 'vui lòng thử lại.'} Các ảnh đã tải vẫn được giữ lại.
            </p>
          )}
          {hasMore ? (
            <button type="button" className="btn btn--ghost" onClick={onLoadMore} disabled={loadingMore}>
              {loadingMore ? 'Đang tải thêm…' : loadMoreError ? 'Thử tải thêm lại' : 'Tải thêm'}
            </button>
          ) : (
            <p className="gallery-more__end">Đã hiển thị hết ảnh.</p>
          )}
        </div>
      </>
    );
  }

  return (
    <section aria-labelledby="gallery-title">
      <header className="page-header page-header--row">
        <div>
          <h1 id="gallery-title">
            Thư viện ảnh <RealBadge />
          </h1>
          <p className="page-header__text">
            {initialLoading || status === 'error'
              ? 'Ảnh của bạn, mới nhất trước.'
              : `${items.length} ảnh đã tải${hasMore ? ' · còn nữa' : ''} · mỗi lần tải tối đa ${PAGE_SIZE} ảnh.`}
          </p>
        </div>
        <button type="button" className="btn btn--ghost" onClick={onReload} disabled={initialLoading}>
          Làm mới
        </button>
      </header>
      {content}
    </section>
  );
}
