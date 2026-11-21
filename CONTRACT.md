# API Contract — Bản Hybrid Edge-Cloud FULL (thay thế mọi bản trước)

> Nghị quyết: Client nén + upload thẳng Cloudinary, Backend FastAPI chỉ verify + ghi Firestore.
> Lý do đổi: Cloud Storage bắt Blaze cần thẻ nên bỏ; preset Cloudinary lộ nếu client tự ghi nên Backend giữ luật.
> Mọi đổi tên API/field sau đây phải mở PR và được leader duyệt.
> Quy ước: URL kebab-case, tên function camelCase, trạng thái duy nhất `PENDING → PROCESSING → DONE/FAILED`. Cấm chữ `COMPLETED`.

## 0. Xác thực — bắt buộc mọi API

### 0.1. Cách gọi

Mọi request gửi 1 trong 2 header (ưu tiên Bearer):

```text
Authorization: Bearer <Firebase ID token>
```

Bản cũ dùng `X-User-Id` tự khai — ĐÃ BỎ, cấm dùng. Backend verify token thật bằng `firebase-admin`, lấy `uid` từ `token.uid`. Không lấy uid từ body/query.

### 0.2. Phân quyền

- Mọi API ảnh: kiểm tra `ownerId == uid`, sai → `403`.
- API `/admin/*`: thêm custom claim `admin=true`, sai → `403`.
- Test đọc trộm: User A gọi ảnh của User B phải nhận `403 { "detail": "Forbidden" }`.

---

## 1. Luồng 5 bước hybrid (đọc trước khi gọi)

1. **checkFile (trình duyệt):** chặn `jpg/png/webp`, `≤ 10MB`. Sai báo ngay, không gọi API.
2. **Nén (trình duyệt, Dũng):** `processImageClient(file)` → 3 blob `thumb 200`, `medium 800`, `full webp` + `processingMs` + `savedPercent`.
3. **Upload thẳng Cloudinary (trình duyệt, KHÔNG qua Backend):** `fetch https://api.cloudinary.com/v1_1/<cloud>/image/upload` + `upload_preset=serverless_image_preset`, 3 lần (hoặc 1 lần gốc + build URL biến thể). Nhận 3 `secure_url`.
4. **Confirm (1 API Backend duy nhất):** `POST /images/cloudinary/confirm` để ghi Firestore `DONE`.
5. **Hiển thị:** Gallery `GET /images` + chi tiết `GET /images/{id}`, nghe `onSnapshot`/polling 2s. Thấy `DONE` thì hiện 3 variant.

---

## 2. Bảng API chốt

| # | Method | Đường dẫn | Function Backend | Mô tả | Luồng |
|---|---|---|---|---|---|
| 1 | POST | `/images/cloudinary/confirm` | `confirmCloudinary` | Xác nhận upload xong, verify + ghi DONE | Hybrid chính |
| 2 | GET | `/images/{imageId}` | `getImage` | Chi tiết 1 ảnh UC03 | Hybrid chính |
| 3 | GET | `/images` | `listImages` | Danh sách UC04, `limit`/`cursor` | Hybrid chính |
| 4 | DELETE | `/images/{imageId}` | `deleteImage` | Xóa Cloudinary + Firestore | Hybrid chính |
| 5 | POST | `/images/{imageId}/retry` | `retryImage` | Đặt lại PENDING, client nén + upload lại | Hybrid chính |
| 6 | GET | `/admin/stats` | `getStats` | Thống kê 24h, admin, cache 5 phút | Hybrid chính |
| 7 | POST | `/images/upload-url` | `requestUpload` | Test `checkFile` | Tương thích cũ, không dùng luồng chính |
| 8 | POST | `/images/upload-drive` | `uploadDrive` | Upload Drive (luồng phụ) | Demo nội bộ |
| 9 | POST | `/images/cloudinary/upload` | `uploadCloudinary` | Upload qua Backend (luồng thuần cũ) | Demo nội bộ |
| 10 | POST | `/images/{imageId}/process` | `triggerProcessing` | Drive upload→processing | Demo nội bộ |
| 11 | POST | `/images/{imageId}/complete` | `triggerComplete` | Drive processing→processed | Demo nội bộ |
| 12 | POST | `/images/drive/folders` | `createDriveFolder` | Tạo pipeline Drive | Demo nội bộ |
| 13 | GET | `/images/cloudinary` | `listCloudinary` | Lọc chỉ ảnh Cloudinary | Demo nội bộ |
| 14 | GET | `/images/cloudinary/{imageId}` | `getCloudinaryImage` | Chi tiết ảnh Cloudinary | Demo nội bộ |
| 15 | POST | `/images/cloudinary/{imageId}/process` | `processCloudinaryImage` | Xử lý Cloudinary cũ (Pillow) | Demo nội bộ, bản hybrid không dùng |

