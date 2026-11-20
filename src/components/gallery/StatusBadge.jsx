import { IMAGE_STATUS } from '../../constants/image';

const STATUS_META = {
  [IMAGE_STATUS.PENDING]: { label: 'Đang chờ', modifier: 'pending' },
  [IMAGE_STATUS.DONE]: { label: 'Hoàn tất', modifier: 'done' },
  [IMAGE_STATUS.FAILED]: { label: 'Lỗi', modifier: 'failed' },
};

export function StatusBadge({ status }) {
  // Trạng thái lạ (không có trong SCHEMA) vẫn hiển thị nguyên văn thay vì bị ẩn.
  const meta = STATUS_META[status] ?? { label: status || 'Không rõ', modifier: 'unknown' };
  return <span className={`status-badge status-badge--${meta.modifier}`}>{meta.label}</span>;
}
