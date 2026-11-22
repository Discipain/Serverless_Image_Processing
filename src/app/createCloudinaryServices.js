// COMPOSITION ROOT (H2) — ghép use case upload Cloudinary với adapter Cloudinary (unsigned upload).
//
// Chỉ cung cấp bộ upload; CHƯA được nối vào UI Upload thật (H4) và không gọi Backend/Firestore.
// Thiếu cấu hình KHÔNG làm sập ứng dụng: `configError` có nội dung và upload sẽ báo lỗi CONFIG rõ ràng.

import { createCloudinaryUploader } from '../infrastructure/cloudinary/cloudinaryUploader';
import { readCloudinaryConfig } from '../infrastructure/cloudinary/cloudinaryConfig';
import { createUploadVariantsToCloudinary } from '../application/usecases/uploadVariantsToCloudinary';

/**
 * @param {Object} [options]  (để kiểm thử; ứng dụng gọi không đối số)
 * @param {{cloudName: string, uploadPreset: string, missing: string[]}} [options.config]
 * @param {Object} [options.uploaderOptions]  tuỳ chọn thêm cho uploader (vd timeoutMs, createXhr khi kiểm thử)
 */
export function createCloudinaryServices({ config = readCloudinaryConfig(), uploaderOptions = {} } = {}) {
  const cloudinaryUploader = createCloudinaryUploader({
    cloudName: config.cloudName,
    uploadPreset: config.uploadPreset,
    ...uploaderOptions,
  });
  return Object.freeze({
    configured: config.missing.length === 0,
    missing: [...config.missing],
    useCases: Object.freeze({
      uploadVariantsToCloudinary: createUploadVariantsToCloudinary({ cloudinaryUploader }),
    }),
  });
}
