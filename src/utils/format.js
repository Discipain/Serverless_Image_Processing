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

/** % tiết kiệm theo TEST-PLAN.md: (1 - processedSize / originalSize) x 100 */
export function formatSavedPercent(originalSize, processedSize) {
  if (!originalSize || typeof processedSize !== 'number') return null;
  return `${numberFormat.format((1 - processedSize / originalSize) * 100)}%`;
}

/** "uploads/<uid>/<imageId>/anh-bien.jpg" -> "anh-bien.jpg" */
export function fileNameFromPath(path) {
  if (!path) return '';
  return path.split('/').pop();
}
