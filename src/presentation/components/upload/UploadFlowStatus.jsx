import { useEffect, useState } from 'react';
import { ERROR_CODE } from '../../../application/errors';
import { sumProcessedSize } from '../../../domain/models/image';
import { formatBytes, formatSavedPercent } from '../../utils/format';
import { MockBadge } from '../common/MockBadge';
import { LoadingState } from '../common/LoadingState';

const STAGE_TEXT = {
  VALIDATING: 'Đang kiểm tra file…',
  COMPRESSING: 'Đang nén thành 3 bản WebP (thumbnail, medium, full) ngay trên trình duyệt…',
  UPLOADING: 'Đang upload giả lập (MOCK) 3 biến thể…',
  CONFIRMING: 'Đang xác nhận với Backend giả lập (MOCK)…',
};

const RETRY_TEXT = {
  CONFIRMING: 'Thử lại xác nhận (không upload lại)',
  UPLOADING: 'Thử lại upload (MOCK)',
  COMPRESSING: 'Thử lại nén',
};

const ERROR_TITLE = {
  [ERROR_CODE.VALIDATION]: 'File hoặc dữ liệu không hợp lệ',
  [ERROR_CODE.UNAUTHENTICATED]: 'Chưa xác thực',
  [ERROR_CODE.FORBIDDEN]: 'Không có quyền',
  [ERROR_CODE.NETWORK]: 'Lỗi kết nối',
  [ERROR_CODE.QUOTA_EXCEEDED]: 'Gọi quá nhanh hoặc vượt hạn mức',
  [ERROR_CODE.CANCELLED]: 'Đã hủy',
  [ERROR_CODE.CONFIG]: 'Lỗi cấu hình',
};

const VARIANT_LABEL = { thumbnail: 'Thumbnail (≤200px)', medium: 'Medium (≤800px)', webp: 'Full WebP' };

// Xem trước bằng dữ liệu CỤC BỘ (data URL từ Blob đã nén trong bộ nhớ) — tuyệt đối không dùng URL Cloudinary giả.
function LocalPreview({ blob }) {
  const [src, setSrc] = useState(null);
  useEffect(() => {
    if (!blob) return undefined;
    const reader = new FileReader();
    reader.onload = () => setSrc(typeof reader.result === 'string' ? reader.result : null);
    reader.onerror = () => setSrc(null);
    reader.readAsDataURL(blob);
    return () => {
      reader.onload = null;
      reader.onerror = null;
      if (reader.readyState === 1) reader.abort();
    };
  }, [blob]);
  if (!src) return null;
  return <img className="upload-result__preview" src={src} alt="Xem trước thumbnail (từ bộ nhớ trình duyệt)" />;
}

function Row({ label, children }) {
  return (
    <div className="upload-result__row">
      <dt>{label}</dt>
      <dd>{children}</dd>
    </div>
  );
}

function ProgressBlock({ state, onCancel }) {
  const { stage, progress } = state;
  const showCancel = stage === 'UPLOADING' || stage === 'CONFIRMING';
  return (
    <div className="upload-status" role="status" aria-live="polite">
      <p className="upload-status__title">
        {STAGE_TEXT[stage] ?? 'Đang xử lý…'} <MockBadge />
      </p>
      {state.fileName && <p className="upload-status__muted">File: {state.fileName}</p>}
      {state.imageId && (
        <p className="upload-status__muted">
          imageId (tạo một lần trước khi nén): <code>{state.imageId}</code>
        </p>
      )}
      {stage === 'UPLOADING' && progress && (
        <>
          <progress className="upload-status__bar" max={100} value={progress.overallPercent} aria-label="Tiến độ upload giả lập" />
          <p className="upload-status__muted">
            Tiến độ giả lập (MOCK): {progress.overallPercent}%{progress.variant ? ` · đang gửi ${VARIANT_LABEL[progress.variant] ?? progress.variant}: ${progress.variantPercent}%` : ''}
          </p>
        </>
      )}
      {(stage === 'COMPRESSING' || stage === 'CONFIRMING') && <LoadingState message="Vui lòng chờ…" />}
      {showCancel && (
        <button type="button" className="btn btn--ghost" onClick={onCancel}>
          Hủy
        </button>
      )}
    </div>
  );
}

