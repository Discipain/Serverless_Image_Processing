// DEV ONLY — trang kiểm thử thủ công cho H2 (tests/manual/cloudinary-check.html). Không được import từ ứng dụng chính.
//
// Quy trình an toàn: chọn ảnh -> nén (chỉ trong trình duyệt, chưa gửi gì) -> tick xác nhận -> bấm "Upload thật".
// Không tự upload. Không gọi Backend/Firestore. Không xóa gì trên Cloudinary. Chỉ ghi ra trang bằng textContent.

import { createCloudinaryServices } from '../../src/app/createCloudinaryServices';
import { browserImageProcessor } from '../../src/infrastructure/image-processing/browserImageProcessor';
import { formatBytes } from '../../src/presentation/utils/format';

const $ = (id) => document.getElementById(id);
const logEl = $('log');
const services = createCloudinaryServices();

let processed = null; // { blobs, width, height, processingMs }
let controller = null;

function log(text, isError = false) {
  const line = document.createElement('div');
  line.textContent = text;
  if (isError) line.className = 'err';
  logEl.appendChild(line);
}

function refreshButtons() {
  $('upload').disabled = !(processed && $('confirm').checked && services.configured && !controller);
  $('cancel').disabled = !controller;
}

$('config').textContent = services.configured
  ? 'đủ VITE_CLOUDINARY_CLOUD_NAME và VITE_CLOUDINARY_UPLOAD_PRESET'
  : `THIẾU: ${services.missing.join(', ')} (điền trong .env.local rồi chạy lại npm run dev)`;

$('file').addEventListener('change', () => {
  processed = null;
  $('compress').disabled = !$('file').files?.[0];
  refreshButtons();
});
$('confirm').addEventListener('change', refreshButtons);

$('compress').addEventListener('click', async () => {
  const file = $('file').files?.[0];
  if (!file) return;
  logEl.textContent = '';
  processed = null;
  refreshButtons();
  try {
    log(`Đang nén ${file.name} (${formatBytes(file.size)})…`);
    processed = await browserImageProcessor.process(file);
    for (const [key, blob] of Object.entries(processed.blobs)) {
      log(`- ${key}: ${formatBytes(blob.size)} (${blob.type})`);
    }
    log(`Ảnh gốc ${processed.width}×${processed.height}, nén ${processed.processingMs} ms. CHƯA upload gì.`);
  } catch (error) {
    log(`Nén thất bại: ${error.message}`, true);
  }
  refreshButtons();
});

$('upload').addEventListener('click', async () => {
  if (!processed || !$('confirm').checked || controller) return;
  controller = new AbortController();
  refreshButtons();
  log('Bắt đầu upload thật…');
  try {
    const result = await services.useCases.uploadVariantsToCloudinary({
      blobs: processed.blobs,
      signal: controller.signal,
      onProgress: ({ variant, variantPercent, overallPercent }) => {
        log(`  ${variant}: ${variantPercent}% (tổng ${overallPercent}%)`);
      },
    });
    log('XONG (chưa xác nhận với Backend, chưa ghi Firestore):');
    for (const [key, a] of Object.entries(result)) {
      log(`- ${key}: ${a.secureUrl} | public_id=${a.publicId} | ${a.format} ${a.bytes}B ${a.width}×${a.height} | resource_type=${a.resourceType}`);
    }
  } catch (error) {
    log(`THẤT BẠI [${error.code}/${error.details?.kind ?? '-'}]: ${error.message}`, true);
    const d = error.details ?? {};
    if (d.partial) {
      log(`Ảnh mồ côi cần xử lý sau (KHÔNG tự xóa): public_id = ${d.orphanedPublicIds.join(', ')}`, true);
    }
  } finally {
    controller = null;
    refreshButtons();
  }
});

$('cancel').addEventListener('click', () => controller?.abort());
refreshButtons();
