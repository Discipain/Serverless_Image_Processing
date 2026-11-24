import { useContext } from 'react';
import { GalleryServicesContext } from '../contexts/GalleryServicesContext';
import { GALLERY_ENV, resolveMissingProviderServices } from '../../application/galleryMode';

/**
 * Nguồn dữ liệu Gallery.
 *  - Có Provider: dùng đúng giá trị Provider cung cấp (MOCK / REAL / invalid) — không đọc cấu hình, không gây request.
 *  - THIẾU Provider (composition root không chạy): suy ra từ VITE_GALLERY_MODE bằng CÙNG hàm diễn giải với composition root
 *    (application/galleryMode.js). Đây là chỗ DUY NHẤT của Presentation đọc cấu hình, chỉ trong nhánh thiếu Provider:
 *    MOCK => cảnh báo rõ; REAL hoặc giá trị lạ => lỗi cấu hình, KHÔNG MOCK. Không tạo Provider/dịch vụ mới, không gọi mạng.
 */
export function useGalleryServices() {
  const services = useContext(GalleryServicesContext);
  if (services !== null) return services;
  return resolveMissingProviderServices(import.meta.env?.[GALLERY_ENV.mode]);
}
