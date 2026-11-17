## 🔌 Tài liệu tích hợp các API (API Integration Guide)

Frontend giao tiếp với Backend thông qua các endpoint chính sau:

### 1. Xác thực & Người dùng (`X-User-Id`)
Mọi request gửi lên Backend (trừ OAuth login) đều phải đính kèm Header xác thực:
- **Header Key:** `X-User-Id`
- **Giá trị:** Google UID của người dùng (được lưu tự động vào `localStorage` sau khi đăng nhập Google hoặc nhập thủ công ở ô cấu hình).

| Phương thức | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/oauth/google/login` | Lấy URL đăng nhập Google OAuth2 dạng JSON. |
| `GET` | `/oauth/google/redirect` | Chuyển hướng trình duyệt trực tiếp đến trang đăng nhập Google. |

---

### 2. Quản lý Thư mục Google Drive
| Phương thức | Endpoint | Body / Payload | Mô tả |
| :--- | :--- | :--- | :--- |
| `POST` | `/images/drive/folders` | `{"folderName": "string", "parentId": "string\|null"}` | Tạo thư mục gốc và bộ 3 thư mục pipeline (`upload`, `processing`, `processed`) trên Drive. |

---

### 3. Use Case 01: Upload ảnh & Pipeline Trạng thái
| Phương thức | Endpoint | Kiểu dữ liệu | Mô tả |
| :--- | :--- | :--- | :--- |
| `POST` | `/images/upload-url` | `JSON` | Kiểm tra file (`checkFile`: định dạng, $\le 10\text{MB}$) và cấp URL upload kèm metadata chuẩn `SCHEMA.md`. |
| `POST` | `/images/upload-drive` | `FormData` (`file`, `folderId`, `autoProcess`) | Upload file thật lên thư mục `upload/` (`status: PENDING`). Nếu `autoProcess=true`, tự động chạy background task chuyển state. |
| `POST` | `/images/{image_id}/process` | Không có | Chuyển thủ công ảnh sang thư mục `processing/` (`status: PROCESSING`). |
| `POST` | `/images/{image_id}/complete` | Không có | Render variants (`thumbnail`, `medium`, `webp`), di chuyển file sang `processed/` (`status: COMPLETED`). |

---

### 4. Use Case 03 & 04: Xem trạng thái, Thư viện & Xem trước ảnh
| Phương thức | Endpoint | Mô tả |
| :--- | :--- | :--- |
| `GET` | `/images` | **UC04:** Lấy danh sách toàn bộ ảnh thuộc sở hữu của `X-User-Id`. |
| `GET` | `/images/{image_id}` | **UC03:** Lấy chi tiết trạng thái ảnh. *(Nếu `X-User-Id` không khớp `ownerId`, Backend trả về lỗi **403 Forbidden**)*. |
| `GET` | `/images/preview/{drive_file_id}?uid=...` | Stream trực tiếp tệp ảnh từ Google Drive về thẻ `<img>` trên Frontend một cách bảo mật. |

---