# Test Plan — Bản client-side, khung ngày 2, chạy chi tiết ngày 12

## 1. Mục tiêu

Chứng minh nén ở trình duyệt chạy ổn, chi phí = 0 đồng.

## 2. Metric chốt

| Metric | Cách tính | Đạt khi |
|---|---|---|
| Tỉ lệ DONE | Đếm doc Firestore sau mỗi batch | ≥ 95/100 ảnh |
| Thời gian nén | `processingMs` ở máy người dùng, trung bình + p95 | Trung bình < 10 giây/ảnh, p95 < 15 giây |
| p95 | 95% ảnh nén nhanh hơn giá trị này | Loại 5% máy yếu nhất ra |
| % tiết kiệm | `(1 - processedSize / originalSize) × 100` | Trung bình > 50% |
| Chặn file lỗi | Ảnh >10MB chặn trước khi nén, file giả → `FAILED` | 100% đúng |
| Chi phí | Chụp Firebase Usage + Billing | 0 đồng, không bật Blaze |

p95 là mức mà 95% ảnh đều nhanh hơn nó — dùng để trừ hao máy yếu.

## 3. Bộ dữ liệu test

- 100 ảnh hợp lệ (jpg/png/webp, 100KB–8MB).
- 5 ảnh >10MB (kỳ vọng chặn ngay).
- 5 file giả đổi đuôi txt→jpg (kỳ vọng `FAILED`).
- Batch 10 → 50 → 100, mỗi batch lặp 2 lần trên 2 máy khác nhau (máy mạnh + máy yếu), ghi vào sheet.

## 4. Kịch bản ngày 12

1. Batch 10, 50, 100 ảnh, ghi DONE + trung bình + p95.
2. Upload 5 ảnh quá khổ, 5 file giả.
3. Retry 1 ảnh FAILED.
4. User A đọc trộm ảnh user B → kỳ vọng bị chặn.
5. Tắt mạng giữa chừng → kỳ vọng doc ở `PENDING`, mở lại gallery tự dọn hoặc retry được.
6. Chụp Usage/Billing chứng minh 0 đồng.

## 5. Bàn giao

- Sheet số liệu 2 máy + biểu đồ trung bình/p95/% tiết kiệm.
- Báo cáo 1 trang + ảnh Usage + video demo lỗi → retry.
