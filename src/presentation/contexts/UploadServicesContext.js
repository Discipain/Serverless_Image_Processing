import { createContext } from 'react';

/**
 * Dịch vụ upload do composition root (src/app/createUploadServices.js, gọi ở src/main.jsx) truyền vào:
 * {
 *   mode: 'mock', isMock: true,
 *   notice: string | null,                         // nhắc khi .env.local chọn Backend thật nhưng trang vẫn dùng MOCK
 *   uploadImage: (args) => Promise<outcome>,       // use case uploadImageHybrid
 *   scenarios: [{ value, label }],                 // kịch bản MOCK có thể chọn qua ?mock=
 *   scenario: { get(), set(value) },
 * }
 * Presentation chỉ dùng các use case này, không import adapter hay Firebase.
 */
export const UploadServicesContext = createContext(null);
