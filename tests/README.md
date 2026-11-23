# tests/ — file kiểm thử Frontend (chỉ để kiểm thử, KHÔNG thuộc ứng dụng và không có trong bản build)

Không có file nào ở đây được import từ `src/`. Vite chỉ build `index.html`, nên thư mục này không vào `dist/`.

```
tests/
  README.md
  manual/   cloudinary-check.html, cloudinaryCheck.js     (kiểm thử thủ công H2)
  smoke/    smoke.mjs (H1), h2-smoke.mjs, h3a-smoke.mjs, h4a-smoke.mjs, int3a-gallery-smoke.mjs, int3b-gallery-ui-smoke.mjs,
            int3c1-provider-smoke.mjs
```

## manual/ — trang kiểm thử thủ công H2 (Cloudinary)

- Chạy `npm run dev`, rồi mở <http://localhost:5173/tests/manual/cloudinary-check.html>
- Trang **không tự upload**. Chỉ khi chọn ảnh → nén → tick xác nhận → bấm "Upload thật" mới gửi **3 ảnh WebP THẬT**
  lên Cloudinary của nhóm (unsigned preset, không có thao tác xóa). Không gọi Backend, không ghi Firestore.
  Chỉ dùng ảnh thử không nhạy cảm.
- Cần `VITE_CLOUDINARY_CLOUD_NAME` và `VITE_CLOUDINARY_UPLOAD_PRESET` trong `.env.local` (không commit file này).

## smoke/ — smoke test Node + Vite SSR (không gọi mạng)

Mỗi script chạy độc lập, chỉ cần `node_modules` của dự án (đã `npm install`). Không phụ thuộc file nào ngoài repo.
Mạng được thay bằng **XMLHttpRequest giả (H2)**, **fetch giả (H3A)** hoặc **bẫy ném lỗi + đếm request (H4A)**; token trong
test là chuỗi giả. Không gọi Cloudinary, Backend hay Firebase thật.

| Script | Phạm vi | Kết quả mong đợi |
|---|---|---|
| `smoke.mjs` | H1: Auth (Firebase/MOCK), Header, Login | `PASSED: 47`, `FAILED: 0` |
| `h2-smoke.mjs` | H2: Cloudinary uploader, upload 3 biến thể | `PASSED: 85`, `FAILED: 0` |
| `h3a-smoke.mjs` | H3A: Backend client, payload confirm, MOCK Backend | `PASSED: 244`, `FAILED: 0` |
| `h4a-smoke.mjs` | H4A: luồng upload Hybrid bằng MOCK | `PASSED: 141`, `FAILED: 0` |
| `int3a-gallery-smoke.mjs` | INT-3A: Gallery API client (`GET /images`, `GET /images/{id}`), ánh xạ schema, MOCK | `PASSED: 188`, `FAILED: 0` |
| `int3b-gallery-ui-smoke.mjs` | INT-3B: chọn MOCK/REAL, controller phân trang, đổi user/response muộn, giao diện Gallery (SSR) | `PASSED: 189`, `FAILED: 0` |
| `int3c1-provider-smoke.mjs` | INT-3C.1 (F1): thiếu `GalleryServicesContext.Provider` — MOCK có cảnh báo; REAL/giá trị lạ -> lỗi cấu hình, không MOCK | `PASSED: 125`, `FAILED: 0` |

`int3a-gallery-smoke.mjs` dùng "Backend giả" mô phỏng ngữ nghĩa Backend thật (uid từ token, cursor mờ, JSON dạng Firestore) và
**chặn mọi fetch/XHR toàn cục** (đếm = 0 là điều kiện đạt). Bản thân nó KHÔNG chứng minh tích hợp với Backend thật.

`int3b-gallery-ui-smoke.mjs` không có DOM (không cài jsdom): giao diện kiểm bằng SSR (`renderToString`), còn phân trang/đổi user/response muộn
kiểm trực tiếp trên `galleryListController` (store thuần mà hook gắn vào React bằng `useSyncExternalStore`). Hành vi trong trình duyệt thật
(StrictMode, sự kiện `onError` của `<img>`, bấm nút) cần kiểm thủ công.

`int3c1-provider-smoke.mjs` tạo `.env` TẠM (thư mục hệ thống, ngoài repo) cho từng giá trị `VITE_GALLERY_MODE` để Vite nạp biến thật rồi render
`GalleryPage` có/không có Provider (SSR). Mạng toàn cục bị chặn và đếm.

### Chạy (PowerShell, từ thư mục gốc dự án)

`EMPTY_ENV_DIR` phải trỏ tới một thư mục **rỗng**, để Vite không đọc `.env.local` khi chạy test.

```powershell
$env:EMPTY_ENV_DIR = (New-Item -ItemType Directory -Path (Join-Path $env:TEMP 'smoke-empty-env') -Force).FullName
node tests/smoke/smoke.mjs .
node tests/smoke/h2-smoke.mjs .
node tests/smoke/h3a-smoke.mjs .
node tests/smoke/h4a-smoke.mjs .
node tests/smoke/int3a-gallery-smoke.mjs .
node tests/smoke/int3b-gallery-ui-smoke.mjs .
node tests/smoke/int3c1-provider-smoke.mjs .
```

Tham số cuối `.` là thư mục gốc dự án. Mã thoát 0 và dòng `FAILED: 0` là đạt; test lỗi sẽ in `✗ <tên kiểm tra>` và thoát mã 1.

### Lưu ý

- Truyền `.` hoặc đường dẫn có ổ đĩa **viết hoa** (`D:\...`). Ổ đĩa viết thường (`d:\...`) khiến Vite SSR nạp 2 bản React và
  smoke báo "Invalid hook call".
- **Không hardcode cấu hình Cloudinary trong test.** Kiểm tra "không hardcode cloud name/preset" của `h2-smoke.mjs` và
  `h3a-smoke.mjs` luôn kiểm theo cấu trúc (không URL Cloudinary nào trong `src/` mang cloud name viết thẳng). Muốn so thêm
  với giá trị thật của nhóm, đặt biến môi trường trước khi chạy (giá trị chỉ nằm trong phiên shell, không ghi vào file):

  ```powershell
  $env:SMOKE_REAL_CLOUD_NAME = '<cloud name của nhóm>'
  $env:SMOKE_REAL_UPLOAD_PRESET = '<unsigned preset của nhóm>'
  ```

  Khi chưa đặt, script in một dòng `NOTE:` nói rõ mới chỉ kiểm theo cấu trúc.
- `h4a-smoke.mjs` đọc `tests/manual/cloudinaryCheck.js` để xác nhận trang kiểm thử không tự upload; đừng đổi tên file này
  mà không sửa script.