function ResultBlock({ result, onReset }) {
  const { file, processed, assets, confirm, imageId } = result;
  const blobs = processed.blobs;
  const total = sumProcessedSize({ thumbnail: blobs.thumbnail.size, medium: blobs.medium.size, webp: blobs.webp.size });
  const saved = formatSavedPercent(file.size, total);
  return (
    <div className="upload-result" role="status">
      <h2 className="upload-result__title">
        Hoàn tất (MOCK) <MockBadge />
      </h2>
      <p className="mock-banner">
        Đây là kết quả GIẢ LẬP: không có ảnh nào được gửi lên Cloudinary và không có gì được ghi vào Firestore.
      </p>
      <LocalPreview blob={blobs.thumbnail} />
      <dl className="upload-result__list">
        <Row label="imageId"><code>{imageId}</code></Row>
        <Row label="Trạng thái">DONE (do Backend GIẢ LẬP xác nhận — không phải Backend thật)</Row>
        <Row label="File gốc">{file.name} · {formatBytes(file.size)} · {processed.width}×{processed.height}</Row>
        {Object.keys(VARIANT_LABEL).map((key) => (
          <Row key={key} label={VARIANT_LABEL[key]}>
            {formatBytes(blobs[key].size)} · URL giả: <code>{assets[key].secureUrl}</code> · public_id giả: <code>{assets[key].publicId}</code>
          </Row>
        ))}
        <Row label="Thời gian nén">{processed.processingMs} ms</Row>
        <Row label="Tiết kiệm (tính cục bộ)">
          {saved ?? '—'} <span className="upload-status__muted">(tổng 3 biến thể so với file gốc; không phải số của Backend)</span>
        </Row>
        <Row label="savedPercent từ Backend giả">
          {confirm.savedPercent === null ? 'không có (Backend không trả)' : `${confirm.savedPercent}% (MOCK tính từ originalSize và processedSize)`}
        </Row>
      </dl>
      <p className="upload-status__muted">Các URL ở trên chỉ là chuỗi giả lập, không tồn tại trên Cloudinary và không được mở.</p>
      <button type="button" className="btn btn--primary" onClick={onReset}>
        Tải ảnh khác
      </button>
    </div>
  );
}

function ErrorBlock({ error, onRetry, onReset }) {
  const title = ERROR_TITLE[error.code] ?? 'Không hoàn tất được';
  const retryLabel = RETRY_TEXT[error.stage] ?? 'Thử lại';
  const orphan = error.uploadedVariants.length;
  return (
    <div className="upload-status upload-status--error" role="alert">
      <p className="upload-status__title">
        {title} <MockBadge />
      </p>
      <p>{error.message}</p>
      {error.stage === 'UPLOADING' && orphan > 0 && (
        <p className="upload-status__muted">
          {orphan} biến thể đã “upload” giả lập ({error.uploadedVariants.join(', ')}). Với Cloudinary thật, đây sẽ là ảnh mồ côi cần Backend xử lý.
        </p>
      )}
      {error.stage === 'CONFIRMING' && (
        <p className="upload-status__muted">Ảnh chưa được coi là hoàn tất (chưa DONE). Các biến thể đã “upload” được giữ lại; thử lại chỉ gửi xác nhận, dùng lại cùng imageId.</p>
      )}
      {error.imageId && (
        <p className="upload-status__muted">
          imageId: <code>{error.imageId}</code>
        </p>
      )}
      <div className="upload-status__actions">
        {error.retryable && (
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            {retryLabel}
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Chọn ảnh khác
        </button>
      </div>
    </div>
  );
}

/** Hiển thị trạng thái của luồng upload theo state của uploadFlowReducer. Idle: không hiển thị gì. */
export function UploadFlowStatus({ state, onRetry, onCancel, onReset }) {
  if (state.phase === 'running') return <ProgressBlock state={state} onCancel={onCancel} />;
  if (state.phase === 'done' && state.result) return <ResultBlock result={state.result} onReset={onReset} />;
  if (state.phase === 'error' && state.error) return <ErrorBlock error={state.error} onRetry={onRetry} onReset={onReset} />;
  return null;
}
