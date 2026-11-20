import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import { useImageList } from '../hooks/useImageList';
import { ROUTES } from '../constants/routes';
import { PAGE_SIZE } from '../constants/image';
import { MOCK_SCENARIOS } from '../services/mock/mockImageService';
import { LoadingState } from '../components/common/LoadingState';
import { EmptyState } from '../components/common/EmptyState';
import { ErrorState } from '../components/common/ErrorState';
import { MockBadge } from '../components/common/MockBadge';
import { GalleryGrid } from '../components/gallery/GalleryGrid';

const SCENARIO_LINKS = [
  { value: MOCK_SCENARIOS.NORMAL, label: 'Bình thường' },
  { value: MOCK_SCENARIOS.EMPTY, label: 'Rỗng' },
  { value: MOCK_SCENARIOS.ERROR, label: 'Lỗi' },
];

export function GalleryPage() {
  const { user, isMock } = useAuth();
  const [searchParams] = useSearchParams();
  const scenario = searchParams.get('mock') || MOCK_SCENARIOS.NORMAL;
  const { items, loading, error, reload } = useImageList(user?.uid, scenario);

  let content;
  if (loading) {
    content = <LoadingState message="Đang tải danh sách ảnh…" />;
  } else if (error) {
    content = <ErrorState title="Không tải được thư viện" error={error} onRetry={reload} />;
  } else if (items.length === 0) {
    content = (
      <EmptyState
        title="Chưa có ảnh nào"
        description="Hãy tải ảnh đầu tiên lên để bắt đầu."
      >
        <Link to={ROUTES.upload} className="btn btn--primary">
          Tải ảnh lên
        </Link>
      </EmptyState>
    );
  } else {
    content = <GalleryGrid images={items} />;
  }

  return (
    <section aria-labelledby="gallery-title">
      <header className="page-header page-header--row">
        <div>
          <h1 id="gallery-title">
            Thư viện ảnh {isMock && <MockBadge />}
          </h1>
          <p className="page-header__text">
            {loading || error
              ? 'Ảnh của bạn, mới nhất trước.'
              : `${items.length} ảnh · tối đa ${PAGE_SIZE} ảnh mới nhất mỗi lần tải.`}
          </p>
        </div>
        <button type="button" className="btn btn--ghost" onClick={reload} disabled={loading}>
          Làm mới
        </button>
      </header>

      {isMock && (
        <nav className="scenario-bar" aria-label="Kịch bản dữ liệu MOCK">
          <span>Thử trạng thái MOCK:</span>
          {SCENARIO_LINKS.map((s) => (
            <Link
              key={s.value}
              to={s.value === MOCK_SCENARIOS.NORMAL ? ROUTES.gallery : `${ROUTES.gallery}?mock=${s.value}`}
              className={`scenario-bar__link${scenario === s.value ? ' scenario-bar__link--active' : ''}`}
              aria-current={scenario === s.value ? 'true' : undefined}
            >
              {s.label}
            </Link>
          ))}
        </nav>
      )}

      {content}
    </section>
  );
}
