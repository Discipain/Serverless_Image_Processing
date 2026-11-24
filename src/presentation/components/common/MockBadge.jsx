// Nhãn hiển thị để không ai nhầm dữ liệu giả lập với kết quả tích hợp thật.
export function MockBadge({ label = 'MOCK' }) {
  return (
    <span className="mock-badge" title="Dữ liệu giả lập — chưa kết nối Firebase">
      {label}
    </span>
  );
}