---

## 3. API 1 — POST /images/cloudinary/confirm (QUAN TRỌNG NHẤT)

Frontend gọi SAU KHI upload 3 variant lên Cloudinary xong.

### 3.1. Request

```http
POST /images/cloudinary/confirm
Authorization: Bearer <idToken>
Content-Type: application/json
```

```json
{
  "imageId": "b1f4c2e0-7a31-4c8e-9f12-3d5a6e7b8c90",
  "fileName": "anh-bien.jpg",
  "contentType": "image/jpeg",
  "thumbnail": "https://res.cloudinary.com/zftcbu1g/image/upload/w_200,f_webp/v1/abc/thumb.webp",
  "medium": "https://res.cloudinary.com/zftcbu1g/image/upload/w_800,f_webp/v1/abc/medium.webp",
  "webp": "https://res.cloudinary.com/zftcbu1g/image/upload/f_webp/v1/abc/full.webp",
  "originalSize": 2457600,
  "processedSize": 412000,
  "processingMs": 1840,
  "width": 4000,
  "height": 3000
}
```

Validate Backend (bắt buộc):
- Bắt buộc 6 field: imageId, thumbnail, medium, webp, originalSize, processingMs. Thiếu 1 trong 6 → 400. Tùy chọn 6 field: fileName, width, height, thumbnailId, mediumId, webpId — thiếu thì Backend tự điền mặc định, không báo lỗi.
- 3 URL phải chứa `cloudName` của nhóm (`zftcbu1g`), URL lạ → `400`.
- `originalSize <= 10MB`, sai định dạng → `400`.
- `imageId` đã `DONE` rồi → trả luôn `200` cũ (idempotent), không ghi đè. imageId do Frontend tạo bằng crypto.randomUUID(), tạo 1 lần trước khi nén. Backend coi là khóa chống trùng: nhận trùng thì trả bản cũ.

### 3.2. Response 200

```json
{
  "imageId": "b1f4c2e0-7a31-4c8e-9f12-3d5a6e7b8c90",
  "status": "DONE",
  "ownerId": "abc-uid-1",
  "variants": {
    "thumbnail": "https://res.cloudinary.com/.../thumb.webp",
    "thumbnailId": "abc/thumb",
    "medium": "https://res.cloudinary.com/.../medium.webp",
    "mediumId": "abc/medium",
    "webp": "https://res.cloudinary.com/.../full.webp",
    "webpId": "abc/full",
  },
  "processingMs": 1840,
  "savedPercent": 83.2
}
```
3 field *Id là tùy chọn nhưng khuyên gửi, lấy từ public_id Cloudinary trả về. Dùng để Backend xác minh đúng cloud và xóa ảnh khi DELETE. Thiếu vẫn chạy, nhưng xóa phải tự tách từ URL.
Đồng thời ghi Firestore `images/{imageId}`: `status=DONE`, `ownerId`, `original{size,width,height}`, `variants`, `processedSize`, `processingMs`, `savedPercent`, `errorReason=null`, `updatedAt=serverTimestamp`.

### 3.3. Lỗi

- `401 { "detail": "Missing token" }` — thiếu/sai token.
- `400 { "detail": "Invalid cloudinary url" }` — URL không đúng cloud nhóm.
- `400 { "detail": "File too large" }` — quá 10MB.
- `404` — confirm cho imageId chưa từng tạo PENDING (tùy cài đặt, có thể tự tạo PENDING rồi DONE).

---

## 4. API 2 — GET /images/{imageId} (UC03)

```http
GET /images/b1f4c2e0-... 
Authorization: Bearer <idToken>
```

Response 200 khi DONE:

```json
{
  "imageId": "b1f4c2e0-...",
  "status": "DONE",
  "ownerId": "abc-uid-1",
  "fileName": "anh-bien.jpg",
  "provider": "cloudinary",
  "original": { "size": 2457600, "width": 4000, "height": 3000 },
  "variants": {
    "thumbnail": "https://res.cloudinary.com/.../thumb.webp",
    "medium": "https://res.cloudinary.com/.../medium.webp",
    "webp": "https://res.cloudinary.com/.../full.webp"
  },
  "previewUrl": "https://res.cloudinary.com/.../thumb.webp",
  "processedSize": 412000,
  "processingMs": 1840,
  "savedPercent": 83.2,
  "retryCount": 0,
  "errorReason": null,
  "createdAt": "2026-10-27T09:15:00Z",
  "updatedAt": "2026-10-27T09:15:12Z"
}
```

