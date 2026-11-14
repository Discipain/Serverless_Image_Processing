import imageCompression from 'browser-image-compression';
import { ref, uploadBytes, getDownloadURL } from 'firebase/storage';
import { doc, getDoc, updateDoc, serverTimestamp } from 'firebase/firestore';
import { storage, db } from '../firebase';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

function validateAndGetDimensions(file) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return reject(new Error('Định dạng không hỗ trợ (chỉ nhận JPG, PNG, WebP)'));
    }
    if (file.size > MAX_SIZE_BYTES) {
      return reject(new Error('Dung lượng ảnh vượt quá giới hạn 10MB'));
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('File ảnh bị hỏng hoặc không đọc được dữ liệu'));
    };
    img.src = url;
  });
}

export function buildStoragePaths(uid, imageId, originalFileName) {
  return {
    original: `uploads/${uid}/${imageId}/${originalFileName}`,
    thumbnail: `processed/${uid}/${imageId}/thumb.webp`,
    medium: `processed/${uid}/${imageId}/medium.webp`,
    webp: `processed/${uid}/${imageId}/full.webp`,
  };
}

export async function processImageClient(file) {
  const startTime = performance.now();
  const dimensions = await validateAndGetDimensions(file);

  const [thumbnail, medium, webp] = await Promise.all([
    imageCompression(file, {
      maxWidthOrHeight: 200,
      fileType: 'image/webp',
      initialQuality: 0.75,
      useWebWorker: true,
    }),
    imageCompression(file, {
      maxWidthOrHeight: 800,
      fileType: 'image/webp',
      initialQuality: 0.8,
      useWebWorker: true,
    }),
    imageCompression(file, {
      maxWidthOrHeight: 4096,
      fileType: 'image/webp',
      initialQuality: 0.85,
      useWebWorker: true,
    }),
  ]);

  const processingMs = Math.round(performance.now() - startTime);
  const processedSize = thumbnail.size + medium.size + webp.size;
  const savedPercent = Number((((file.size - webp.size) / file.size) * 100).toFixed(1));

  return {
    blobs: {
      original: file,
      thumbnail,
      medium,
      webp,
    },
    original: {
      size: file.size,
      width: dimensions.width,
      height: dimensions.height,
    },
    processedSize,
    processingMs,
    savedPercent,
  };
}

async function uploadAllVariantsToStorage(uid, imageId, fileName, blobs) {
  const paths = buildStoragePaths(uid, imageId, fileName);

  const uploadOne = async (storagePath, blob, contentType) => {
    const fileRef = ref(storage, storagePath);
    await uploadBytes(fileRef, blob, { contentType });
    return await getDownloadURL(fileRef);
  };

  const [originalUrl, thumbnailUrl, mediumUrl, webpUrl] = await Promise.all([
    uploadOne(paths.original, blobs.original, blobs.original.type),
    uploadOne(paths.thumbnail, blobs.thumbnail, 'image/webp'),
    uploadOne(paths.medium, blobs.medium, 'image/webp'),
    uploadOne(paths.webp, blobs.webp, 'image/webp'),
  ]);

  return {
    original: originalUrl,
    thumbnail: thumbnailUrl,
    medium: mediumUrl,
    webp: webpUrl,
  };
}

export async function processAndUploadImage(uid, imageId, file) {
  const docRef = doc(db, 'images', imageId);

  try {
    const processed = await processImageClient(file);
    const variantUrls = await uploadAllVariantsToStorage(
      uid,
      imageId,
      file.name,
      processed.blobs
    );

    await updateDoc(docRef, {
      status: 'DONE',
      original: processed.original,
      variants: variantUrls,
      processedSize: processed.processedSize,
      processingMs: processed.processingMs,
      savedPercent: processed.savedPercent,
      errorReason: null,
      updatedAt: serverTimestamp(),
    });

    return { status: 'DONE', variants: variantUrls, processingMs: processed.processingMs };
  } catch (error) {
    await updateDoc(docRef, {
      status: 'FAILED',
      errorReason: error.message || 'Lỗi xử lý hoặc tải ảnh lên',
      updatedAt: serverTimestamp(),
    });
    throw error;
  }
}

export async function processBatchQueue(items, onItemDone, onItemError, concurrency = 2) {
  const queue = [...items];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const item = queue.shift();
      try {
        const res = await processAndUploadImage(item.uid, item.imageId, item.file);
        if (onItemDone) onItemDone(item.imageId, res);
      } catch (error) {
        if (onItemError) onItemError(item.imageId, error.message);
      }
    }
  });
  await Promise.all(workers);
}

export async function retryClient(imageId, cachedFile = null) {
  const docRef = doc(db, 'images', imageId);
  const snap = await getDoc(docRef);

  if (!snap.exists()) {
    throw new Error('Không tìm thấy bản ghi ảnh trên hệ thống');
  }

  const data = snap.data();
  const uid = data.ownerId || data.userId;
  const fileName = data.fileName || `${imageId}.jpg`;
  let targetFile = cachedFile;

  if (!targetFile && data.variants?.original) {
    const response = await fetch(data.variants.original);
    if (!response.ok) {
      throw new Error('Không thể tải lại ảnh gốc từ Storage');
    }
    const blob = await response.blob();
    targetFile = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
  }

  if (!targetFile) {
    throw new Error('Không còn dữ liệu ảnh gốc để thử lại, vui lòng tải lên ảnh mới.');
  }

  return await processAndUploadImage(uid, imageId, targetFile);
}
