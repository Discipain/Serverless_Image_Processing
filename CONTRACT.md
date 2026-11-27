# API Contract — Bản Hybrid Edge-Cloud, upload CÓ CHỮ KÝ (thay thế mọi bản trước)

> Nghị quyết 27/11: chốt **1 backend duy nhất = nhánh `feat/backend-hybrid-confirm`** (Tại, viết tiếp từ code Duy).
> Client nén 3 variant → xin chữ ký từ Backend → upload thẳng Cloudinary bằng chữ ký → Backend xác minh asset thật rồi ghi Firestore.
> Lý do: Cloud Storage bắt Blaze cần thẻ nên bỏ. Unsigned preset ai cũng upload được nên **đã retire**, thay bằng signed upload.
> Mọi đổi tên API/field phải mở PR và được leader duyệt **trước** khi code.
> Quy ước: URL kebab-case, tên function camelCase. Cấm chữ `COMPLETED`, chỉ dùng `DONE`/`FAILED`.

## 0. Xác thực — bắt buộc mọi API

### 0.1. Cách gọi

```text
Authorization: Bearer <Firebase ID token>
```

- Backend verify token bằng `firebase-admin`, `uid` **chỉ** lấy từ token. Không đọc uid từ body/query.
- Header `X-User-Id` và các route `/auth/firebase/login|register|refresh`: **ĐÃ RETIRE**, cấm dùng.
- Thiếu/sai token → `401 { "detail": "Missing token" }`. Xác thực luôn chạy trước kiểm tra body.

### 0.2. Phân quyền

- Mọi API ảnh: `ownerId == uid`, sai → `403 { "detail": "Forbidden" }` (không lộ chủ thật).
- API `/admin/*`: cần custom claim `admin=true`, sai → `403`.

---

## 1. Luồng upload 5 bước (đọc trước khi gọi)

1. **checkFile (trình duyệt):** chỉ `jpg/png/webp`, `≤ 10MB`. Sai thì báo ngay, không gọi API.
2. **Nén (trình duyệt, Dũng):** tạo `imageId = crypto.randomUUID()` (UUID v4) **1 lần trước khi nén**, ra 3 blob: `thumbnail` (cạnh dài ≤ 200), `medium` (≤ 800), `webp` (full) + `processingMs`.
3. **Xin chữ ký:** `POST /images/cloudinary/authorize` (mục 3). Backend tự quyết `public_id` cho cả 3 variant.
4. **Upload thẳng Cloudinary:** 3 request `multipart/form-data` tới `uploadUrl`, mỗi request = `file` (WebP) + **đúng nguyên** các cặp trong `fields` Backend trả (đã có sẵn `api_key`, `signature`). Nhận 3 `secure_url`.
5. **Confirm:** `POST /images/cloudinary/confirm` (mục 4). Backend gọi Cloudinary Admin API kiểm 3 asset có thật, đúng `public_id`, rồi ghi `images/{imageId}` = `DONE`.

Sau đó: Gallery `GET /images`, chi tiết `GET /images/{imageId}`, xóa `DELETE /images/{imageId}`.

**Thử lại khi lỗi:** làm ở client. Lỗi trước bước 5 thì gọi lại authorize **cùng imageId + cùng metadata** (trả lại grant cũ, không tốn lượt). Grant hết hạn hoặc đổi file thì tạo `imageId` mới, làm lại từ bước 2.

---

## 2. Bảng API chốt

| # | Method | Đường dẫn | Mô tả | Code (nhánh `feat/backend-hybrid-confirm`) |
|---|---|---|---|---|
| 1 | POST | `/images/cloudinary/authorize` | Cấp chữ ký upload 3 variant | ✅ Có |
| 2 | POST | `/images/cloudinary/confirm` | Xác minh asset + ghi `DONE` | ✅ Có |
| 3 | GET | `/images` | Gallery, `limit`/`cursor` | ✅ Có |
| 4 | GET | `/images/{imageId}` | Chi tiết 1 ảnh | ✅ Có |
| 5 | DELETE | `/images/{imageId}` | Xóa 3 asset Cloudinary + doc | ❌ Chưa code (Duy) |
| 6 | GET | `/admin/stats` | Thống kê 24h | ❌ Chưa code (Leader) |

Luồng phụ Google Drive (demo nội bộ, không thuộc luồng chính): `POST /images/sync`, `POST /images/drive/folders`, `GET /images/preview/{driveFileId}`, `/oauth/google/*`.

Đã retire (không dùng nữa):

