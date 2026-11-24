import { createContext } from 'react';

/**
 * Nguồn dữ liệu Gallery do composition root (src/app/createGalleryServices.js, gọi ở src/main.jsx) truyền vào:
 * {
 *   mode: 'mock' | 'real' | 'invalid',
 *   isMock: boolean,                         // true chỉ khi mode === 'mock'
 *   configError: { message, missing[] } | null,   // có khi mode === 'invalid' (KHÔNG tự chuyển sang MOCK)
 *   listPage: ({ownerId, limit, cursor, signal}) => Promise<GalleryPage> | null,   // chỉ có khi mode === 'real'
 * }
 *
 * KHÔNG có Provider => giá trị context là `null`. Khi đó `useGalleryServices()` KHÔNG tự coi là MOCK mà suy ra từ VITE_GALLERY_MODE
 * (xem application/galleryMode.js): trống/"mock" -> MOCK kèm cảnh báo thiếu Provider; "real" hoặc giá trị lạ -> lỗi cấu hình, không MOCK.
 */
export const GalleryServicesContext = createContext(null);

/** Nguồn MOCK tường minh (Provider có mặt, chế độ mock): không cảnh báo thiếu Provider. */
export const DEFAULT_GALLERY_SERVICES = Object.freeze({ mode: 'mock', isMock: true, configError: null, listPage: null });
