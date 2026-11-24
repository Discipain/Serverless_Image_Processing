import { useEffect, useRef, useState } from 'react';
import { Link, useSearchParams } from 'react-router';
import { ALLOWED_EXTENSIONS_LABEL, ALLOWED_TYPES, MAX_SIZE_BYTES } from '../../domain/constants/imageRules';
import { formatBytes } from '../utils/format';
import { ROUTES } from '../constants/routes';
import { useUploadServices } from '../hooks/useUploadServices';
import { useUploadFlow } from '../hooks/useUploadFlow';
import { MockBadge } from '../components/common/MockBadge';
import { RealBadge } from '../components/common/RealBadge';
import { UploadFlowStatus } from '../components/upload/UploadFlowStatus';

// Trang Upload có BA chế độ do composition root quyết định (services.mode), không bao giờ tự đoán hay fallback:
//   'mock'    — H4A: nén thật cục bộ; upload và confirm giả lập. Không gọi Cloudinary/FastAPI thật, không ghi Firestore. MẶC ĐỊNH.
//   'real'    — H4B-5: Signed Upload (authorize -> upload có chữ ký -> confirm) với Backend localhost; chỉ khi VITE_UPLOAD_MODE=real đủ điều kiện.
//   'invalid' — cấu hình sai: hiện lỗi cấu hình, KHÔNG có vùng chọn ảnh, KHÔNG MOCK, KHÔNG upload không ký, không request nào.
export function UploadPage() {
  const services = useUploadServices();
  const { state, selectFile, retry, restart, cancel, reset } = useUploadFlow();
  const mode = services.mode;
  const [searchParams] = useSearchParams();
  const scenario = searchParams.get('mock') || 'normal';
  const inputRef = useRef(null);
  const [dragging, setDragging] = useState(false);

  // Kịch bản MOCK chọn qua ?mock=... (đọc lại mỗi lần có thao tác tiếp theo).
  useEffect(() => {
    services.scenario.set(scenario);
  }, [services, scenario]);

  const running = state.phase === 'running';
  const showDropzone = mode !== 'invalid' && !running && state.phase !== 'done';

  function handleFiles(files) {
    const file = files?.[0];
    if (file) selectFile(file);
  }

  return (
    <section aria-labelledby="upload-title">
      <header className="page-header">
        <h1 id="upload-title">
          Tải ảnh lên {mode === 'real' ? <RealBadge label="REAL" /> : mode === 'mock' ? <MockBadge /> : null}
        </h1>
        <p className="page-header__text">
          {mode === 'real'
            ? 'Ảnh được kiểm tra, nén thành 3 phiên bản WebP (thumbnail, medium, full) ngay trên trình duyệt, xin quyền tải lên từ Backend, tải lên Cloudinary bằng chữ ký rồi chờ Backend xác nhận.'
            : 'Ảnh được kiểm tra, nén thành 3 phiên bản WebP (thumbnail, medium, full) ngay trên trình duyệt rồi chạy qua luồng Hybrid giả lập.'}
        </p>
      </header>

      {mode === 'mock' && (
        <p className="mock-banner" role="note">
          <strong>MOCK – Không upload Cloudinary, không ghi Firestore.</strong> Bước nén là thật nhưng chỉ chạy trong
          trình duyệt; upload và xác nhận Backend đều là giả lập, kết quả không phải dữ liệu thật.
        </p>
      )}
      {mode === 'real' && (
        <p className="notice" role="note">
          <strong>REAL – Ảnh sẽ được tải lên Cloudinary và ghi vào Firestore qua Backend (môi trường phát triển).</strong> Chỉ dùng ảnh thử
          không nhạy cảm. Upload dùng chữ ký do Backend cấp; nếu cấu hình sai, trang báo lỗi cấu hình chứ không tự đổi chế độ.
        </p>
      )}
      {mode === 'invalid' && (
        <div className="upload-status upload-status--error" role="alert">
          <p className="upload-status__title">Lỗi cấu hình Upload</p>
          <p>{services.configError?.message}</p>
          <p className="upload-status__muted">Trang không upload gì, không dùng MOCK và không upload không ký thay thế.</p>
        </div>
      )}
      {services.notice && (
        <p className="notice" role="note">
          {services.notice}
        </p>
      )}

      {mode === 'mock' && services.scenarios.length > 0 && (
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
      )}

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

      <UploadFlowStatus state={state} mode={mode === 'real' ? 'real' : 'mock'} onRetry={retry} onRestart={restart} onCancel={cancel} onReset={reset} />
    </section>
  );
}