Khi PENDING/PROCESSING: `variants` có thể `null`, Frontend hiện "Chờ xử lý...".
Khi FAILED: `"status": "FAILED", "errorReason": "INVALID_IMAGE | TIMEOUT | ..."`.

Lỗi: `401` thiếu token, `403` đọc ảnh người khác (`{ "detail": "Forbidden" }`), `404` không thấy id.

---

## 5. API 3 — GET /images (UC04 Gallery)

```http
GET /images?limit=20&cursor=ey...
Authorization: Bearer <idToken>
```

- Query: `limit` mặc định 20, server ép `<= 20`. `cursor` là `nextCursor` trang trước, trang đầu bỏ trống.
- Chỉ trả ảnh của `uid` đang gọi, sắp xếp `createdAt` mới nhất trước.

Response 200:

```json
{
  "items": [
    {
      "imageId": "aaa...",
      "originalName": "anh-1.jpg",
      "status": "DONE",
      "previewUrl": "https://res.cloudinary.com/.../thumb.webp",
      "variants": { "thumbnail": "...", "medium": "...", "webp": "..." },
      "createdAt": "2026-10-27T09:20:00Z"
    }
  ],
  "nextCursor": "ey...",
  "hasMore": true
}
```

`nextCursor=null` nghĩa là hết trang. Frontend (Tại) cuộn xuống thì gọi tiếp với cursor này.

---

## 6. API 4 — DELETE /images/{imageId}

```http
DELETE /images/b1f4c2e0-...
Authorization: Bearer <idToken>
```

Backend: kiểm tra `ownerId == uid` → xóa 3 file Cloudinary (destroy) + xóa doc Firestore → trả `204` không body.

Lỗi: `401`, `403` (xóa ảnh người khác), `404`.

---

## 7. API 5 — POST /images/{imageId}/retry

```http
POST /images/b1f4c2e0-.../retry
Authorization: Bearer <idToken>
```

Response 202:

```json
{ "imageId": "b1f4c2e0-...", "status": "PENDING", "retryCount": 1 }
```

Luồng hybrid: server chỉ đặt lại `PENDING`, KHÔNG nén lại. Client (Dũng + Tại) tự nén + upload Cloudinary lại rồi gọi confirm. Khác bản Backend thuần cũ (server Pillow nén).

Lỗi: `401`, `403`, `404`. Ảnh đã `DONE` mà retry → `400 { "detail": "Already done" }` (tùy chọn).

---

## 8. API 6 — GET /admin/stats (chỉ admin)

```http
GET /admin/stats?window=24h
Authorization: Bearer <adminIdToken>
```

Response 200:

```json
{
  "byStatus": { "PENDING": 2, "PROCESSING": 1, "DONE": 95, "FAILED": 2 },
  "total": 100,
  "avgProcessingMs": 1840,
  "p95ProcessingMs": 3200,
  "savedPercent": 83.2,
  "errors24h": 2,
  "window": "24h"
}
```

- Chỉ tính 24h gần nhất qua index `status + createdAt`.
- Cache 5 phút phía server (biến ngoài handler).
- Không phải admin → `403`.

---

## 9. API 7–15 — Luồng cũ giữ để demo (không phải hybrid chính)

### 9.1. POST /images/upload-url (test checkFile)

Request:

```json
{ "filename": "sample.webp", "contentType": "image/webp", "sizeBytes": 102400 }
```

- Hợp lệ → `200 { "imageId": "...", "image": {...} }` (tùy backend, có thể chỉ trả imageId).
- Sai định dạng (`.exe`) → `400 { "detail": "Invalid file type" }`.
- Quá 10MB (15MB) → `400 { "detail": "File too large" }`.
- Test bench của team có 3 nút test sẵn 3 trường hợp này.

### 9.2. POST /images/upload-drive + /process + /complete

