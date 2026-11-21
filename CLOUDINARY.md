# Cloudinary Config (dùng chung, không commit key mật)

- Cloud Name: `zftcbu1g`
- Upload Preset (unsigned): `serverless_image_preset`
- Giới hạn preset: chỉ `jpg/png/webp`, mỗi file `≤ 10MB`
- Cách dùng: `POST https://api.cloudinary.com/v1_1/zftcbu1g/image/upload` kèm `upload_preset` + `file`
- Ai cần key mật (API secret): hỏi Hưng riêng, không đẩy lên GitHub