| Cái cũ | Thay bằng |
|---|---|
| Unsigned preset `serverless_image_preset` | Signed upload (API 1) |
| `POST /images/upload-url` | Trả `410` ở chế độ signed. Kiểm file làm ở client (checkFile) |
| `POST /images/{imageId}/retry` | Retry ở client (mục 1) |
| `/images/upload-drive`, `/process`, `/complete`, `/cloudinary/upload`, `/cloudinary/{id}/process` (Pillow) | Bỏ, nén ở trình duyệt |
| `/auth/firebase/login|register|refresh`, `X-User-Id` | Firebase ID token (mục 0) |

---

## 3. API 1 — POST /images/cloudinary/authorize

Mặc định **TẮT**. Muốn bật, đặt trong `backend/.env`:

```env
CLOUDINARY_CONFIRM_MODE=signed
CLOUDINARY_SIGNED_UPLOAD_ENABLED=true
CLOUDINARY_CLOUD_NAME=...
CLOUDINARY_API_KEY=...
CLOUDINARY_API_SECRET=...
```

- Không đặt gì = `disabled` + `false` → authorize, confirm đều `503`.
- `CLOUDINARY_SIGNED_UPLOAD_ENABLED=true` mà mode không phải `signed` → mâu thuẫn → `503`.
- Mode `signed` nhưng cờ `false` → authorize `503`, confirm vẫn chạy (cho các grant đã cấp).
- Mọi giá trị mode khác (kể cả `legacy`) → `503`. Không biến môi trường nào bật lại được đường unsigned.

### 3.1. Request

```http
POST /images/cloudinary/authorize
Authorization: Bearer <idToken>
Content-Type: application/json
```

```json
{
  "imageId": "b1f4c2e0-7a31-4c8e-9f12-3d5a6e7b8c90",
  "fileName": "anh-bien.jpg",
  "originalSize": 2457600,
  "width": 4000,
  "height": 3000,
  "variants": {
    "thumbnail": { "bytes": 9800,   "width": 200, "height": 150 },
    "medium":    { "bytes": 61000,  "width": 800, "height": 600 },
    "webp":      { "bytes": 412000, "width": 4000, "height": 3000 }
  }
}
```

