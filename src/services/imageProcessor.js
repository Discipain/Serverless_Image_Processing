import imageCompression from 'browser-image-compression';

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

// 1. Kiểm tra file hợp lệ & lấy kích thước thật của ảnh
function validateAndGetDimensions(file) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return reject(new Error('Chỉ hỗ trợ ảnh JPG, PNG hoặc WebP'));
    }
    if (file.size > MAX_SIZE_BYTES) {
      return reject(new Error('Ảnh vượt quá dung lượng tối đa 10MB'));
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('File ảnh bị hỏng hoặc không đọc được'));
    };
    img.src = url;
  });
}

// 2. Hàm chính: Nén 1 ảnh ra 4 phiên bản + đo thông số
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
  const savedPercent = Math.round(((file.size - webp.size) / file.size) * 100);

  return {
    blobs: {
      original: file,
      thumbnail,
      medium,
      webp,
    },
    metrics: {
      originalSize: file.size,
      processedSize,
      webpSize: webp.size,
      savedPercent,
      processingMs,
      width: dimensions.width,
      height: dimensions.height,
    },
  };
}

// 3. Hàm xử lý hàng loạt (giới hạn 2 ảnh chạy cùng lúc tránh tràn RAM)
export async function processBatchQueue(files, onEachDone, onEachError, concurrency = 2) {
  const queue = [...files];
  const workers = Array.from({ length: concurrency }, async () => {
    while (queue.length > 0) {
      const file = queue.shift();
      try {
        const result = await processImageClient(file);
        await onEachDone(file, result);
      } catch (error) {
        onEachError(file, error.message);
      }
    }
  });
  await Promise.all(workers);
}

// 4. Hàm thử lại khi bị lỗi (Retry)
export async function retryClient(imageId, cachedFile, storageOriginalUrl) {
  let targetFile = cachedFile;
  if (!targetFile && storageOriginalUrl) {
    const res = await fetch(storageOriginalUrl);
    const blob = await res.blob();
    targetFile = new File([blob], `${imageId}.jpg`, { type: blob.type });
  }
  if (!targetFile) {
    throw new Error('Không tìm thấy file gốc để thử lại, vui lòng chọn lại ảnh.');
  }
  return await processImageClient(targetFile);
}
