// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Chi tiết một ảnh: GET /images/{imageId} qua port `backendApi`. Backend kiểm tra ownerId == uid (403 nếu sai).
// `expectedOwnerId`: kiểm tra phòng thủ thêm ở client (xem listGalleryImages.js).

import { AppError, ERROR_CODE } from '../errors';
import { assertOwnedBy } from './listGalleryImages';

export function createGetGalleryImage({ backendApi }) {
  return async function getGalleryImage({ imageId, expectedOwnerId, signal } = {}) {
    if (typeof imageId !== 'string' || imageId === '') {
      throw new AppError(ERROR_CODE.VALIDATION, 'Thiếu imageId để xem chi tiết ảnh.');
    }
    const image = await backendApi.getImage(imageId, { signal });
    assertOwnedBy([image], expectedOwnerId);
    return image;
  };
}
