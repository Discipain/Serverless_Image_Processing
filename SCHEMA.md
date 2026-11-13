# Schema Firestore (chốt ngày 2)

## 1. Collection `images/{imageId}`

`{imageId}` là UUID v4 do `requestUpload` tạo. Không dùng tên file làm ID.

| Trường | Kiểu | Bắt buộc | Mô tả |
|---|---|---|---|
| `ownerId` | string | Có | Firebase Auth `uid` của chủ ảnh, dùng để kiểm tra quyền |
| `status` | string | Có | `PENDING` \| `PROCESSING` \| `DONE` \| `FAILED` |
| `originalPath` | string | Có | Đường dẫn ảnh gốc, ví dụ `uploads/<uid>/<imageId>/anh-bien.jpg` |
| `variants` | map | Khi DONE | `{ thumbnail: string, medium: string, webp: string }` — đường dẫn `processed/...` |
| `originalSize` | number | Có | Dung lượng gốc (byte) |
| `processedSize` | number | Khi DONE | Tổng dung lượng sau xử lý (byte, cộng 3 variant hoặc bản webp chính) |
| `originalWidth` | number | Khi DONE | Chiều rộng ảnh gốc (đọc bằng Sharp) |
| `originalHeight` | number | Khi DONE | Chiều cao ảnh gốc |
| `errorReason` | string | Khi FAILED | Lý do lỗi, ví dụ `INVALID_IMAGE`, `TIMEOUT`, `TOO_LARGE` |
| `retryCount` | number | Có | Số lần đã thử lại, mặc định 0 |
| `processingMs` | number | Khi DONE | Thời gian xử lý (ms) |
| `createdAt` | Timestamp | Có | `serverTimestamp()` lúc tạo |
| `updatedAt` | Timestamp | Có | `serverTimestamp()` mỗi lần đổi trạng thái |

Ví dụ doc:

```json
{
  "ownerId": "abc-uid-1",
  "status": "DONE",
  "originalPath": "uploads/abc-uid-1/b1f4c2e0/anh-bien.jpg",
  "variants": {
    "thumbnail": "processed/abc-uid-1/b1f4c2e0/thumb.webp",
    "medium": "processed/abc-uid-1/b1f4c2e0/medium.webp",
    "webp": "processed/abc-uid-1/b1f4c2e0/full.webp"
  },
  "originalSize": 2457600,
  "processedSize": 412000,
  "originalWidth": 4000,
  "originalHeight": 3000,
  "retryCount": 0,
  "processingMs": 1840
}
```

## 2. Vòng đời `status`

`(chưa có)` → `requestUpload` → `PENDING` → `onImageUploaded` bắt đầu → `PROCESSING` → thành công → `DONE` / lỗi → `FAILED` → `retryImage` → `PENDING`. `PENDING` quá 24 giờ không upload xong → `cleanupExpired` xóa.

## 3. Index cần tạo (`firestore.indexes.json`)

1. `ownerId` (tăng dần) + `createdAt` (giảm dần) — phục vụ `listImages`.
2. `status` (tăng dần) + `createdAt` (giảm dần) — phục vụ admin lọc `FAILED` và `getStats` 24 giờ.

`listImages` bắt buộc `where ownerId == uid`, `orderBy createdAt desc`, `limit <= 20`.

## 4. Rules tóm tắt (chi tiết do Member B viết)

- Chỉ chủ sở hữu (`request.auth.uid == resource.data.ownerId`) được đọc/ghi doc của mình.
- `getStats` kiểm tra custom claim `admin == true` phía function, không dựa vào rules client.
