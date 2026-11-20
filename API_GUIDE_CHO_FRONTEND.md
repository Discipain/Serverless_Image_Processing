# Frontend Test Bench — Image Pipeline & Google Drive Integration

Tài liệu này hướng dẫn cách sử dụng giao diện Frontend thuần (HTML + Tailwind CSS + Vanilla JS) để tương tác với Backend Core (`feat/upload`), hỗ trợ kiểm thử toàn bộ luồng xác thực Google OAuth2, quản lý thư mục Google Drive, tích hợp Cloudinary (`UC01`–`UC04`), quy trình xử lý ảnh tự động (Pipeline states) và cơ chế phân quyền bảo mật.

## 🚀 Tính năng chính trên Frontend

1. **Google OAuth2 Login:** Đăng nhập bằng tài khoản Google và cấp quyền truy cập Google Drive (`drive.file`), tự động nhận diện và lưu `X-User-Id` vào `localStorage`.

2. **Quản lý `X-User-Id` thủ công:** Hỗ trợ nhập/lưu `X-User-Id` hoặc giả lập chuyển đổi nhanh sang tài khoản khác (`User B`) để kiểm tra lỗi bảo mật `403 Forbidden`.

3. **Google Drive Folder Management:** Tạo thư mục làm việc trên Google Drive cá nhân của người dùng kèm 3 thư mục con (`upload`, `processing`, `processed`).

4. **Cloudinary Integration (`UC01`–`UC04`):** Hỗ trợ upload ảnh lên Cloudinary (`zftcbu1g`, preset `serverless_image_preset`), tạo/làm mới biến thể (`variants.thumbnail`, `variants.medium`, `variants.webp`), xem chi tiết trạng thái và duyệt thư viện ảnh Cloudinary.

5. **Image Pipeline & State Control (`UC01`):**

   * Upload ảnh (`.jpg`, `.png`, `.webp`, $\le 10\text{MB}$) lên thư mục `upload/` trên Google Drive.

   * Tự động hoặc thủ công chuyển trạng thái qua các thư mục: `upload/` (`PENDING`) $\rightarrow$ `processing/` (`PROCESSING`) $\rightarrow$ `processed/` (`COMPLETED` kèm các biến thể `thumbnail`, `medium`, `webp`).

6. **Hiển thị ảnh trực tiếp (`UC03` & `UC04`):**

   * **UC04 (Gallery):** Xem danh sách thư viện ảnh dạng lưới trực quan với badge trạng thái.

   * **UC03 (Detail Preview):** Xem chi tiết trạng thái, tự động nhận `imageId` từ response API, và xem đồng thời 4 khung ảnh (Ảnh gốc, `variants.thumbnail`, `variants.medium`, `variants.webp`) thông qua proxy stream an toàn từ Google Drive hoặc URL trực tiếp từ Cloudinary.

## 🛠️ Cấu trúc thư mục

```text
frontend/
├── index.html       # Giao diện gộp HTML, Tailwind CSS và JavaScript tích hợp API
└── README.md        # Tài liệu hướng dẫn sử dụng và tích hợp API
```

## ⚙️ Hướng dẫn cài đặt và Khởi chạy

### 1. Yêu cầu tiên quyết

* Đã khởi động Backend API server (mặc định tại `http://localhost:8000`).

* Đã cấu hình Google OAuth Client ID trên Google Cloud Console với Authorized redirect URI: `http://localhost:8000/oauth/callback`.

* Đã cấu hình Unsigned Upload Preset `serverless_image_preset` trên Cloudinary cloud `zftcbu1g`.

### 2. Chạy Frontend

Mở Terminal, di chuyển vào thư mục `frontend/` và chạy một HTTP server tĩnh:

```bash
cd frontend
python -m http.server 3000
```

Sau đó mở trình duyệt và truy cập: **`http://localhost:3000/index.html`**

