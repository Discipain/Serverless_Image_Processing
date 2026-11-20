// ============================================================
// DỮ LIỆU MOCK — KHÔNG PHẢI DỮ LIỆU THẬT TỪ FIRESTORE.
// Mô phỏng document trong collection `images` theo SCHEMA.md (bản client-side).
// Không có file ảnh thật: `variants` chỉ là đường dẫn Storage giả.
// ============================================================

import { IMAGE_STATUS } from '../../constants/image';

export const MOCK_USER = {
  uid: 'mock-uid-001',
  displayName: 'Người dùng MOCK',
  email: 'mock.user@example.com',
};

// Một user khác — dùng để kiểm tra gallery chỉ hiển thị ảnh của đúng ownerId.
const OTHER_OWNER_ID = 'mock-uid-999';

const SAMPLE_NAMES = [
  'anh-bien.jpg',
  'hoang-hon.png',
  'pho-co.webp',
  'nui-rung.jpg',
  'cafe-sang.jpg',
  'meo-con.png',
];

const BASE_TIME = new Date('2026-11-16T09:00:00+07:00').getTime();

function buildMockImage(index, ownerId) {
  // UUID giả có định dạng v4 để giống imageId thật.
  const imageId = `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`;
  const fileName = SAMPLE_NAMES[index % SAMPLE_NAMES.length];
  const createdAt = new Date(BASE_TIME - index * 37 * 60 * 1000);
  const originalSize = 400_000 + ((index * 731_993) % 7_600_000);

  let status = IMAGE_STATUS.DONE;
  if (index % 7 === 3) status = IMAGE_STATUS.FAILED;
  else if (index % 5 === 1) status = IMAGE_STATUS.PENDING;

  const doc = {
    imageId,
    ownerId,
    status,
    originalPath: `uploads/${ownerId}/${imageId}/${fileName}`,
    originalSize,
    retryCount: status === IMAGE_STATUS.FAILED ? 1 : 0,
    createdAt,
    updatedAt: createdAt,
  };

  if (status === IMAGE_STATUS.DONE) {
    Object.assign(doc, {
      variants: {
        thumbnail: `processed/${ownerId}/${imageId}/thumb.webp`,
        medium: `processed/${ownerId}/${imageId}/medium.webp`,
        webp: `processed/${ownerId}/${imageId}/full.webp`,
      },
      processedSize: Math.round(originalSize * (0.12 + (index % 4) * 0.06)),
      originalWidth: 4000,
      originalHeight: 3000,
      processingMs: 900 + ((index * 389) % 4200),
    });
  }

  if (status === IMAGE_STATUS.FAILED) {
    doc.errorReason = index % 2 === 0 ? 'COMPRESS_FAIL' : 'INVALID_IMAGE';
  }

  return doc;
}

export const MOCK_IMAGES = [
  ...Array.from({ length: 25 }, (_, i) => buildMockImage(i, MOCK_USER.uid)),
  ...Array.from({ length: 3 }, (_, i) => buildMockImage(100 + i, OTHER_OWNER_ID)),
];
