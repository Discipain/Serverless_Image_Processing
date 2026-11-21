import imageCompression from 'browser-image-compression';

const CLOUD_NAME = import.meta.env.VITE_CLOUDINARY_CLOUD_NAME || 'zftcbu1g';
const UPLOAD_PRESET = import.meta.env.VITE_CLOUDINARY_UPLOAD_PRESET || 'serverless_image_preset';
const CLOUDINARY_UPLOAD_URL = `https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`;

const ALLOWED_TYPES = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_SIZE_BYTES = 10 * 1024 * 1024; // 10MB

export function validateAndGetDimensions(file) {
  return new Promise((resolve, reject) => {
    if (!ALLOWED_TYPES.includes(file.type)) {
      return reject(new Error('Invalid file type'));
    }
    if (file.size > MAX_SIZE_BYTES) {
      return reject(new Error('File too large'));
    }

    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => {
      URL.revokeObjectURL(url);
      resolve({ width: img.naturalWidth, height: img.naturalHeight });
    };
    img.onerror = () => {
      URL.revokeObjectURL(url);
      reject(new Error('Invalid image file'));
    };
    img.src = url;
  });
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
    blobs: { thumbnail, medium, webp },
    original: { size: file.size, width: dimensions.width, height: dimensions.height },
    processedSize,
    processingMs,
    savedPercent,
  };
}

async function uploadBlobToCloudinary(blob, folder, publicId) {
  const formData = new FormData();
  formData.append('file', blob);
  formData.append('upload_preset', UPLOAD_PRESET);
  if (folder) formData.append('folder', folder);
  if (publicId) formData.append('public_id', publicId);

  const res = await fetch(CLOUDINARY_UPLOAD_URL, {
    method: 'POST',
    body: formData,
  });

  if (!res.ok) {
    const errData = await res.json().catch(() => ({}));
    throw new Error(errData.error?.message || 'Cloudinary upload failed');
  }

  const data = await res.json();
  return data.secure_url;
}

export async function processAndUploadCloudinary(uid, imageId, file) {
  const processed = await processImageClient(file);
  const folder = `processed/${uid}/${imageId}`;

  const [thumbnailUrl, mediumUrl, webpUrl] = await Promise.all([
    uploadBlobToCloudinary(processed.blobs.thumbnail, folder, 'thumb'),
    uploadBlobToCloudinary(processed.blobs.medium, folder, 'medium'),
    uploadBlobToCloudinary(processed.blobs.webp, folder, 'full'),
  ]);

  return {
    imageId,
    fileName: file.name,
    contentType: file.type,
    thumbnail: thumbnailUrl,
    medium: mediumUrl,
    webp: webpUrl,
    originalSize: processed.original.size,
    processedSize: processed.processedSize,
    processingMs: processed.processingMs,
    width: processed.original.width,
    height: processed.original.height,
    savedPercent: processed.savedPercent,
  };
}

export async function retryClient(uid, imageId, file) {
  if (!file) {
    throw new Error('Vui lòng chọn lại file ảnh gốc để nén và tải lên lại');
  }
  return await processAndUploadCloudinary(uid, imageId, file);
}