## 🔌 Tài liệu tích hợp các API (API Integration Guide)

Frontend giao tiếp với Backend thông qua các endpoint chính sau:

### 1. Xác thực & Người dùng (`X-User-Id`)

Mọi request gửi lên Backend (trừ OAuth login) đều phải đính kèm Header xác thực:

* **Header Key:** `X-User-Id`

* **Giá trị:** Google UID của người dùng (được lưu tự động vào `localStorage` sau khi đăng nhập Google hoặc nhập thủ công ở ô cấu hình).

| Phương thức | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/oauth/google/login` | Lấy URL đăng nhập Google OAuth2 dạng JSON. |
| `GET` | `/oauth/google/redirect` | Chuyển hướng trình duyệt trực tiếp đến trang đăng nhập Google. |

### 2. Quản lý Thư mục Google Drive

| Phương thức | Endpoint | Body / Payload | Mô tả |
| :--- | :--- | :--- | :--- |
| `POST` | `/images/drive/folders` | `{"folderName": "string", "parentId": "string\|null"}` | Tạo thư mục gốc và bộ 3 thư mục pipeline (`upload`, `processing`, `processed`) trên Drive. |

### 3. Use Case 01: Upload ảnh & Pipeline Trạng thái (Google Drive)

| Phương thức | Endpoint | Kiểu dữ liệu | Mô tả |
| :--- | :--- | :--- | :--- |
| `POST` | `/images/upload-url` | `JSON` | Kiểm tra file (`checkFile`: định dạng, $\le 10\text{MB}$) và cấp URL upload kèm metadata chuẩn `SCHEMA.md`. |
| `POST` | `/images/upload-drive` | `FormData` (`file`, `folderId`, `autoProcess`) | Upload file thật lên thư mục `upload/` (`status: PENDING`). Nếu `autoProcess=true`, tự động chạy background task chuyển state. |
| `POST` | `/images/{image_id}/process` | Không có | Chuyển thủ công ảnh sang thư mục `processing/` (`status: PROCESSING`). |
| `POST` | `/images/{image_id}/complete` | Không có | Render variants (`thumbnail`, `medium`, `webp`), di chuyển file sang `processed/` (`status: COMPLETED`). |

### 4. Use Case 03 & 04: Xem trạng thái, Thư viện & Xem trước ảnh (Google Drive)

| Phương thức | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/images` | **UC04:** Lấy danh sách toàn bộ ảnh thuộc sở hữu của `X-User-Id`. |
| `GET` | `/images/{image_id}` | **UC03:** Lấy chi tiết trạng thái ảnh. *(Nếu `X-User-Id` không khớp `ownerId`, Backend trả về lỗi **403 Forbidden**)*. |
| `GET` | `/images/preview/{drive_file_id}?uid=...` | Stream trực tiếp tệp ảnh từ Google Drive về thẻ `<img>` trên Frontend một cách bảo mật. |

### 5. API Cloudinary (`UC01`, `UC02`, `UC03`, `UC04`)

Frontend tương tác với các endpoint Cloudinary thông qua Backend (vẫn yêu cầu Header `X-User-Id`, áp dụng luật `checkFile` $\le 10\text{MB}$ cho `.jpg / .png / .webp`, và giữ nguyên cấu trúc `variants.thumbnail`, `variants.medium`, `variants.webp`):

