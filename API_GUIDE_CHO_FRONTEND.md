# Frontend Test Bench — Image Pipeline & Google Drive Integration

Tài liệu này hướng dẫn cách sử dụng giao diện Frontend thuần (HTML + Tailwind CSS + Vanilla JS) để tương tác với Backend Core (`feat/upload`), hỗ trợ kiểm thử toàn bộ luồng xác thực Firebase + Google OAuth2 (Popup), quản lý thư mục Google Drive, đồng bộ pipeline theo `imageId`, tích hợp Cloudinary (`UC01`–`UC04`), quy trình xử lý ảnh tự động (Pipeline states) và cơ chế phân quyền bảo mật.

## 🚀 Tính năng chính trên Frontend

1. **Firebase Auth & Google OAuth2 Popup:** Đăng nhập Google qua popup Firebase Auth để lấy Bearer Token (`Authorization: Bearer <idToken>`) và mở popup liên kết Google Drive (`drive.file`), tự động nhận tín hiệu `postMessage` (`GOOGLE_DRIVE_LINKED`) để quay lại tab chính và đồng bộ dữ liệu.

2. **Quản lý UID & Giả lập phân quyền:** Hiển thị UID hiện tại, hỗ trợ sao chép Bearer Token, hoặc giả lập chuyển đổi sang người dùng khác (`User B`) để kiểm tra phân quyền (`403 Forbidden`) và khôi phục lại tài khoản thật.

3. **Google Drive Folder Management & Auto Sync:** Tạo thư mục gốc trên Google Drive kèm 3 thư mục con (`upload`, `processing`, `processed`), hỗ trợ chỉ định thư mục cha hoặc reset về thư mục mặc định. Sau khi liên kết Drive, tạo/chọn folder hoặc tải ảnh Drive, hệ thống quét 3 thư mục `upload`, `processing`, `processed` để cập nhật/đồng bộ dữ liệu theo `imageId` lên giao diện.

4. **Cloudinary Integration (`UC01`–`UC04`):** Hỗ trợ upload ảnh lên Cloudinary (`POST /images/cloudinary/upload`), kiểm tra request upload (`POST /images/cloudinary/upload-url`), kích hoạt tạo/làm mới biến thể (`POST /images/cloudinary/{image_id}/process`), xem chi tiết trạng thái (`GET /images/cloudinary/{image_id}`) và lọc danh sách ảnh Cloudinary (`GET /images/cloudinary`).

5. **Image Pipeline & State Control (`UC01`–`UC02`):**

   - Upload ảnh (`.jpg`, `.png`, `.webp`, $\le 10\text{MB}$) lên thư mục `upload/` trên Google Drive (`POST /images/upload-drive`).

   - Tự động chạy background task và polling trạng thái khi bật `autoProcess`, hoặc chuyển thủ công qua các giai đoạn: `upload/` (`PENDING`) $\rightarrow$ `processing/` (`PROCESSING`) $\rightarrow$ `processed/` (`COMPLETED` / `DONE` kèm các biến thể `thumbnail`, `medium`, `webp`).

   - Kiểm thử nhanh quy tắc `checkFile` (định dạng và dung lượng $\le 10\text{MB}$) qua `POST /images/upload-url` và `POST /images/cloudinary/upload-url`.

6. **Hiển thị ảnh trực tiếp (`UC03` & `UC04`):**

   - **UC04 (Gallery):** Xem danh sách thư viện ảnh (`GET /images`, `GET /images/drive`, `GET /images/cloudinary`) dạng lưới với badge trạng thái; khi bấm vào ảnh Drive chưa có `imageId` hệ thống, chuyển sang xem qua preview proxy an toàn.

   - **UC03 (Detail Preview):** Xem chi tiết trạng thái (`GET /images/{image_id}`, `GET /images/cloudinary/{image_id}`), stepper 3 giai đoạn (`1. UPLOAD/`, `2. PROCESSING/`, `3. PROCESSED/`), tự động cập nhật `imageId` từ response API, xem 4 khung ảnh (Ảnh gốc / Preview, `variants.thumbnail`, `variants.medium`, `variants.webp`) và kiểm tra luồng stream trực tiếp qua `GET /images/preview/{drive_file_id}?uid=...`.

## 🛠️ Cấu trúc thư mục

```text
frontend/
├── index.html       # Giao diện Test Bench gộp HTML, Tailwind CSS và Vanilla JS tích hợp API
└── README.md        # Tài liệu hướng dẫn sử dụng và tích hợp API
```

## ⚙️ Hướng dẫn cài đặt và Khởi chạy

