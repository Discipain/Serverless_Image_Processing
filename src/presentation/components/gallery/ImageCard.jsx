import { IMAGE_STATUS } from '../../../domain/constants/imageStatus';
import {
  fileNameFromPath,
  formatBytes,
  formatDateTime,
  formatSavedPercent,
} from '../../utils/format';
import { StatusBadge } from './StatusBadge';

// Màu nền placeholder cố định theo imageId (MOCK chưa có ảnh thật để hiển thị).
// Nhân với "góc vàng" (~137.5°) để hai id gần giống nhau vẫn ra màu khác xa nhau.
function placeholderHue(imageId) {
  let hash = 0;
  for (const ch of imageId) hash = (hash * 31 + ch.charCodeAt(0)) % 100003;
  return Math.round((hash * 137.508) % 360);
}

export function ImageCard({ image }) {
  const fileName = fileNameFromPath(image.originalPath);
  const saved =
    image.status === IMAGE_STATUS.DONE
      ? formatSavedPercent(image.originalSize, image.processedSize)
      : null;

  return (
    <article className="image-card">
      <div
        className="image-card__thumb"
        role="img"
        aria-label={`Ảnh minh họa MOCK cho ${fileName}`}
        style={{ '--thumb-hue': placeholderHue(image.imageId) }}
      >
        <span className="image-card__thumb-label">MOCK</span>
      </div>

      <div className="image-card__body">
        <div className="image-card__row">
          <h3 className="image-card__name" title={fileName}>
            {fileName}
          </h3>
          <StatusBadge status={image.status} />
        </div>

        <dl className="image-card__meta">
          <div>
            <dt>Dung lượng gốc</dt>
            <dd>{formatBytes(image.originalSize)}</dd>
          </div>
          {saved && (
            <div>
              <dt>Tiết kiệm</dt>
              <dd>{saved}</dd>
            </div>
          )}
          <div>
            <dt>Tạo lúc</dt>
            <dd>{formatDateTime(image.createdAt)}</dd>
          </div>
        </dl>

        {image.status === IMAGE_STATUS.FAILED && image.errorReason && (
          <p className="image-card__error">Lý do: {image.errorReason}</p>
        )}
      </div>
    </article>
  );
}