- Bắt buộc: `imageId` (UUID v4), `originalSize` (1 → 10MB), `variants` (đúng 3 khóa, mỗi khóa đúng 3 số nguyên `bytes/width/height`).
- Tùy chọn: `fileName` (≤ 255 ký tự, không ký tự điều khiển, không `/` `\`), `width`, `height`.
- **Field lạ ở bất kỳ cấp nào → `400`.** Client không được gửi `public_id`, folder, URL, chữ ký.
- `thumbnail` cạnh dài > 200 hoặc `medium` > 800 → `400`.

### 3.2. Response 200 (header `Cache-Control: no-store`)

```json
{
  "imageId": "b1f4c2e0-...",
  "expiresAt": "2026-11-27T10:15:00Z",
  "uploadUrl": "https://api.cloudinary.com/v1_1/zftcbu1g/image/upload",
  "apiKey": "<api key công khai>",
  "uploads": {
    "thumbnail": {
      "fields": {
        "public_id": "hybrid/dev/b1f4c2e0-.../thumb",
        "timestamp": "1764238500",
        "overwrite": "false",
        "allowed_formats": "webp",
        "context": "app=hybrid|imageId=b1f4c2e0-...|variant=thumbnail",
        "tags": "hybrid,dev",
        "api_key": "<api key công khai>",
        "signature": "<hex>"
      }
    },
    "medium": { "fields": { "public_id": "hybrid/dev/b1f4c2e0-.../medium", "...": "cùng 8 khóa như trên" } },
    "webp":   { "fields": { "public_id": "hybrid/dev/b1f4c2e0-.../full",   "...": "cùng 8 khóa như trên" } }
  }
}
```

- Mỗi `fields` có **đúng 8 khóa**: 6 khóa đã ký (`public_id, timestamp, overwrite, allowed_formats, context, tags`) + `api_key` + `signature`. Tất cả là **chuỗi** (kể cả `timestamp`).
- `public_id` = `hybrid/<UPLOAD_ENVIRONMENT>/<imageId>/(thumb|medium|full)`, Backend tự tạo, không chứa UID.
- `allowed_formats=webp` → **cả 3 bản (kể cả thumbnail, medium) phải là file WebP**, gửi JPG/PNG Cloudinary sẽ từ chối.
- `overwrite=false` → upload lại cùng `public_id` không ghi đè asset cũ.

Frontend gửi Cloudinary: `file` + **mọi cặp trong `fields`, không thêm, không sửa** (`api_key` đã nằm sẵn trong `fields`; thêm hay sửa 1 field là sai chữ ký). Trường `apiKey` ở ngoài chỉ để tham khảo. Chữ ký có hiệu lực phía Cloudinary khoảng 1 giờ kể từ `timestamp`, nhưng upload phải xong trước `expiresAt` của grant.

Backend lưu `uploadGrants/{imageId}`: `ownerId`, `status=ISSUED`, `publicIds`, `declared` (metadata đã khai), `issuedAt`, `expiresAt`.

### 3.3. Lỗi

| Mã | Khi nào |
|---|---|
| 400 | Body sai, thiếu field, field lạ, kích thước variant vượt giới hạn |
| 401 | Thiếu/sai token |
| 403 | `imageId` đã thuộc người khác (grant hoặc ảnh) |
| 409 | Ảnh đã tồn tại / grant hết hạn / grant không còn ISSUED / gọi lại cùng imageId nhưng metadata khác |
| 429 | Quá `UPLOAD_GRANTS_PER_HOUR` grant mới/giờ (có `retry_after`) |
| 503 | Tính năng tắt hoặc cấu hình thiếu/sai |

---

## 4. API 2 — POST /images/cloudinary/confirm

Gọi SAU KHI cả 3 variant đã upload xong.

### 4.1. Request

```json
{
  "imageId": "b1f4c2e0-7a31-4c8e-9f12-3d5a6e7b8c90",
  "fileName": "anh-bien.jpg",
  "thumbnail": "https://res.cloudinary.com/zftcbu1g/image/upload/v1764238512/<public_id thumbnail>.webp",
  "medium":    "https://res.cloudinary.com/zftcbu1g/image/upload/v1764238513/<public_id medium>.webp",
  "webp":      "https://res.cloudinary.com/zftcbu1g/image/upload/v1764238514/<public_id webp>.webp",
  "originalSize": 2457600,
  "processedSize": 412000,
  "processingMs": 1840,
  "width": 4000,
  "height": 3000
}
```

- Bắt buộc 6 field: `imageId, thumbnail, medium, webp, originalSize, processingMs`. Tùy chọn: `fileName, width, height, processedSize, thumbnailId, mediumId, webpId`.
- 3 URL: dán **nguyên `secure_url` Cloudinary trả về**. URL phải có `v<version>`, đúng cloud `zftcbu1g`, `public_id` khớp grant. Sai → `400 Invalid cloudinary url`.
- `originalSize`, `fileName`, `width`, `height` phải **bằng** giá trị đã khai ở authorize. `processedSize` (nếu gửi) phải bằng bytes thật của asset `webp`. Khác → `409`.
- Backend gọi Cloudinary Admin API 1 lần để xác minh 3 asset. URL/bytes lưu vào Firestore lấy từ Cloudinary, **không tin số client gửi** (trừ `processingMs`).
- Idempotent: confirm lại ảnh đã `DONE` với cùng dữ liệu → trả lại kết quả cũ, không gọi Cloudinary.

### 4.2. Response 200

```json
{
  "imageId": "b1f4c2e0-...",
  "status": "DONE",
  "ownerId": "abc-uid-1",
  "variants": {
    "thumbnail": "https://res.cloudinary.com/.../thumb.webp",
    "thumbnailId": "hybrid/dev/b1f4c2e0-.../thumb",
    "medium": "https://res.cloudinary.com/.../medium.webp",
    "mediumId": "hybrid/dev/b1f4c2e0-.../medium",
    "webp": "https://res.cloudinary.com/.../full.webp",
    "webpId": "hybrid/dev/b1f4c2e0-.../full"
  },
  "processingMs": 1840,
  "savedPercent": 83.2
}
```

Đúng 6 khóa ở cấp ngoài (theo `build_confirm_response` trong `services/cloudinary_confirm.py`). `thumbnailId/mediumId/webpId` là `public_id` lấy từ `publicIds` đã lưu, chỉ có khi doc đã lưu `publicIds` (luồng signed luôn có). Gọi confirm lại (idempotent) trả cùng hình dạng này.

Ghi trong 1 WriteBatch: `images/{imageId}` (`DONE`, `publicIds`, `variants`, `processedSize`, `savedPercent`, `verification`...), 3 doc `cloudinaryAssets/{sha256(public_id)}`, grant `ISSUED → CONFIRMED`.

### 4.3. Lỗi

| Mã | Khi nào |
|---|---|
| 400 | Thiếu field, URL sai cloud/thiếu version, `public_id` khác grant |
| 401 | Thiếu/sai token |
| 403 | Không có grant (`Upload authorization required`) hoặc grant của người khác |
| 409 | Metadata khác grant, grant hết hạn, asset trên Cloudinary không khớp, ảnh/asset đã đăng ký |
| 503 | Cấu hình signed thiếu, hoặc Cloudinary Admin API không trả lời được |

---

## 5. API 3 — GET /images (Gallery)

```http
GET /images?limit=20&cursor=<nextCursor>
Authorization: Bearer <idToken>
```

- `limit` mặc định 20, > 20 bị ép về 20, không phải số nguyên dương → `400`.
- `cursor`: chuỗi mờ, truyền lại nguyên văn `nextCursor` của trang trước. Trang đầu bỏ trống.
- Chỉ trả ảnh của `uid` đang gọi, mới nhất trước. Trang đầu tự đồng bộ Drive của chính user. Không quét Cloudinary.

```json
{
  "items": [
    {
      "imageId": "aaa...",
      "fileName": "anh-1.jpg",
      "status": "DONE",
      "previewUrl": "https://res.cloudinary.com/.../thumb.webp",
      "variants": { "thumbnail": "...", "medium": "...", "webp": "..." },
      "createdAt": "2026-11-27T09:20:00Z"
    }
  ],
  "nextCursor": "ey...",
  "hasMore": true
}
```

`nextCursor = null` là hết trang.

---

## 6. API 4 — GET /images/{imageId}

Trả đầy đủ doc: `imageId, status, ownerId, fileName, provider, original{size,width,height}, variants, previewUrl, processedSize, processingMs, savedPercent, errorReason, createdAt, updatedAt`.

Lỗi: `401`, `403` (ảnh người khác), `404 { "detail": "Image not found" }`.

---

## 7. API 5 — DELETE /images/{imageId} (MỚI — Duy code)

```http
DELETE /images/b1f4c2e0-...
Authorization: Bearer <idToken>
```

### 7.1. Kết quả

| Trường hợp | Kết quả |
|---|---|
| Chủ ảnh xóa thành công | `204` không body |
| Thiếu/sai token | `401 { "detail": "Missing token" }` |
| Ảnh của người khác | `403 { "detail": "Forbidden" }` |
| Không tồn tại / đã xóa rồi | `404 { "detail": "Image not found" }` |
| Ảnh không phải Cloudinary (Drive) | `400 { "detail": "Unsupported provider" }` |
| Cloudinary lỗi / timeout / hết lượt | `503 { "detail": "Delete unavailable" }`, **doc Firestore giữ nguyên** để xóa lại được |

### 7.2. Thứ tự trong Backend

1. Xác thực token → lấy `uid`.
2. Đọc `images/{imageId}`. Không có → 404. `ownerId != uid` → 403.
3. Lấy 3 `public_id` từ `publicIds` của doc. Doc cũ không có `publicIds` thì tách từ URL bằng `parse_cloudinary_url`.
4. Xóa 3 asset trên Cloudinary bằng **1 lời gọi** Admin API: `DELETE /v1_1/<cloud>/resources/image/upload?public_ids[]=...`. Asset trả `not_found` coi như đã xóa.
5. Chỉ khi bước 4 thành công, ghi 1 WriteBatch:
   - xóa `images/{imageId}`;
   - xóa 3 doc `cloudinaryAssets/{sha256(public_id)}`;
   - **không xóa** grant, đổi `uploadGrants/{imageId}.status = "DELETED"` để imageId này không bao giờ dùng lại được.
6. Trả `204`.

### 7.3. Lưu ý code

- `services/cloudinary_admin.py` hiện **chỉ đọc** (`get_resources`). Phải thêm hàm `delete_resources(public_ids, timeout)` cùng phong cách: không retry, có timeout, lỗi quy về `AdminError`/`AdminRateLimited`/`AdminUnavailable`, không log secret.
- **Thêm `"DELETE"` vào `allow_methods` của CORS trong `main.py`** (hiện chỉ có `GET`, `POST`). Thiếu là trình duyệt chặn, dù Postman vẫn chạy.
- Test tối thiểu: chủ xóa được (Cloudinary fake nhận đúng 3 id) · người khác 403 · không token 401 · không tồn tại 404 · Cloudinary lỗi thì doc còn nguyên · xóa xong confirm lại cùng imageId bị 409.

---

## 8. API 6 — GET /admin/stats (Leader code)

```http
GET /admin/stats?window=24h
Authorization: Bearer <adminIdToken>
```

```json
{
  "byStatus": { "DONE": 95, "FAILED": 2 },
  "total": 97,
  "avgProcessingMs": 1840,
  "p95ProcessingMs": 3200,
  "savedPercent": 83.2,
  "window": "24h"
}
```

- Chỉ tính 24h gần nhất (index `createdAt`). Cache 5 phút phía server. Không phải admin → `403`.

---

## 9. Mã lỗi thống nhất (Frontend check `if (!res.ok) show(data.detail)`)

| Mã | Khi nào | Ai dễ gặp |
|---|---|---|
| 200 | OK | — |
| 204 | Xóa xong (không body) | Tại |
| 400 | Dữ liệu sai: field thiếu/lạ, URL sai, `limit` sai | Dũng, Tại |
| 401 | Thiếu/sai token | Tại (quên gắn token) |
| 403 | Không quyền / chưa authorize | Test user B đọc/xóa ảnh user A |
| 404 | Không thấy ảnh | Gõ sai imageId |
| 409 | Lệch với grant / grant hết hạn / ảnh đã có | Dũng (nén lại ra số khác), Tại (dùng lại imageId) |
| 410 | Gọi API đã retire (`/images/upload-url`) | Code cũ |
| 429 | Quá lượt authorize/giờ | Test tải 100 ảnh: chỉnh `UPLOAD_GRANTS_PER_HOUR` |
| 503 | Tính năng signed tắt / cấu hình thiếu / Cloudinary không trả lời | Người chạy local quên `.env` |

---

## 10. Quy ước lưu trữ

- **Cloudinary (luồng chính):** chỉ signed upload. `public_id` do Backend đặt. Unsigned preset phải **tắt trên Cloudinary Console** (Hưng).
- **Firestore (chỉ Backend ghi, rules chặn client):**
  - `images/{imageId}`: `ownerId, status, fileName, provider, original{size,width,height}, variants{thumbnail,medium,webp}, publicIds, previewUrl, processedSize, processingMs, savedPercent, errorReason, verification, createdAt, updatedAt`.
  - `uploadGrants/{imageId}`: `ownerId, status (ISSUED → CONFIRMED → DELETED), publicIds, declared, issuedAt, expiresAt`.
  - `cloudinaryAssets/{sha256(public_id)}`: sổ "1 asset chỉ thuộc 1 ảnh".
  - Doc slot giới hạn tốc độ authorize (Backend tự quản).
- **Trạng thái:** ảnh Cloudinary luồng signed chỉ có `DONE` (confirm lỗi thì **không ghi gì**). `PENDING/PROCESSING/FAILED` chỉ còn ở dữ liệu Drive/cũ.
- **Cấu hình `.env` liên quan:** `CLOUDINARY_CONFIRM_MODE=signed` + `CLOUDINARY_SIGNED_UPLOAD_ENABLED=true` (mục 3), `CLOUDINARY_SIGNATURE_ALGORITHM` (`sha256` mặc định), `UPLOAD_ENVIRONMENT` (`dev` mặc định, nằm trong `public_id`), `UPLOAD_GRANT_TTL_SECONDS` (≤ 3600), `UPLOAD_GRANTS_PER_HOUR` (≤ 100), `CLOUDINARY_ADMIN_TIMEOUT_SECONDS`, `UPLOAD_CONFIRM_BUDGET_SECONDS`, `UPLOAD_VERIFY_CLOCK_SKEW_SECONDS`, key/secret Cloudinary. Không commit `.env`.

---

## 11. Checklist nối cho Tại (Frontend)

1. `loginWithGoogle` → giữ `idToken` (refresh khi hết hạn).
2. Chọn file → `checkFile` → tạo `imageId` → `processImageClient` (Dũng).
3. `POST /images/cloudinary/authorize` → 3 lần upload Cloudinary bằng `fields` → `POST /images/cloudinary/confirm` → `DONE` thì thêm vào gallery.
4. Gallery `GET /images?limit=20`, cuộn thì gọi tiếp với `nextCursor`. Bấm ảnh → `GET /images/{imageId}`.
5. Nút Xóa → `DELETE /images/{imageId}` → `204` thì bỏ ảnh khỏi lưới. `503` thì báo "Thử xóa lại".

---

## 12. Lịch sử đổi

1. Bản AWS gốc: presigned S3, Lambda Sharp, SQS.
2. Bản client-side: SDK trực tiếp Storage (bỏ vì Blaze cần thẻ).
3. Bản Backend thuần: FastAPI + Pillow + Drive + Cloudinary qua server, `X-User-Id`.
4. Bản hybrid unsigned: client nén + upload preset unsigned, Backend chỉ confirm.
5. **Bản này (27/11):** chốt backend `feat/backend-hybrid-confirm`, signed upload (authorize + confirm xác minh Admin API), retire unsigned/`upload-url`/`retry`/auth cũ, thêm `DELETE /images/{imageId}`.
