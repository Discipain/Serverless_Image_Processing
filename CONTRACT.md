# API Contract — Bản client-side 0 đồng (chốt ngày 2)

Không còn Cloud Functions. Mọi thao tác gọi thẳng Firebase SDK từ web (Auth + Storage + Firestore).
`uid` lấy từ Firebase ID token, không tin client gửi lên.

## 1. Luồng thay API cũ

| Việc | Cách làm mới | Ai viết |
|---|---|---|
| Xin quyền upload | Web tạo `imageId` (UUID v4), ghi doc `PENDING` vào Firestore | Tại + Duy |
| Upload | Upload thẳng 4 file lên Storage bằng SDK, không qua server | Tại + Dũng |
| Xử lý ảnh | `processImageClient(file)` trong trình duyệt (browser-image-compression) | Dũng |
| Lấy 1 ảnh | Đọc doc `images/{imageId}` + kiểm tra `ownerId == uid` | Duy (rules) + Tại (UI) |
| Danh sách | Query `where ownerId == uid, orderBy createdAt desc, limit <= 20` | Tại |
| Tải về | `getDownloadURL(path)` của Storage SDK | Tại |
| Xóa | Xóa 4 file Storage + xóa doc Firestore | Tại |
| Thử lại | Nén lại + upload lại, đặt `retryCount + 1` | Dũng + Tại |
| Thống kê admin | Query Firestore phía client, chỉ hiện khi `customClaim admin == true` | Tới |

## 2. Doc mẫu khi DONE

```json
{
  "imageId": "b1f4c2e0-...",
  "status": "DONE",
  "original": { "size": 2457600, "width": 4000, "height": 3000 },
  "variants": {
    "thumbnail": "processed/<uid>/b1f4.../thumb.webp",
    "medium": "processed/<uid>/b1f4.../medium.webp",
    "webp": "processed/<uid>/b1f4.../full.webp"
  },
  "processedSize": 412000,
  "processingMs": 1840,
  "createdAt": "2026-10-27T09:15:00Z"
}
```

## 3. Validate phía client (bắt buộc, do Duy viết hàm chung)

- `contentType` thuộc `image/jpeg`, `image/png`, `image/webp`; `size <= 10MB`, else báo lỗi ngay, không upload.
- Mọi đọc/ghi kiểm tra `ownerId == uid`, sai thì coi như 403.

## 4. Quy ước Storage key (bắt buộc)

- Ảnh gốc: `uploads/{uid}/{imageId}/{fileNameGoc}`
- Ảnh xử lý: `processed/{uid}/{imageId}/thumb.webp`, `medium.webp`, `full.webp`
- Không còn trigger, không còn prefix event.
