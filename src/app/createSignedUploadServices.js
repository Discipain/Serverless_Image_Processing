// COMPOSITION ROOT (H4B-4) — ghép luồng upload CÓ CHỮ KÝ:
//
//   Validate -> imageId -> Nén 3 WebP -> Authorize (Backend) -> Upload có chữ ký (Cloudinary) -> Confirm (Backend) -> DONE.
//
// CHƯA ĐƯỢC NỐI vào ứng dụng: không file nào trong src/ import file này (UploadPage vẫn dùng createUploadServices = MOCK ở H4A).
// H4B-5 mới thêm chế độ upload, feature flag, provider, gating và nhãn MOCK/REAL. File này chỉ để Signed Upload kiểm thử được qua
// Dependency Injection và là nơi H4B-5 sẽ nối.
//
// KHÔNG fallback: cấu hình sai (Backend không ở chế độ real, thiếu/sai cloud name) => `uploadImage` báo lỗi CONFIG rõ ràng,
// KHÔNG chuyển sang unsigned preset, KHÔNG chuyển sang MOCK, KHÔNG gọi mạng.
// File này KHÔNG đọc import.meta.env, KHÔNG nhận upload preset, KHÔNG có secret. Chữ ký do Backend cấp; cloud name là giá trị PUBLIC.

import { createUploadImageSigned } from '../application/usecases/uploadImageSigned';
import { createAuthorizeCloudinaryUpload } from '../application/usecases/authorizeCloudinaryUpload';
import { createUploadVariantsSigned } from '../application/usecases/uploadVariantsSigned';
import { createConfirmCloudinaryUpload } from '../application/usecases/confirmCloudinaryUpload';
import { createGuardedSignedUpload } from '../application/usecases/guardedSignedUpload';
import { AppError, ERROR_CODE } from '../application/errors';
import { BACKEND_MODE } from '../infrastructure/api/backendConfig';
import { createBackendClient } from '../infrastructure/api/backendClient';
import { createSignedCloudinaryUploader } from '../infrastructure/cloudinary/signedCloudinaryUploader';
import { CLOUD_NAME_PATTERN } from '../domain/models/uploadAuthorization';
import { browserImageProcessor } from '../infrastructure/image-processing/browserImageProcessor';
import { generateId as defaultGenerateId } from '../infrastructure/generateId';

function configProblem({ backendConfig, cloudName, hasBackendApi }) {
  if (!hasBackendApi && backendConfig?.mode !== BACKEND_MODE.REAL) {
    return (
      backendConfig?.configError?.message ??
      'Upload có chữ ký cần Backend thật (VITE_BACKEND_MODE=real và VITE_API_BASE_URL hợp lệ); sẽ không chuyển sang MOCK hay unsigned.'
    );
  }
  if (typeof cloudName !== 'string' || !CLOUD_NAME_PATTERN.test(cloudName.trim())) {
    return 'Upload có chữ ký cần VITE_CLOUDINARY_CLOUD_NAME hợp lệ (chỉ gồm chữ, số, "-" và "_").';
  }
  return null;
}

/**
 * @param {Object} options
 * @param {{mode: string, baseUrl: string|null, configError: object|null}} options.backendConfig  kết quả readBackendConfig()
 * @param {string} options.cloudName  VITE_CLOUDINARY_CLOUD_NAME (PUBLIC)
 * @param {(options?: {forceRefresh?: boolean}) => Promise<string>} options.getIdToken  use case xác thực của H1
 * @param {Function} options.observeAuthState  use case xác thực của H1
 * @param {import('../application/ports.js').ImageProcessor} [options.imageProcessor]
 * @param {() => string} [options.generateId]
 * @param {typeof fetch} [options.fetchImpl]  chỉ để kiểm thử
 * @param {Object} [options.uploaderOptions]  vd { timeoutMs, createXhr, createFormData } khi kiểm thử
 * @param {() => number} [options.now]  chỉ để kiểm thử
 * @param {Object} [options.backendApi]  chỉ để kiểm thử: thay Backend client
 */
export function createSignedUploadServices({
  backendConfig,
  cloudName,
  getIdToken,
  observeAuthState,
  imageProcessor = browserImageProcessor,
  generateId = defaultGenerateId,
  fetchImpl,
  uploaderOptions = {},
  now = Date.now,
  backendApi,
} = {}) {
  if (typeof getIdToken !== 'function') throw new TypeError('createSignedUploadServices cần getIdToken (use case xác thực của H1).');
  if (typeof observeAuthState !== 'function') throw new TypeError('createSignedUploadServices cần observeAuthState (use case xác thực của H1).');

  const problem = configProblem({ backendConfig, cloudName, hasBackendApi: Boolean(backendApi) });
  if (problem) {
    return Object.freeze({
      mode: 'signed',
      isMock: false,
      configError: Object.freeze({ message: problem }),
      async uploadImage() {
        throw new AppError(ERROR_CODE.CONFIG, problem, { kind: 'CONFIG', retryable: false });
      },
    });
  }

  const cloud = cloudName.trim();
  const api = backendApi ?? createBackendClient({ baseUrl: backendConfig.baseUrl, getIdToken, fetchImpl });
  const signedUploader = createSignedCloudinaryUploader({ cloudName: cloud, ...uploaderOptions });

  const uploadImageSigned = createUploadImageSigned({
    imageProcessor,
    authorizeCloudinaryUpload: createAuthorizeCloudinaryUpload({ backendApi: api, cloudName: cloud, now }),
    uploadVariantsSigned: createUploadVariantsSigned({ signedUploader, now }),
    confirmCloudinaryUpload: createConfirmCloudinaryUpload({ backendApi: api, processedSizeBasis: 'webp' }),
    generateId,
  });

  return Object.freeze({
    mode: 'signed',
    isMock: false,
    configError: null,
    uploadImage: createGuardedSignedUpload({ uploadImageSigned, observeAuthState }),
  });
}
