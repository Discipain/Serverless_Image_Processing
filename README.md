# Serverless_Image_Processing
Đồ án Điện toán đám mây — Hệ thống xử lý ảnh tự động bằng Firebase (Storage + Functions + Firestore + Auth).
## Hướng dẫn cài đặt & Deploy (Bản 0 đồng)

1. Tạo file `.env` ở thư mục gốc và điền `firebaseConfig` + `VITE_CLOUDINARY_CLOUD_NAME` + `VITE_CLOUDINARY_UPLOAD_PRESET`.
2. Cài thư viện và chạy local:
   ```bash
   npm install
   npm run dev
   ```
3. Build và deploy lên Firebase Hosting + Firestore:
   ```bash
   npm run build
   firebase deploy --only hosting,firestore
   ```