import { useState } from 'react';
import { IMAGE_STATUS } from '../../../domain/constants/imageStatus';
import { formatBytes, formatDateTime } from '../../utils/format';
import { StatusBadge } from './StatusBadge';
import { shouldShowPreview, toCardModel } from './galleryCardModel';

// Màu nền placeholder cố định theo imageId (MOCK chưa có ảnh thật để hiển thị).
// Nhân với "góc vàng" (~137.5°) để hai id gần giống nhau vẫn ra màu khác xa nhau.
function placeholderHue(imageId) {
  let hash = 0;
  for (const ch of imageId) hash = (hash * 31 + ch.charCodeAt(0)) % 100003;
  return Math.round((hash * 137.508) % 360);
}

const PROVIDER_NOTE = { google_drive: 'Ảnh từ Google Drive (chưa có bản xem trước)' };

// Ảnh dữ liệu THẬT: <img> chỉ nhận URL https đã được xác thực; lỗi tải => placeholder. Không có nhãn MOCK.
function RealThumb({ model }) {
  const [failedUrl, setFailedUrl] = useState(null);
  if (shouldShowPreview(model.previewUrl, failedUrl)) {
    return (
      <img
        className="image-card__img"
        src={model.previewUrl}
        alt={model.name}
        loading="lazy"
        decoding="async"
        referrerPolicy="no-referrer"
        onError={() => setFailedUrl(model.previewUrl)}
      />
    );
  }
  const note = PROVIDER_NOTE[model.provider] ?? (failedUrl ? 'Không tải được ảnh xem trước' : 'Chưa có ảnh xem trước');
  return (
    <div className="image-card__thumb image-card__thumb--placeholder" role="img" aria-label={`${note}: ${model.name}`}>
      <span className="image-card__placeholder-icon" aria-hidden="true">🖼️</span>
      <span className="image-card__placeholder-text">{note}</span>
    </div>
  );
}

function MockThumb({ model }) {
  return (
    <div
      className="image-card__thumb"
      role="img"
      aria-label={`Ảnh minh họa MOCK cho ${model.name}`}
      style={{ '--thumb-hue': placeholderHue(model.imageId) }}
    >
      <span className="image-card__thumb-label">MOCK</span>
    </div>
  );
}

/** `image`: model MOCK cũ (có originalPath) hoặc GalleryImage từ Backend. */
export function ImageCard({ image }) {
  const model = toCardModel(image);

  return (
    <article className="image-card">
      {model.isMock ? <MockThumb model={model} /> : <RealThumb model={model} />}

      <div className="image-card__body">
        <div className="image-card__row">
          <h3 className="image-card__name" title={model.name}>
            {model.name}
          </h3>
          <StatusBadge status={model.status} />
        </div>

        <dl className="image-card__meta">
          {model.showOriginalSize && (
            <div>
              <dt>Dung lượng gốc</dt>
              <dd>{formatBytes(model.originalSize)}</dd>
            </div>
          )}
          {model.savedText && (
            <div>
              <dt>Tiết kiệm</dt>
              <dd>{model.savedText}</dd>
            </div>
          )}
          {model.showCreatedAt && (
            <div>
              <dt>Tạo lúc</dt>
              <dd>
                {formatDateTime(model.createdAt)}
                {model.createdAtEstimated ? ' (ước lượng)' : ''}
              </dd>
            </div>
          )}
        </dl>

        {model.status === IMAGE_STATUS.FAILED && model.errorReason && (
          <p className="image-card__error">Lý do: {model.errorReason}</p>
        )}
      </div>
    </article>
  );
}
