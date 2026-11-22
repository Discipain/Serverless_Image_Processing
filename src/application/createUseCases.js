// APPLICATION — không import React, Firebase hay lớp Presentation/Infrastructure.
//
// Ghép các adapter (Dependency Injection đơn giản) thành các use case.
// Nơi gọi hàm này (composition root ở Bước F) quyết định dùng adapter MOCK hay Firebase.
// Hợp đồng của từng adapter: xem ./ports.js.

import { createUploadPipeline } from './uploadPipeline';
import {
  createGetIdToken,
  createLoginWithGoogle,
  createLogout,
  createObserveAuthState,
} from './usecases/auth';
import { createUploadImage } from './usecases/uploadImage';
import { createRetryImage } from './usecases/retryImage';
import { createDeleteImage } from './usecases/deleteImage';
import { createListUserImages } from './usecases/listUserImages';
import { createSubscribeToImages } from './usecases/subscribeToImages';
import { createGetImageUrl } from './usecases/getImageUrl';

const REQUIRED_PORTS = {
  authRepository: ['signInWithGoogle', 'signOut', 'onAuthChanged', 'getIdToken'],
  imageRepository: ['create', 'get', 'list', 'subscribe', 'transition', 'remove'],
  storageRepository: ['upload', 'getDownloadUrl', 'download', 'remove'],
  imageProcessor: ['process'],
};

// Báo lỗi sớm và rõ khi adapter thiếu hàm (thay vì lỗi khó hiểu giữa chừng một lần upload).
function assertAdapters(adapters) {
  const problems = [];
  for (const [name, methods] of Object.entries(REQUIRED_PORTS)) {
    const adapter = adapters?.[name];
    if (!adapter) {
      problems.push(`thiếu ${name}`);
      continue;
    }
    for (const method of methods) {
      if (typeof adapter[method] !== 'function') problems.push(`${name}.${method} không phải hàm`);
    }
  }
  if (typeof adapters?.generateId !== 'function') problems.push('generateId không phải hàm');
  if (problems.length > 0) {
    throw new Error(`createUseCases: adapter không hợp lệ — ${problems.join('; ')}.`);
  }
}

export function createUseCases(adapters) {
  assertAdapters(adapters);
  const { authRepository, imageRepository, storageRepository, imageProcessor, generateId } = adapters;

  const pipeline = createUploadPipeline({ imageRepository, storageRepository, imageProcessor });

  return Object.freeze({
    loginWithGoogle: createLoginWithGoogle({ authRepository }),
    logout: createLogout({ authRepository }),
    observeAuthState: createObserveAuthState({ authRepository }),
    getIdToken: createGetIdToken({ authRepository }),
    uploadImage: createUploadImage({ imageRepository, generateId, pipeline }),
    retryImage: createRetryImage({ imageRepository, storageRepository, pipeline }),
    deleteImage: createDeleteImage({ imageRepository, storageRepository }),
    listUserImages: createListUserImages({ imageRepository }),
    subscribeToImages: createSubscribeToImages({ imageRepository }),
    getImageUrl: createGetImageUrl({ storageRepository }),
  });
}