| Phương thức | Endpoint | Kiểu dữ liệu / Payload | Mô tả |
| :--- | :--- | :--- | :--- |
| `POST` | `/images/cloudinary/upload-url` | `JSON`: `{"filename": "string", "contentType": "string", "sizeBytes": number}` | **UC01:** Kiểm tra file (`checkFile`), tạo `imageId` và trả về `uploadUrl` + `cloudinaryConfig` + metadata `status: PENDING`. |
| `POST` | `/images/cloudinary/upload` | `FormData`: `file` | **UC01 + UC02:** Upload file trực tiếp lên Cloudinary, lưu metadata (`ownerId = X-User-Id`), tự động sinh `variants` (`thumbnail`, `medium`, `webp`) và trả về `status: COMPLETED`. |
| `POST` | `/images/cloudinary/{image_id}/process` | Không có | **UC02:** Kích hoạt tạo hoặc làm mới các biến thể `variants.thumbnail`, `variants.medium`, `variants.webp` từ `publicId` trên Cloudinary và cập nhật `status: COMPLETED`. |
| `GET` | `/images/cloudinary` | Không có | **UC04:** Lấy danh sách ảnh thuộc sở hữu của `X-User-Id` có `provider = "cloudinary"`. |
| `GET` | `/images/cloudinary/{image_id}` | Không có | **UC03:** Lấy chi tiết trạng thái xử lý và URL các biến thể (`variants.thumbnail`, `variants.medium`, `variants.webp`). *(Sai chủ sở hữu trả về **403 Forbidden**)*. |

#### Ví dụ gọi nhanh API Cloudinary bằng `fetch`

```javascript
const API_BASE = "http://localhost:8000";
const headers = { "X-User-Id": localStorage.getItem("X-User-Id") || "" };

// 1. UC01 + UC02: Upload ảnh lên Cloudinary
async function uploadCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}/images/cloudinary/upload`, {
    method: "POST",
    headers,
    body: formData,
  });
  return await res.json();
}

// 2. UC03: Xem chi tiết ảnh Cloudinary (hoặc test 403 khi đổi X-User-Id)
async function getCloudinaryImage(imageId) {
  const res = await fetch(`${API_BASE}/images/cloudinary/${imageId}`, {
    method: "GET",
    headers,
  });
  return { status: res.status, data: await res.json() };
}

// 3. UC04: Lấy danh sách ảnh Cloudinary của user
async function listCloudinaryImages() {
  const res = await fetch(`${API_BASE}/images/cloudinary`, {
    method: "GET",
    headers,
  });
  return await res.json();
}
```

## 🧪 Kịch bản kiểm thử nhanh trên Frontend

1. **Đăng nhập Google:** Bấm **"Đăng nhập Google & Cấp quyền Drive"** $\rightarrow$ Xác thực tài khoản Google. Trình duyệt tự quay về Frontend và lưu `X-User-Id`.

2. **Tạo Folder:** Nhập tên thư mục (ví dụ: `App_Image_Pipeline`) và bấm **"Tạo Folder"**.

3. **Upload & Xem Pipeline (Google Drive):** Chọn file ảnh (`.jpg`, `.png`, `.webp`), tích chọn **"Tự động chạy toàn bộ pipeline"** và bấm **"Upload Google Drive"**. Quan sát thanh Stepper nhảy trạng thái trực quan từ `UPLOAD` $\rightarrow$ `PROCESSING` $\rightarrow$ `PROCESSED`.

4. **Upload & Xử lý Cloudinary:** Chọn file ảnh và bấm **"Upload Cloudinary (UC01+02)"** để kiểm tra sinh `variants.thumbnail`, `variants.medium`, `variants.webp` và lọc ảnh ở mục **UC04 ("Chỉ Cloudinary")**.

5. **Kiểm tra UC03 & UC04:** Bấm vào bất kỳ ảnh nào trong thư viện (UC04) để xem chi tiết 4 phiên bản ảnh (Ảnh gốc, Thumbnail, Medium, WebP) ở phần UC03.

6. **Kiểm tra lỗi 403 (Đọc trộm):**

   * Giữ nguyên `imageId` của ảnh vừa tạo.

   * Bấm **"Đổi sang User B (Test 403)"**.

   * Bấm **"Xem UC03"** hoặc **"UC03 Cloud"** để kiểm tra hệ thống chặn đứng và trả về lỗi **403 Forbidden** do sai quyền sở hữu (`ownerId`).