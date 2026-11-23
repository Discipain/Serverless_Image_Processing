import { calcSavedPercent } from '../../domain/models/image';

const numberFormat = new Intl.NumberFormat('vi-VN', { maximumFractionDigits: 1 });
const dateTimeFormat = new Intl.DateTimeFormat('vi-VN', {
  dateStyle: 'short',
  timeStyle: 'short',
});

/** 2457600 -> "2,3 MB" */
export function formatBytes(bytes) {
  if (typeof bytes !== 'number' || Number.isNaN(bytes)) return '—';
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${numberFormat.format(bytes / 1024)} KB`;
  return `${numberFormat.format(bytes / (1024 * 1024))} MB`;
}

/** Nhận Date (MOCK) hoặc Firestore Timestamp (có .toDate()) sau này. */
export function formatDateTime(value) {
  if (!value) return '—';
  const date = typeof value.toDate === 'function' ? value.toDate() : value;
  return date instanceof Date && !Number.isNaN(date.getTime())
    ? dateTimeFormat.format(date)
    : '—';
}

/** Chuỗi hiển thị % tiết kiệm; phép tính nằm ở domain (calcSavedPercent). Thiếu dữ liệu -> null. */
export function formatSavedPercent(originalSize, processedSize) {
  const percent = calcSavedPercent(originalSize, processedSize);
  return percent === null ? null : `${numberFormat.format(percent)}%`;
}

/** Hiển thị một con số phần trăm CÓ SẴN (vd savedPercent do Backend tính). Không phải số hữu hạn -> null; không tự suy diễn. */
export function formatPercent(value) {
  return typeof value === 'number' && Number.isFinite(value) ? `${numberFormat.format(value)}%` : null;
}

// fileNameFromPath là quy tắc về đường dẫn Storage nên nằm ở domain; re-export để
// các component hiện có (ImageCard) không phải đổi import.
export { fileNameFromPath } from '../../domain/models/image';
