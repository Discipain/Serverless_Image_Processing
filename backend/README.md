# Backend FastAPI (Hybrid: Cloudinary + Firebase)

Backend xác thực **Firebase ID token** (`Authorization: Bearer <token>`), nhận `POST /images/cloudinary/confirm` theo
`CONTRACT.md` ở thư mục gốc và lưu metadata vào Firestore. Hợp đồng API nằm ở `CONTRACT.md` (không sửa ở đây).

## Yêu cầu
- **Python 3.12** (các phiên bản trong `requirements.txt` được ghim và không cài được trên Python 3.14).
- Không cần credential để chạy test. **Không dùng lại khóa/token cũ của nhóm** (đã lộ, phải rotate).

## Cài đặt
```powershell
cd backend
python3.12 -m venv .venv          # hoặc dùng bất kỳ cách tạo venv Python 3.12 nào
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
```

## Chạy test (không gọi Firebase, Firestore, Cloudinary hay Google Drive thật)
```powershell
python -m pytest tests
```
Test dùng token giả, kho RAM và Firestore giả; không có kết nối ra ngoài.

## Chạy cục bộ
```powershell
copy .env.example .env            # .env bị .gitignore chặn; để IMAGE_STORE=memory khi chưa có Firestore
uvicorn app.main:app --reload --port 8000
```
Kiểm tra: `GET http://localhost:8000/health`. Mọi API ảnh yêu cầu header Bearer của Firebase.

### Xác thực Firebase cần credential hợp lệ
Với cấu hình hiện tại, `firebase-admin` dựng client xác thực bằng `google.auth.default()` (Application Default
Credentials), nên **cần credential hợp lệ để verify token thật**, kể cả khi `IMAGE_STORE=memory`.
- **Chạy cục bộ:** đặt biến môi trường `GOOGLE_APPLICATION_CREDENTIALS` trỏ tới file service-account **mới, nằm ngoài
  repo**, do người quản lý cấp (hoặc `FIREBASE_CREDENTIALS_FILE` trỏ tới file cũng nằm ngoài repo).
- **Trên Google Cloud:** ADC có thể do môi trường cung cấp, không cần file.
- **Không dùng** service-account hoặc token đã bị lộ trên GitHub.
- Test tự động **không cần** credential (dùng token giả và không truy cập mạng).

Cách Backend phân biệt lỗi:
| Mã | Khi nào |
|---|---|
| `401 {"detail":"Missing token"}` | Thiếu/sai định dạng `Authorization: Bearer`, token sai, hết hạn hoặc bị thu hồi |
| `503 {"detail":"Authentication service unavailable"}` | Backend không xác thực được: thiếu ADC (`DefaultCredentialsError`), không tải được chứng chỉ Google, hoặc lỗi cấu hình Firebase Admin (thiếu `FIREBASE_PROJECT_ID`, file credentials hỏng) |

Response 503 không chứa chi tiết nội bộ; log chỉ ghi **tên loại lỗi** (không ghi token, thông điệp hay đường dẫn).
Nếu mọi request đều 503, kiểm tra credential của Backend trước, không phải token của người dùng.

## Cấu hình và bí mật
- Cấu hình đọc từ biến môi trường hoặc `backend/.env` (xem `.env.example`, chỉ có tên biến).
- **Không** đặt service-account, OAuth client secret, token hay Cloudinary secret trong repo. Đặt file ngoài repo và trỏ bằng biến môi trường.
- `IMAGE_STORE=firestore` là mặc định: Firestore lỗi thì API trả `503 Storage unavailable` (không tự lưu vào RAM).

## Lưu ý bảo mật đã biết
- Cloudinary **unsigned upload không chứng minh được ai đã upload**. Confirm chỉ chặn một asset (`public_id`) bị đăng ký cho nhiều ảnh/chủ ("ai đến trước giữ"); chưa có signed upload và chưa có `DELETE`.
- Preview Google Drive yêu cầu Bearer; thẻ `<img src>` không gửi được header nên cần `fetch` kèm token rồi tạo blob URL.
- `app/services/cloudinary_service.py` hiện không được route nào gọi (giữ nguyên bản gốc).
