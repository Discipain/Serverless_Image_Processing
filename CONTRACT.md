# API Contract (chốt ngày 2 — không đổi sau ngày 2 nếu chưa qua leader)

Mọi API yêu cầu header `Authorization: Bearer <Firebase ID token>`.
`uid` lấy từ token đã xác thực, không lấy từ client gửi lên.

## 1. Bảng API

| Method | Đường dẫn | Function | Mô tả |
|---|---|---|---|
| POST | `/upload-url` | `requestUpload` | Xin signed URL để upload |
| GET | `/images/{imageId}` | `getImage` | Lấy trạng thái và thông tin một ảnh |
| GET | `/images` | `listImages` | Danh sách ảnh có phân trang (`limit`, `cursor`) |
| GET | `/images/{imageId}/download?variant=webp` | `getDownloadUrl` | Xin URL tải về |
| DELETE | `/images/{imageId}` | `deleteImage` | Xóa ảnh |
| POST | `/images/{imageId}/retry` | `retryImage` | Thử xử lý lại |
| GET | `/admin/stats` | `getStats` | Thống kê (chỉ admin, có custom claim `admin=true`) |

Quy ước: URL kebab-case, tên function camelCase. Không dùng tên cũ (`get-upload-url`, `/upload-url1`).

## 2. Request / Response mẫu

### POST /upload-url

Request:

```json
{ "fileName": "anh-bien.jpg", "contentType": "image/jpeg", "size": 2457600 }
```

Validate server: `contentType` thuộc `image/jpeg`, `image/png`, `image/webp`; `size <= 10MB`.
Response 200:

```json
{
  "imageId": "b1f4c2e0-7a31-4c8e-9f12-3d5a6e7b8c90",
  "uploadUrl": "https://storage.googleapis.com/<bucket>/uploads/<uid>/<imageId>/anh-bien.jpg?...",
  "expiresIn": 300
}
```

Đồng thời tạo doc Firestore `images/{imageId}` trạng thái `PENDING`.

### GET /images/{imageId}

Response 200 khi hoàn tất:

```json
{
  "imageId": "b1f4c2e0-...",
  "status": "DONE",
  "original": { "size": 2457600, "width": 4000, "height": 3000 },
  "variants": {
    "thumbnail": "https://<cdn>/processed/<uid>/b1f4.../thumb.webp",
    "medium": "https://<cdn>/processed/<uid>/b1f4.../medium.webp",
    "webp": "https://<cdn>/processed/<uid>/b1f4.../full.webp"
  },
  "processedSize": 412000,
  "processingMs": 1840,
  "createdAt": "2026-10-27T09:15:00Z"
}
```

### GET /images?limit=20&cursor=...

- Server ép `limit <= 20`, mặc định 20.
- Response: `{ "items": [...], "nextCursor": "..." }`, sắp xếp `createdAt` mới nhất trước, chỉ trả ảnh của `uid` đang gọi.

### GET /images/{imageId}/download?variant=webp

- `variant` thuộc `thumbnail | medium | webp | original`.
- Response: `{ "downloadUrl": "https://...?expires=15m", "expiresIn": 900 }`.

### DELETE /images/{imageId} → 204 (không body)

### POST /images/{imageId}/retry → 202 `{ "status": "PENDING" }`

### GET /admin/stats (admin)

Response:

```json
{
  "byStatus": { "PENDING": 2, "PROCESSING": 1, "DONE": 95, "FAILED": 2 },
  "avgProcessingMs": 1840,
  "savedPercent": 83.2,
  "errors24h": 2,
  "window": "24h"
}
```

Chỉ tính 24 giờ gần nhất, cache 5 phút phía server.

## 3. Mã lỗi thống nhất

| Mã | Khi nào | Ví dụ |
|---|---|---|
| 400 | Dữ liệu sai | Thiếu `fileName`, `variant` không hợp lệ |
| 401 | Chưa xác thực | Thiếu/sai Firebase ID token |
| 403 | Không có quyền | Đọc ảnh của `uid` khác, gọi `/admin/stats` khi không phải admin |
| 404 | Không tìm thấy | `imageId` không tồn tại |
| 413 | File quá lớn | `size > 10MB` |
| 429 | Gọi quá nhanh | Vượt quota gọi API |
| 500 | Lỗi hệ thống | Lỗi Sharp, lỗi Storage/Firestore không dự kiến |

## 4. Quy ước Storage key (bắt buộc)

- Ảnh gốc: `uploads/{uid}/{imageId}/{fileNameGoc}`
- Ảnh xử lý: `processed/{uid}/{imageId}/thumb.webp`, `medium.webp`, `full.webp`
- Event trigger chỉ nghe prefix `uploads/`, function chỉ ghi `processed/`.
