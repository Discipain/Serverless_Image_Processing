// Nhãn cho dữ liệu THẬT từ Backend (đối lập với MockBadge). Chỉ hiển thị khi Gallery đang ở chế độ REAL.
export function RealBadge({ label = 'DỮ LIỆU THẬT' }) {
  return (
    <span className="real-badge" title="Dữ liệu đọc từ Backend (localhost, môi trường development)">
      {label}
    </span>
  );
}
