import { Link, useSearchParams } from 'react-router';
import { useAuth } from '../hooks/useAuth';
import { useImageList } from '../hooks/useImageList';
import { useGalleryList } from '../hooks/useGalleryList';
import { useGalleryServices } from '../hooks/useGalleryServices';
import { ROUTES } from '../constants/routes';
import { PAGE_SIZE } from '../../domain/constants/imageRules';
import { MOCK_SCENARIOS } from '../../services/mock/mockImageService';
import { LoadingState } from '../components/common/LoadingState';
import { EmptyState } from '../components/common/EmptyState';
import { ErrorState } from '../components/common/ErrorState';
import { MockBadge } from '../components/common/MockBadge';
import { GalleryGrid } from '../components/gallery/GalleryGrid';
import { RealGalleryView } from '../components/gallery/RealGalleryView';

const SCENARIO_LINKS = [
  { value: MOCK_SCENARIOS.NORMAL, label: 'Bình thường' },
  { value: MOCK_SCENARIOS.EMPTY, label: 'Rỗng' },
  { value: MOCK_SCENARIOS.ERROR, label: 'Lỗi' },
];

/**
 * Chọn nguồn dữ liệu theo GalleryServices do composition root cung cấp (src/app/createGalleryServices.js):
 *   - 'mock' (MẶC ĐỊNH): Gallery MOCK như trước INT-3B.
 *   - 'real': đọc từ Backend qua use case INT-3A, có phân trang.
 *   - 'invalid': cấu hình REAL sai => báo lỗi cấu hình; KHÔNG bao giờ tự chuyển sang MOCK.
 * THIẾU Provider (INT-3C.1): useGalleryServices suy ra từ VITE_GALLERY_MODE — trống/"mock" -> MOCK kèm cảnh báo `missingProvider`;
 * "real" hoặc giá trị lạ -> 'invalid' (lỗi cấu hình, không MOCK, không request).
 */
export function GalleryPage() {
  const services = useGalleryServices();
  if (services.mode === 'real') return <RealGalleryPage services={services} />;
  if (services.mode === 'invalid') return <GalleryConfigError error={services.configError} />;
  return <MockGalleryPage missingProviderNotice={services.missingProvider === true ? services.notice : null} />;
}

function GalleryConfigError({ error }) {
  return (
    <section aria-labelledby="gallery-title">
      <header className="page-header">
        <h1 id="gallery-title">Thư viện ảnh</h1>
      </header>
      <ErrorState title="Cấu hình Gallery REAL không hợp lệ" error={error} />
    </section>
  );
}

function RealGalleryPage({ services }) {
  const { user, isMock: authIsMock } = useAuth();
  // REAL chỉ dùng với Firebase Authentication thật. Đăng nhập MOCK => không có ownerId => không có request.
  const ownerId = authIsMock ? null : (user?.uid ?? null);
  const list = useGalleryList({ ownerId, listPage: services.listPage, pageSize: PAGE_SIZE });

  if (authIsMock) {
    return (
      <GalleryConfigError
        error={{ message: 'Gallery REAL cần đăng nhập Firebase thật; phiên hiện tại là đăng nhập MOCK nên không tải dữ liệu.' }}
      />
    );
  }
  return <RealGalleryView list={list} onReload={list.reload} onLoadMore={list.loadMore} />;
}

function MockGalleryPage({ missingProviderNotice = null }) {
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
            Thư viện ảnh <MockBadge />
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

      {missingProviderNotice && (
        <p className="notice" role="status">
          {missingProviderNotice}
        </p>
      )}

      {/* Gallery đang ở chế độ MOCK (mặc định). Dữ liệu luôn là MOCK, kể cả khi đã đăng nhập Firebase thật. */}
      {!isMock && (
        <p className="notice" role="note">
          Bạn đang đăng nhập Firebase thật, nhưng thư viện CHƯA kết nối Firestore (sẽ làm ở bước sau). Dữ liệu
          bên dưới chỉ là kho MOCK; ảnh MOCK không thuộc UID của tài khoản này nên danh sách có thể trống.
        </p>
      )}

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

      {content}
    </section>
  );
}
