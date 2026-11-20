import { ALLOWED_EXTENSIONS_LABEL, MAX_SIZE_BYTES } from '../constants/image';
import { formatBytes } from '../utils/format';

// Bước 2 chỉ dựng khung giao diện. Chọn file, validate, xử lý và upload
// sẽ được triển khai ở bước tiếp theo — vùng kéo thả đang bị vô hiệu hóa.
export function UploadPage() {
  return (
    <section aria-labelledby="upload-title">
      <header className="page-header">
        <h1 id="upload-title">Tải ảnh lên</h1>
        <p className="page-header__text">
          Ảnh sẽ được nén thành 3 phiên bản WebP (thumbnail, medium, full) ngay trên trình duyệt
          trước khi lưu.
        </p>
      </header>

      <div className="dropzone dropzone--disabled" aria-disabled="true">
        <div className="dropzone__icon" aria-hidden="true">⬆️</div>
        <p className="dropzone__title">Kéo thả ảnh vào đây hoặc bấm để chọn</p>
        <p className="dropzone__hint">
          Định dạng {ALLOWED_EXTENSIONS_LABEL} · Tối đa {formatBytes(MAX_SIZE_BYTES)} mỗi ảnh
        </p>
        <button type="button" className="btn btn--primary" disabled>
          Chọn ảnh
        </button>
      </div>

      <p className="notice">
        Chức năng tải ảnh lên chưa được triển khai ở bước này (chỉ có giao diện).
      </p>
    </section>
  );
}
