import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ALLOWED_EXTENSIONS_LABEL, ALLOWED_TYPES, MAX_SIZE_BYTES } from '../../domain/constants/imageRules';
import { formatBytes } from '../utils/format';
import { ROUTES } from '../constants/routes';
import { useUploadServices } from '../hooks/useUploadServices';
import { useUploadFlow } from '../hooks/useUploadFlow';
import { MockBadge } from '../components/common/MockBadge';
import { UploadFlowStatus } from '../components/upload/UploadFlowStatus';

// H4A: luồng upload chạy HOÀN TOÀN bằng MOCK (nén thật cục bộ; upload và confirm giả lập).
// Không gọi Cloudinary/FastAPI thật, không ghi Firestore.
export function UploadPage() {
  const services = useUploadServices();
  const { state, selectFile, retry, cancel, reset } = useUploadFlow();
  const [searchParams] = useSearchParams();
  const scenario = searchParams.get('mock') || 'normal';
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  // Kịch bản MOCK chọn qua ?mock=... (đọc lại mỗi lần có thao tác tiếp theo).
  useEffect(() => {
    services.scenario.set(scenario);
  }, [services, scenario]);

  const running = state.phase === 'running';
  const showDropzone = !running && state.phase !== 'done';

  function handleFiles(files) {
    const file = files?.[0];
    if (file) selectFile(file);
  }

  return (
    <section aria-labelledby="upload-title">
      <header className="page-header">
        <h1 id="upload-title">
          Tải ảnh lên <MockBadge />
        </h1>
        <p className="page-header__text">
          Ảnh được kiểm tra, nén thành 3 phiên bản WebP (thumbnail, medium, full) ngay trên trình duyệt rồi chạy qua
          luồng Hybrid giả lập.
        </p>
      </header>

      <p className="mock-banner" role="note">
        <strong>MOCK – Không upload Cloudinary, không ghi Firestore.</strong> Bước nén là thật nhưng chỉ chạy trong
        trình duyệt; upload và xác nhận Backend đều là giả lập, kết quả không phải dữ liệu thật.
      </p>
      {services.notice && (
        <p className="notice" role="note">
          {services.notice}
        </p>
      )}

      <nav className="scenario-bar" aria-label="Kịch bản MOCK của trang Upload">
        <span>Thử trạng thái MOCK:</span>
        {services.scenarios.map((s) => (
          <Link
            key={s.value}
            to={s.value === 'normal' ? ROUTES.upload : `${ROUTES.upload}?mock=${s.value}`}
            className={`scenario-bar__link${scenario === s.value ? ' scenario-bar__link--active' : ''}`}
            aria-current={scenario === s.value ? 'true' : undefined}
          >
            {s.label}
          </Link>
        ))}
      </nav>

      {showDropzone && (
        <div
          className={`dropzone${dragging ? ' dropzone--active' : ''}`}
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={(event) => {
            event.preventDefault();
            setDragging(false);
            handleFiles(event.dataTransfer?.files);
          }}
        >
          <div className="dropzone__icon" aria-hidden="true">⬆️</div>
          <p className="dropzone__title">Kéo thả ảnh vào đây hoặc bấm để chọn</p>
          <p className="dropzone__hint">
            Định dạng {ALLOWED_EXTENSIONS_LABEL} · Tối đa {formatBytes(MAX_SIZE_BYTES)} mỗi ảnh
          </p>
          <input
            ref={inputRef}
            type="file"
            accept={ALLOWED_TYPES.join(',')}
            className="dropzone__input"
            aria-label="Chọn ảnh để tải lên"
            onChange={(event) => {
              handleFiles(event.target.files);
              event.target.value = ''; // cho phép chọn lại đúng file đó
            }}
          />
          <button type="button" className="btn btn--primary" onClick={() => inputRef.current?.click()}>
            Chọn ảnh
          </button>
        </div>
      )}

      <UploadFlowStatus state={state} onRetry={retry} onCancel={cancel} onReset={reset} />
    </section>
  );
}