### 1. Yêu cầu tiên quyết

- Đã khởi động Backend API server (mặc định tại `http://localhost:8000`; có thể chỉnh trực tiếp ô **Backend API Base URL** trên giao diện và bấm **Áp dụng**).

- Đã cấu hình Google OAuth Client ID trên Google Cloud Console với Authorized redirect URI: `http://localhost:8000/oauth/callback`.

- Đã cấu hình Firebase Authentication (bật nhà cung cấp Google và thêm origin frontend vào Authorized domains nếu cần).

- Đã cấu hình upload preset / thông tin Cloudinary phía backend cho luồng Cloudinary.

### 2. Chạy Frontend

Mở Terminal, di chuyển vào thư mục `frontend/` và chạy một HTTP server tĩnh:

```bash
cd frontend
python -m http.server 3000
```

Sau đó mở trình duyệt và truy cập: **`http://localhost:3000/index.html`**

## 🔌 Tài liệu tích hợp các API (API Integration Guide)

Frontend giao tiếp với Backend thông qua các endpoint chính sau (đính kèm `Authorization: Bearer <Firebase_ID_Token>` cho các endpoint được bảo vệ):

### 1. Xác thực & Liên kết Google OAuth2

| Phương thức | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/oauth/google/login?uid=...` | Lấy URL đăng nhập Google OAuth2 dạng JSON kèm `state`. |
| `GET` | `/oauth/google/redirect?uid=...&popup=1` | Mở luồng OAuth2 qua popup để liên kết Google Drive và gửi `postMessage` (`GOOGLE_DRIVE_LINKED`) về tab chính. |

### 2. Quản lý & Đồng bộ Thư mục Google Drive

| Phương thức | Endpoint | Body / Payload | Mô tả |
| :--- | :--- | :--- | :--- |
| `POST` | `/images/drive/folders` | `{"folderName": "string", "parentId": "string\|null"}` | Tạo thư mục gốc và bộ 3 thư mục pipeline (`upload`, `processing`, `processed`) trên Drive. |
| `POST` | `/images/drive/sync` | `{"folderId": "string\|null"}` | Quét 3 thư mục `upload`, `processing`, `processed` và cập nhật/đồng bộ metadata ảnh theo `imageId`. |

### 3. Use Case 01 & 02: Upload ảnh & Pipeline Trạng thái (Google Drive)

| Phương thức | Endpoint | Kiểu dữ liệu | Mô tả |
| :--- | :--- | :--- | :--- |
| `POST` | `/images/upload-url` | `JSON` (`filename`, `contentType`, `sizeBytes`) | Kiểm tra file (`checkFile`: định dạng `.jpg/.png/.webp`, $\le 10\text{MB}$) và cấp thông tin upload. |
| `POST` | `/images/upload-drive` | `FormData` (`file`, `folderId`, `autoProcess`) | Upload file thật lên thư mục `upload/` (`status: PENDING`). Nếu `autoProcess=true`, chạy pipeline tự động và polling cập nhật trạng thái. |
| `POST` | `/images/{image_id}/process` | Không có | Chuyển thủ công ảnh sang thư mục `processing/` (`status: PROCESSING`). |
| `POST` | `/images/{image_id}/complete` | Không có | Tạo variants (`thumbnail`, `medium`, `webp`), di chuyển file sang `processed/` (`status: COMPLETED` / `DONE`). |

### 4. Use Case 03 & 04: Xem trạng thái, Thư viện & Xem trước ảnh (Google Drive)

| Phương thức | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/images` | **UC04:** Lấy danh sách toàn bộ ảnh của người dùng hiện tại. |
| `GET` | `/images/drive?folderId=...` | **UC04:** Lấy danh sách ảnh trên Google Drive (kèm đồng bộ pipeline theo `imageId`). |
| `GET` | `/images/{image_id}` | **UC03:** Lấy chi tiết trạng thái ảnh và các `variants`. *(Sai quyền sở hữu trả về **403 Forbidden**, không tồn tại trả về **404 Not Found**)*. |
| `GET` | `/images/preview/{drive_file_id}?uid=...` | Stream trực tiếp tệp ảnh từ Google Drive về thẻ `<img>` trên Frontend một cách bảo mật. |

### 5. API Cloudinary (`UC01`, `UC02`, `UC03`, `UC04`)

