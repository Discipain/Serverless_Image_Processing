// ============================================================
// SERVICE MOCK — chỉ đọc mảng trong bộ nhớ, KHÔNG gọi Firebase.
// Hình dạng hàm giữ giống service Firestore sẽ viết sau, để
// component không phải sửa khi chuyển sang dữ liệu thật:
//   where ownerId == uid, orderBy createdAt desc, limit <= 20
// ============================================================

import { PAGE_SIZE } from '../../constants/image';
import { MOCK_IMAGES } from './mockImages';

const MOCK_DELAY_MS = 600;

/** Kịch bản để kiểm thử giao diện qua URL: /gallery?mock=empty | ?mock=error */
export const MOCK_SCENARIOS = {
  NORMAL: 'normal',
  EMPTY: 'empty',
  ERROR: 'error',
};

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function listImages({ ownerId, limit = PAGE_SIZE, scenario = MOCK_SCENARIOS.NORMAL }) {
  await wait(MOCK_DELAY_MS);

  if (scenario === MOCK_SCENARIOS.ERROR) {
    throw new Error('MOCK: Không tải được danh sách ảnh (lỗi giả lập).');
  }
  if (scenario === MOCK_SCENARIOS.EMPTY) {
    return { items: [], nextCursor: null };
  }

  const items = MOCK_IMAGES.filter((img) => img.ownerId === ownerId)
    .sort((a, b) => b.createdAt - a.createdAt)
    .slice(0, Math.min(limit, PAGE_SIZE));

  // nextCursor sẽ dùng cho "tải thêm khi cuộn" ở bước sau.
  return { items, nextCursor: null };
}
