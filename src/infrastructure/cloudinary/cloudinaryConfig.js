// INFRASTRUCTURE — đọc cấu hình Cloudinary từ biến môi trường VITE_CLOUDINARY_*.
//
// Chỉ có HAI giá trị PUBLIC được phép ở Frontend: cloud name và tên unsigned upload preset.
// TUYỆT ĐỐI không đặt API key/secret hay chữ ký ở đây (nhóm đã chốt unsigned upload; secret chỉ ở Backend).
// Không hardcode giá trị vào source: nguồn duy nhất là .env.local (xem .env.example).
// Hàm này chỉ trả về TÊN biến còn thiếu, không bao giờ ghi log giá trị.

export const CLOUDINARY_ENV = Object.freeze({
  cloudName: 'VITE_CLOUDINARY_CLOUD_NAME',
  uploadPreset: 'VITE_CLOUDINARY_UPLOAD_PRESET',
});

const clean = (value) => (typeof value === 'string' ? value.trim() : '');

/**
 * @param {Record<string, unknown>} [source]  mặc định import.meta.env (tham số để kiểm thử)
 * @returns {{cloudName: string, uploadPreset: string, missing: string[]}}
 */
export function readCloudinaryConfig(source = import.meta.env) {
  const cloudName = clean(source?.[CLOUDINARY_ENV.cloudName]);
  const uploadPreset = clean(source?.[CLOUDINARY_ENV.uploadPreset]);
  const missing = [];
  if (!cloudName) missing.push(CLOUDINARY_ENV.cloudName);
  if (!uploadPreset) missing.push(CLOUDINARY_ENV.uploadPreset);
  return { cloudName, uploadPreset, missing };
}