| Phương thức | Endpoint | Kiểu dữ liệu / Payload | Mô tả |
| :--- | :--- | :--- | :--- |
| `POST` | `/images/cloudinary/upload-url` | `JSON`: `{"filename": "string", "contentType": "string", "sizeBytes": number}` | **UC01:** Kiểm tra file (`checkFile`), tạo `imageId` và trả về thông tin upload Cloudinary (`status: PENDING`). |
| `POST` | `/images/cloudinary/upload` | `FormData`: `file` | **UC01 + UC02:** Upload file lên Cloudinary, lưu metadata, sinh `variants` (`thumbnail`, `medium`, `webp`) và cập nhật `status: COMPLETED`. |
| `POST` | `/images/cloudinary/{image_id}/process` | Không có | **UC02:** Kích hoạt tạo hoặc làm mới các biến thể `variants.thumbnail`, `variants.medium`, `variants.webp` trên Cloudinary và cập nhật `status: COMPLETED`. |
| `GET` | `/images/cloudinary` | Không có | **UC04:** Lấy danh sách ảnh có `provider = "cloudinary"` của người dùng. |
| `GET` | `/images/cloudinary/{image_id}` | Không có | **UC03:** Lấy chi tiết trạng thái xử lý và URL các biến thể (`variants.thumbnail`, `variants.medium`, `variants.webp`). |

#### Ví dụ gọi nhanh API Cloudinary bằng `fetch`

```javascript
const API_BASE = "http://localhost:8000";
const token = localStorage.getItem("FIREBASE_ID_TOKEN") || "";
const authHeaders = token ? { Authorization: `Bearer ${token}` } : {};

// 1. UC01 + UC02: Upload ảnh lên Cloudinary
async function uploadCloudinary(file) {
  const formData = new FormData();
  formData.append("file", file);

  const res = await fetch(`${API_BASE}/images/cloudinary/upload`, {
    method: "POST",
    headers: authHeaders,
    body: formData,
  });
  return await res.json();
}

// 2. UC03: Xem chi tiết ảnh Cloudinary
async function getCloudinaryImage(imageId) {
  const res = await fetch(`${API_BASE}/images/cloudinary/${imageId}`, {
    method: "GET",
    headers: authHeaders,
  });
  return { status: res.status, data: await res.json() };
}

// 3. UC04: Lấy danh sách ảnh Cloudinary của user
async function listCloudinaryImages() {
  const res = await fetch(`${API_BASE}/images/cloudinary`, {
    method: "GET",
    headers: authHeaders,
  });
  return await res.json();
}
```

## 🧪 Kịch bản kiểm thử nhanh trên Frontend

1. **Đăng nhập Google (Firebase Popup):** Bấm **"Đăng nhập Google (Popup)"** $\rightarrow$ Xác thực tài khoản Google để lưu Firebase ID Token và UID.

2. **Liên kết Google Drive (Popup):** Bấm **"Liên kết Drive (Popup)"** $\rightarrow$ Cấp quyền Google Drive trong cửa sổ popup; khi hoàn tất, popup tự đóng/nhắn tin về tab chính và tự động đồng bộ pipeline theo `imageId`.

3. **Tạo / Chọn Folder Drive:** Nhập tên thư mục (ví dụ: `App_Image_Pipeline`, tùy chọn `Parent Folder ID`) và bấm **"Tạo Folder"** $\rightarrow$ Hệ thống tạo cấu trúc `upload`, `processing`, `processed` và tự gọi đồng bộ dữ liệu theo `imageId`.

4. **Upload & Xem Pipeline (Google Drive):** Chọn file ảnh (`.jpg`, `.png`, `.webp`, $\le 10\text{MB}$), tích chọn **"Tự động chạy pipeline Drive"** và bấm **"POST /images/upload-drive"**. Quan sát thanh Stepper (`1. UPLOAD/`, `2. PROCESSING/`, `3. PROCESSED/`) và **API Response Log**.

5. **Upload & Xử lý Cloudinary:** Chọn file ảnh và bấm **"POST /images/cloudinary/upload"** (hoặc test `POST /images/cloudinary/upload-url` và `POST /images/cloudinary/{id}/process`), sau đó bấm **"GET /images/cloudinary"** ở mục UC04.

6. **Kiểm tra UC03, Preview Proxy & Phân quyền:** Bấm vào ảnh trong thư viện (UC04) hoặc nhập `imageId` / `driveFileId` và bấm **"GET /{id}"**, **"GET /cloudinary/{id}"**, hoặc **"GET /preview/{id}"** để xem 4 khung ảnh. Thử bấm **"Giả lập User B (Test 403)"** rồi gọi lại `GET /{id}` để kiểm tra phản hồi phân quyền từ backend, sau đó bấm **"Khôi phục User thật"**.