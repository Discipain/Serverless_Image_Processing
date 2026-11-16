# Schema Firestore — Bản client-side (chốt ngày 2)

## 1. Collection `images/{imageId}`

`{imageId}` là UUID v4 do web tạo (hàm `createImageId()` của Duy). Không dùng tên file làm ID.

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `ownerId` | string | Có | Firebase Auth `uid` của chủ ảnh |
| `status` | string | Có | `PENDING` \| `DONE` \| `FAILED` (không còn `PROCESSING` dài) |
| `originalPath` | string | Có | Ví dụ `uploads/<uid>/<imageId>/anh-bien.jpg` |
| `variants` | map | Khi DONE | `{ thumbnail, medium, webp }` — đường dẫn `processed/...` |
| `originalSize` | number | Có | Dung lượng gốc (byte) |
| `processedSize` | number | Khi DONE | Tổng 3 file sau nén (byte) |
| `originalWidth` | number | Khi DONE | Đọc bằng `Image` object ở browser |
| `originalHeight` | number | Khi DONE | Đọc bằng `Image` object ở browser |
| `errorReason` | string | Khi FAILED | `INVALID_IMAGE`, `TOO_LARGE`, `COMPRESS_FAIL` |
| `retryCount` | number | Có | Mặc định 0, retry +1 |
| `processingMs` | number | Khi DONE | Thời gian nén ở máy người dùng (ms) |
| `createdAt` | Timestamp | Có | `serverTimestamp()` |
| `updatedAt` | Timestamp | Có | `serverTimestamp()` |

## 2. Vòng đời `status`

`(chưa có)` → web ghi `PENDING` → nén + upload xong → `DONE` / lỗi → `FAILED` → bấm thử lại → `PENDING`. Không còn `PROCESSING` server. Doc `PENDING` quá 24h không upload xong thì client dọn khi mở gallery.

## 3. Index

1. `ownerId` + `createdAt` desc — gallery.
2. `status` + `createdAt` desc — admin lọc `FAILED`.

Query gallery bắt buộc `where ownerId == uid`, `limit <= 20`.

## 4. Rules (Duy + Hưng viết)

- Chỉ chủ sở hữu đọc/ghi doc và file của mình.
- Trang admin kiểm tra `request.auth.token.admin == true`.
