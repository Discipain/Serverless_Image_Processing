import { useEffect, useState } from 'react';
import { Link } from 'react-router';
import { ERROR_CODE } from '../../../application/errors';
import { sumProcessedSize } from '../../../domain/models/image';
import { ROUTES } from '../../constants/routes';
import { formatBytes, formatSavedPercent, remainingSeconds } from '../../utils/format';
import { MockBadge } from '../common/MockBadge';
import { RealBadge } from '../common/RealBadge';
import { LoadingState } from '../common/LoadingState';

// Hai bộ chữ: MOCK (giữ NGUYÊN từng chữ của H4A) và REAL (Signed Upload, H4B-5). `mode` mặc định 'mock' để tương thích.
const STAGE_TEXT = {
  mock: {
    VALIDATING: 'Đang kiểm tra file…',
    COMPRESSING: 'Đang nén thành 3 bản WebP (thumbnail, medium, full) ngay trên trình duyệt…',
    UPLOADING: 'Đang upload giả lập (MOCK) 3 biến thể…',
    CONFIRMING: 'Đang xác nhận với Backend giả lập (MOCK)…',
  },
  real: {
    VALIDATING: 'Đang kiểm tra file…',
    COMPRESSING: 'Đang nén thành 3 bản WebP (thumbnail, medium, full) ngay trên trình duyệt…',
    AUTHORIZING: 'Đang xin quyền tải ảnh lên…',
    UPLOADING: 'Đang tải 3 biến thể lên Cloudinary (có chữ ký của Backend)…',
    CONFIRMING: 'Đang chờ Backend xác nhận ảnh…',
  },
};

const RETRY_TEXT = {
  mock: {
    CONFIRMING: 'Thử lại xác nhận (không upload lại)',
    UPLOADING: 'Thử lại upload (MOCK)',
    COMPRESSING: 'Thử lại nén',
  },
  real: {
    CONFIRMING: 'Thử lại xác nhận (không upload lại)',
    UPLOADING: 'Thử lại upload (chỉ biến thể còn thiếu)',
    AUTHORIZING: 'Thử lại xin quyền tải ảnh lên',
    COMPRESSING: 'Thử lại nén',
  },
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

// Tiêu đề theo `details.kind` của luồng Signed Upload (ưu tiên hơn tiêu đề theo code).
const KIND_TITLE = {
  GRANT_EXPIRED: 'Quyền upload đã hết hạn',
  AUTHORIZE_UNSUPPORTED: 'Backend chưa hỗ trợ upload có chữ ký',
  SIGNED_UNAVAILABLE: 'Backend chưa bật upload có chữ ký',
  ASSETS_NOT_FOUND: 'Backend chưa thấy ảnh trên Cloudinary',
  AUTH_CHANGED: 'Tài khoản đã thay đổi',
  SESSION_OWNER_MISMATCH: 'Phiên upload không thuộc tài khoản này',
};

const VARIANT_LABEL = { thumbnail: 'Thumbnail (≤200px)', medium: 'Medium (≤800px)', webp: 'Full WebP' };

function ModeBadge({ mode }) {
  return mode === 'real' ? <RealBadge label="REAL" /> : <MockBadge />;
}

// Đếm ngược tới `notBefore`. Interval chỉ chạy khi còn thời gian; dọn khi hết giờ, khi đổi mốc hoặc khi unmount. KHÔNG gọi gì khi về 0.
function useRemainingSeconds(notBefore) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!Number.isFinite(notBefore) || Date.now() >= notBefore) return undefined;
    const id = setInterval(() => {
      const current = Date.now();
      setNow(current);
      if (current >= notBefore) clearInterval(id);
    }, 250);
    return () => clearInterval(id);
  }, [notBefore]);
  return remainingSeconds(notBefore, now);
}

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

const dims = (v) => (v?.width && v?.height ? ` · ${v.width}×${v.height}` : '');

