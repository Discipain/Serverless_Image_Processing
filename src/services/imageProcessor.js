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
  if (!storage) {
    throw new Error('Firebase Storage chưa được khởi tạo (chờ firebaseConfig)');
  }
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
    paths,
    urls: {
      original: originalUrl,
      thumbnail: thumbnailUrl,
      medium: mediumUrl,
      webp: webpUrl,
    },
  };
}

export async function processAndUploadImage(uid, imageId, file) {
  if (!db) {
    throw new Error('Firestore chưa được khởi tạo (chờ firebaseConfig)');
  }
  const docRef = doc(db, 'images', imageId);

  try {
    const processed = await processImageClient(file);
    const { paths, urls } = await uploadAllVariantsToStorage(
      uid,
      imageId,
      file.name,
      processed.blobs
    );

    await updateDoc(docRef, {
      status: 'DONE',
      originalPath: paths.original, // Lưu rõ đường dẫn file gốc trong uploads/{uid}/{imageId}/
      original: processed.original,
      variants: urls,
      processedSize: processed.processedSize,
      processingMs: processed.processingMs,
      savedPercent: processed.savedPercent,
      errorReason: null,
      updatedAt: serverTimestamp(),
    });

    return { status: 'DONE', variants: urls, processingMs: processed.processingMs };
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

// Đã sửa: Đọc đúng file gốc từ uploads/{uid}/{imageId}/{fileName} thay vì variants.original
export async function retryClient(imageId, cachedFile = null) {
  if (!db || !storage) {
    throw new Error('Firebase chưa được khởi tạo (chờ firebaseConfig)');
  }
  const docRef = doc(db, 'images', imageId);
  const snap = await getDoc(docRef);

  if (!snap.exists()) {
    throw new Error('Không tìm thấy bản ghi ảnh trên hệ thống');
  }

  const data = snap.data();
  const uid = data.ownerId || data.userId;
  const fileName = data.fileName;

  if (!uid || !fileName) {
    throw new Error('Thiếu thông tin uid hoặc fileName để xác định đường dẫn uploads/');
  }

  let targetFile = cachedFile;

  // Nếu mất cachedFile trên RAM, lấy trực tiếp từ đường dẫn gốc uploads/{uid}/{imageId}/{fileName}
  if (!targetFile) {
    const rawOriginalPath = data.originalPath || `uploads/${uid}/${imageId}/${fileName}`;
    const originalRef = ref(storage, rawOriginalPath);
    const rawDownloadUrl = await getDownloadURL(originalRef);

    const response = await fetch(rawDownloadUrl);
    if (!response.ok) {
      throw new Error(`Không thể tải lại ảnh gốc tại ${rawOriginalPath}`);
    }
    const blob = await response.blob();
    targetFile = new File([blob], fileName, { type: blob.type || 'image/jpeg' });
  }

  return await processAndUploadImage(uid, imageId, targetFile);
}
