import { useContext } from 'react';
import { UploadServicesContext } from '../contexts/UploadServicesContext';
import { UPLOAD_ENV, resolveMissingUploadProvider } from '../../application/uploadMode';

/**
 * Dịch vụ upload.
 *  - Có Provider: dùng đúng giá trị Provider cung cấp (MOCK / REAL / invalid) — không đọc cấu hình, không gây request.
 *  - THIẾU Provider (composition root không chạy): suy ra từ VITE_UPLOAD_MODE bằng CÙNG hàm diễn giải với composition root
 *    (application/uploadMode.js). Đây là chỗ DUY NHẤT của luồng Upload trong Presentation đọc cấu hình, chỉ trong nhánh thiếu Provider:
 *    MOCK => cảnh báo rõ (chưa có luồng để chạy); REAL hoặc giá trị lạ => lỗi cấu hình, KHÔNG MOCK, KHÔNG upload không ký.
 *    Không tạo dịch vụ mới, không gọi mạng. (Trước H4B-5: ném lỗi khi thiếu Provider.)
 */
export function useUploadServices() {
  const services = useContext(UploadServicesContext);
  if (services) return services;
  return resolveMissingUploadProvider(import.meta.env?.[UPLOAD_ENV.mode]);
}