function ProgressBlock({ state, mode, onCancel }) {
  const { stage, progress } = state;
  const real = mode === 'real';
  const showCancel = stage === 'UPLOADING' || stage === 'CONFIRMING' || (real && stage === 'AUTHORIZING');
  const loading = stage === 'COMPRESSING' || stage === 'CONFIRMING' || (real && stage === 'AUTHORIZING');
  return (
    <div className="upload-status" role="status" aria-live="polite">
      <p className="upload-status__title">
        {STAGE_TEXT[mode]?.[stage] ?? 'Đang xử lý…'} <ModeBadge mode={mode} />
      </p>
      {state.fileName && (
        <p className="upload-status__muted">
          File: {state.fileName}
          {Number.isFinite(state.fileSize) ? ` · ${formatBytes(state.fileSize)} (ảnh gốc)` : ''}
        </p>
      )}
      {state.variants && (
        <ul className="upload-status__muted" aria-label="Kết quả xử lý các biến thể">
          {Object.keys(VARIANT_LABEL).map((key) => (
            <li key={key}>
              {VARIANT_LABEL[key]}: {formatBytes(state.variants[key]?.bytes ?? 0)}
              {dims(state.variants[key])}
            </li>
          ))}
        </ul>
      )}
      {state.imageId && (
        <p className="upload-status__muted">
          imageId (tạo một lần trước khi nén): <code>{state.imageId}</code>
        </p>
      )}
      {stage === 'UPLOADING' && progress && (
        <>
          <progress className="upload-status__bar" max={100} value={progress.overallPercent} aria-label={real ? 'Tiến độ upload' : 'Tiến độ upload giả lập'} />
          <p className="upload-status__muted">
            {real ? 'Tiến độ upload' : 'Tiến độ giả lập (MOCK)'}: {progress.overallPercent}%
            {progress.variant ? ` · đang gửi ${VARIANT_LABEL[progress.variant] ?? progress.variant}: ${progress.variantPercent}%` : ''}
          </p>
        </>
      )}
      {loading && <LoadingState message="Vui lòng chờ…" />}
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

// Kết quả REAL: chỉ hiển thị khi use case đã nhận DONE hợp lệ từ Backend. Không hiển thị chữ ký, token, session hay response authorize.
function RealResultBlock({ result, onReset }) {
  const { file, processed, assets, confirm, imageId } = result;
  const blobs = processed.blobs;
  const existing = Array.isArray(result.existingVariants) ? result.existingVariants : [];
  return (
    <div className="upload-result" role="status">
      <h2 className="upload-result__title">
        Hoàn tất <RealBadge label="REAL" />
      </h2>
      <LocalPreview blob={blobs.thumbnail} />
      <dl className="upload-result__list">
        <Row label="imageId"><code>{imageId}</code></Row>
        <Row label="Trạng thái">DONE (Backend đã xác nhận)</Row>
        <Row label="File gốc">{file.name} · {formatBytes(file.size)} · {processed.width}×{processed.height}</Row>
        {Object.keys(VARIANT_LABEL).map((key) => (
          <Row key={key} label={VARIANT_LABEL[key]}>
            {formatBytes(blobs[key].size)} · URL: <code>{assets[key].secureUrl}</code> · public_id: <code>{assets[key].publicId}</code>
          </Row>
        ))}
        <Row label="Thời gian nén">{processed.processingMs} ms</Row>
        <Row label="savedPercent từ Backend">{confirm.savedPercent === null ? 'không có (Backend không trả)' : `${confirm.savedPercent}%`}</Row>
      </dl>
      {existing.length > 0 && (
        <p className="upload-status__muted">
          Cloudinary báo biến thể {existing.join(', ')} đã tồn tại từ lần gửi trước (không phải upload mới); Backend vẫn đã xác minh ảnh.
        </p>
      )}
      <div className="upload-status__actions">
        <Link className="btn btn--primary" to={ROUTES.gallery}>
          Xem thư viện ảnh
        </Link>
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Tải ảnh khác
        </button>
      </div>
    </div>
  );
}

// Nút "Thử lại": bị vô hiệu hóa trong thời gian Backend yêu cầu chờ (Retry-After). Hết giờ chỉ MỞ nút, KHÔNG tự gửi request.
function RetryButton({ label, notBefore, onClick }) {
  const wait = useRemainingSeconds(notBefore);
  return (
    <button type="button" className="btn btn--primary" onClick={onClick} disabled={wait > 0}>
      {wait > 0 ? `${label} (chờ ${wait} giây)` : label}
    </button>
  );
}

function ErrorBlock({ error, mode, onRetry, onRestart, onReset }) {
  const real = mode === 'real';
  const title = KIND_TITLE[error.kind] ?? ERROR_TITLE[error.code] ?? 'Không hoàn tất được';
  const retryLabel = RETRY_TEXT[mode]?.[error.stage] ?? 'Thử lại';
  const orphan = error.uploadedVariants.length;
  return (
    <div className="upload-status upload-status--error" role="alert">
      <p className="upload-status__title">
        {title} <ModeBadge mode={mode} />
      </p>
      <p>{error.message}</p>
      {error.stage === 'UPLOADING' && orphan > 0 && (
        <p className="upload-status__muted">
          {real
            ? `${orphan} biến thể đã tải lên Cloudinary (${error.uploadedVariants.join(', ')}) KHÔNG bị tự xóa và chưa được xác nhận với Backend.`
            : `${orphan} biến thể đã “upload” giả lập (${error.uploadedVariants.join(', ')}). Với Cloudinary thật, đây sẽ là ảnh mồ côi cần Backend xử lý.`}
        </p>
      )}
      {error.stage === 'CONFIRMING' && !real && (
        <p className="upload-status__muted">Ảnh chưa được coi là hoàn tất (chưa DONE). Các biến thể đã “upload” được giữ lại; thử lại chỉ gửi xác nhận, dùng lại cùng imageId.</p>
      )}
      {error.stage === 'CONFIRMING' && real && error.retryable && (
        <p className="upload-status__muted">
          Ảnh chưa được coi là hoàn tất (chưa DONE). Backend có thể đã ghi nhận lần xác nhận trước; thử lại chỉ gửi xác nhận, dùng lại cùng imageId, không upload lại.
        </p>
      )}
      {real && error.code === ERROR_CODE.CANCELLED && error.kind !== 'AUTH_CHANGED' && (
        <p className="upload-status__muted">
          Hủy ở trình duyệt không bảo đảm Cloudinary hoặc Backend chưa nhận dữ liệu của yêu cầu đã gửi đi.
        </p>
      )}
      {error.retryAfterSeconds && (
        <p className="upload-status__muted">Backend yêu cầu chờ khoảng {error.retryAfterSeconds} giây trước khi thử lại.</p>
      )}
      {error.imageId && (
        <p className="upload-status__muted">
          imageId: <code>{error.imageId}</code>
        </p>
      )}
      <div className="upload-status__actions">
        {error.retryable && <RetryButton label={retryLabel} notBefore={error.retryNotBefore ?? null} onClick={onRetry} />}
        {error.restartable && (
          <button type="button" className="btn btn--primary" onClick={onRestart}>
            Bắt đầu lại (phiên upload mới)
          </button>
        )}
        <button type="button" className="btn btn--ghost" onClick={onReset}>
          Chọn ảnh khác
        </button>
      </div>
    </div>
  );
}

/** Hiển thị trạng thái của luồng upload theo state của uploadFlowReducer. Idle: không hiển thị gì. `mode`: 'mock' (mặc định) | 'real'. */
export function UploadFlowStatus({ state, mode = 'mock', onRetry, onRestart, onCancel, onReset }) {
  if (state.phase === 'running') return <ProgressBlock state={state} mode={mode} onCancel={onCancel} />;
  if (state.phase === 'done' && state.result) {
    return mode === 'real' ? <RealResultBlock result={state.result} onReset={onReset} /> : <ResultBlock result={state.result} onReset={onReset} />;
  }
  if (state.phase === 'error' && state.error) {
    return <ErrorBlock error={state.error} mode={mode} onRetry={onRetry} onRestart={onRestart} onReset={onReset} />;
  }
  return null;
}