- `POST /images/upload-drive` (multipart `file`, `autoProcess=true/false`, `folderId?`) → `200 { "imageId": "...", "image": {...} }`. Sai file → `400`.
- `POST /images/{id}/process` → chuyển upload→processing. `POST /images/{id}/complete` → processing→processed (ghi 3 variant Pillow). Dùng demo Drive nội bộ.
- `POST /images/drive/folders { "folderName": "App_Image_Pipeline" }` → `200 { "folderId": "...", "webViewLink": "..." }`.

### 9.3. POST /images/cloudinary/upload (bản thuần cũ)

Upload qua Backend (server nhận file rồi đẩy Cloudinary). Bản hybrid KHÔNG dùng (client upload thẳng). Giữ để so sánh tốc độ nếu thầy hỏi.

### 9.4. GET /images/cloudinary, GET /images/cloudinary/{id}, POST /images/cloudinary/{id}/process

Lọc và chi tiết chỉ ảnh Cloudinary, cú pháp response giống API 2–3 nhưng thêm `"provider": "cloudinary"`.

---

## 10. Mã lỗi thống nhất (copy cho Frontend check)

| Mã | Khi nào | Body mẫu | Ai dễ gặp |
|---|---|---|---|
| 200 | OK | `{ "imageId": "...", "status": "DONE" }` | — |
| 202 | Nhận retry | `{ "status": "PENDING" }` | Tại |
| 204 | Xóa xong | (không body) | Tại |
| 400 | Dữ liệu sai | `{ "detail": "Invalid file type" }` / `"File too large"` / `"Invalid cloudinary url"` | Dũng, Tại |
| 401 | Chưa xác thực | `{ "detail": "Missing token" }` | Tại (quên gắn token) |
| 403 | Không quyền | `{ "detail": "Forbidden" }` | Test User B đọc trộm |
| 404 | Không tìm thấy | `{ "detail": "Image not found" }` | Gõ sai imageId |
| 413 | File quá lớn (tùy backend) | `{ "detail": "File too large" }` | Dũng |
| 429 | Gọi quá nhanh | `{ "detail": "Too many requests" }` | Test tải 100 ảnh |
| 500 | Lỗi hệ thống | `{ "detail": "Internal error" }` | Duy fix |

Frontend (Tại) check: `if (!res.ok) show(data.detail)`. Thấy `COMPLETED` ở đâu → báo Duy sửa thành `DONE` (sai contract).

---

## 11. Quy ước lưu trữ hybrid (thay Storage key cũ)

- **Cloudinary (luồng chính):** client upload bằng preset `serverless_image_preset` (giới hạn jpg/png/webp, ≤10MB, cloud `zftcbu1g`). Lưu đúng 3 URL vào `variants.thumbnail / variants.medium / variants.webp`. Không dùng `uploads/{uid}/` Storage nữa vì bỏ Storage (Blaze bắt thẻ).
- **Google Drive (luồng phụ):** `App_Image_Pipeline/upload | processing | processed`. Chỉ demo nội bộ.
- **Firestore `images/{imageId}` (sổ chung duy nhất):** field chốt `ownerId, status, fileName, provider, original{size,width,height}, variants{thumbnail,medium,webp}, previewUrl, processedSize, processingMs, savedPercent, retryCount, errorReason, createdAt, updatedAt`. Client KHÔNG ghi trực tiếp (rules chặn), chỉ Backend service account ghi. Xem chi tiết field trong `SCHEMA.md`.

---

## 12. Checklist nối cho Tại (Frontend) — copy thứ tự gọi

1. `loginWithGoogle` → lưu `uid` + `idToken`.
2. Chọn file → `checkFile` (Duy) → `processImageClient` (Dũng) → upload 3 blob Cloudinary → `POST /images/cloudinary/confirm`.
3. Polling `GET /images/{id}` 1.5–2s hoặc `onSnapshot` → `DONE` thì hiện.
4. Gallery `GET /images?limit=20` → bấm ảnh → `GET /images/{id}` → hiện 4 ô (gốc + 3 variant).
5. Nút xóa → `DELETE`, nút thử lại → `POST .../retry` rồi lặp bước 2.

---

## 13. Lịch sử đổi

1. Bản AWS gốc: `POST /upload-url` xin presigned S3, Lambda Sharp, SQS.
2. Bản client-side: bỏ Functions, SDK trực tiếp Storage.
3. Bản Backend thuần: FastAPI + Pillow + Drive + Cloudinary qua server, header `X-User-Id`.
4. Bản hybrid này: client nén + upload thẳng Cloudinary, Backend chỉ confirm + giữ luật, Bearer token, thống nhất DONE/FAILED, bỏ Storage vì Blaze.
