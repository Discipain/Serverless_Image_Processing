# Test Plan — khung ngày 2, chạy chi tiết ngày 12

## 1. Mục tiêu

Chứng minh hệ thống chạy đúng luồng, chịu lỗi tốt, chi phí trong free tier.

## 2. Metric chốt (định nghĩa ngay từ ngày 2)

| Metric | Định nghĩa | Cách tính | Đạt khi |
|---|---|---|---|
| Tỉ lệ DONE | Số ảnh `DONE` / tổng ảnh hợp lệ | Đếm doc Firestore sau mỗi batch test | ≥ 95/100 ảnh |
| Thời gian xử lý | `processingMs` = lúc `DONE` trừ lúc `PROCESSING` | Đọc field `processingMs`, tính trung bình + p95 | Trung bình < 10 giây/ảnh |
| p95 | 95% ảnh xử lý nhanh hơn giá trị này | Sắp xếp `processingMs` tăng dần, lấy vị trí 95% | p95 < 15 giây |
| % tiết kiệm dung lượng | `(1 - processedSize / originalSize) × 100` | Đọc 2 field trên doc `DONE` | Trung bình > 50% (nhờ WebP) |
| Từ chối file lỗi | Ảnh > 10MB bị 413, file giả bị `FAILED` đúng | Kiểm tra mã lỗi + `errorReason` | 100% file lỗi bị chặn đúng |
| Chi phí | Đọc Firebase Usage + Billing | Chụp màn hình console ngày 12 | Nằm trong free tier, ~0 đồng |

Giải thích nhanh cho người mới:
- **Trung bình** là thời gian xử lý cộng lại chia đều.
- **p95** là mức mà 95% ảnh đều nhanh hơn nó — dùng p95 thay vì giá trị cao nhất để tránh 1-2 ảnh lỗi làm lệch số liệu.
- **% tiết kiệm** cho thấy nén WebP có hiệu quả hay không.

## 3. Bộ dữ liệu test (chuẩn bị trước ngày 12)

- 100 ảnh hợp lệ: trộn jpg/png/webp, kích thước 100KB–8MB.
- 5 ảnh quá khổ > 10MB (kỳ vọng bị 413 ngay).
- 5 file giả: đổi đuôi `.txt` thành `.jpg` (kỳ vọng `FAILED` với `errorReason` rõ ràng).
- Chia batch: 10 → 50 → 100 ảnh, mỗi batch lặp 3 lần, ghi số liệu vào sheet.

## 4. Kịch bản ngày 12

1. Upload batch 10 ảnh, ghi tỉ lệ DONE + trung bình + p95.
2. Upload batch 50, rồi 100 ảnh cùng lúc — kiểm tra hệ thống có nghẽn không.
3. Upload 5 ảnh quá khổ, 5 file giả — kiểm tra bị từ chối đúng.
4. Thử retry 1 ảnh FAILED — kiểm tra về `PENDING` rồi `DONE`.
5. Thử đọc trộm: user A gọi `getImage` của user B — kỳ vọng 403.
6. Chụp màn hình Firebase Usage/Billing + Cloud Logging.

## 5. Kết quả bàn giao

- Sheet số liệu 3 batch + biểu đồ trung bình/p95/% tiết kiệm.
- Báo cáo 1 trang: đạt/không đạt từng metric, chi phí thực tế.
- Ảnh chụp console + video demo luồng lỗi → retry.
