// INFRASTRUCTURE / MOCK — KHÔNG gọi Firestore. Dữ liệu nằm trong bộ nhớ, mất khi tải lại trang.
// Cài port `imageRepository` (application/ports.js) để phát triển và kiểm thử.
// KHÔNG phải bằng chứng Firestore thật đã hoạt động: mock không mô phỏng Security Rules
// (ví dụ PERMISSION_DENIED) hay index; việc đó thuộc về kiểm thử với Firebase Emulator ở E4.

import { ERROR_CODE } from '../../application/errors';
import { MOCK_IMAGES } from './mockImages';

const wait = (ms) => (ms > 0 ? new Promise((resolve) => setTimeout(resolve, ms)) : Promise.resolve());
const fail = (code, message) => Object.assign(new Error(message), { code });
const timeOf = (value) => (value instanceof Date ? value.getTime() : Number(value));
const clone = (value) => structuredClone(value);

// Mới nhất trước; cùng thời điểm thì imageId lớn hơn trước (cùng thứ tự với cursor).
function compareNewestFirst(a, b) {
  const diff = timeOf(b.createdAt) - timeOf(a.createdAt);
  if (diff !== 0) return diff;
  if (a.imageId === b.imageId) return 0;
  return a.imageId < b.imageId ? 1 : -1;
}

const cursorOf = (doc) => ({ t: timeOf(doc.createdAt), id: doc.imageId });

function isAfterCursor(doc, cursor) {
  const t = timeOf(doc.createdAt);
  return t < cursor.t || (t === cursor.t && doc.imageId < cursor.id);
}

function assertCursor(cursor) {
  if (cursor === undefined || cursor === null) return;
  if (typeof cursor !== 'object' || !Number.isFinite(cursor.t) || typeof cursor.id !== 'string') {
    throw new Error('cursor không hợp lệ (phải là giá trị do list() trả về).');
  }
}

function assertOwnerId(ownerId) {
  if (!ownerId || typeof ownerId !== 'string') throw new Error('ownerId bắt buộc.');
}

/**
 * @param {Object} [options]
 * @param {Array}  [options.seed]            dữ liệu khởi tạo (mặc định MOCK_IMAGES); được sao chép
 * @param {() => 'normal'|'empty'|'error'} [options.getListMode]  đọc lúc gọi list/subscribe (giữ ?mock=empty|error)
 * @param {number} [options.latencyMs=150]      độ trễ các thao tác ghi/đọc đơn lẻ
 * @param {number} [options.listLatencyMs=600]  độ trễ list/subscribe (giữ nhịp loading như UI hiện tại)
 * @param {() => number} [options.now]       đồng hồ (ms), truyền vào để kiểm thử
 * @returns {import('../../application/ports.js').ImageRepository & { debugListenerCount: () => number }}
 */
export function createMockImageRepository({
  seed = MOCK_IMAGES,
  getListMode = () => 'normal',
  latencyMs = 150,
  listLatencyMs = 600,
  now = () => Date.now(),
} = {}) {
  const docs = new Map(seed.map((doc) => [doc.imageId, clone(doc)]));
  const listeners = new Set();

  // Đồng hồ tăng NGHIÊM NGẶT: ảnh tạo sau luôn mới hơn (kể cả ảnh seed) => thứ tự "mới nhất trước" ổn định.
  let lastMs = Math.max(0, ...[...docs.values()].map((doc) => timeOf(doc.createdAt)));
  function nextDate() {
    lastMs = Math.max(now(), lastMs + 1);
    return new Date(lastMs);
  }

  const ownerDocsNewestFirst = (ownerId) =>
    [...docs.values()].filter((doc) => doc.ownerId === ownerId).sort(compareNewestFirst);

  // ----- realtime giả lập -----
  function emit(listener) {
    if (!listener.active) return;
    const mode = getListMode();
    if (mode === 'error') {
      listener.onError(new Error('MOCK: Không tải được danh sách ảnh (lỗi giả lập).'));
      return;
    }
    const items = mode === 'empty' ? [] : ownerDocsNewestFirst(listener.ownerId).slice(0, listener.limit);
    listener.onData(clone(items));
  }

  function notifyOwner(ownerId) {
    for (const listener of listeners) {
      if (listener.ownerId === ownerId) queueMicrotask(() => emit(listener));
    }
  }

  return {
    async create(doc) {
      await wait(latencyMs);
      if (!doc?.imageId || !doc?.ownerId) throw new Error('create cần imageId và ownerId.');
      if (docs.has(doc.imageId)) throw new Error(`Document ${doc.imageId} đã tồn tại.`);
      const stamp = nextDate();
      docs.set(doc.imageId, { ...clone(doc), createdAt: stamp, updatedAt: stamp });
      notifyOwner(doc.ownerId);
    },

    async get(imageId) {
      await wait(latencyMs);
      const doc = docs.get(imageId);
      return doc ? clone(doc) : null;
    },

    async list({ ownerId, limit, cursor } = {}) {
      await wait(listLatencyMs);
      const mode = getListMode();
      if (mode === 'error') throw new Error('MOCK: Không tải được danh sách ảnh (lỗi giả lập).');
      assertOwnerId(ownerId);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('limit phải là số nguyên >= 1.');
      assertCursor(cursor);
      if (mode === 'empty') return { items: [], nextCursor: null };

      let sorted = ownerDocsNewestFirst(ownerId);
      if (cursor) sorted = sorted.filter((doc) => isAfterCursor(doc, cursor));
      const page = sorted.slice(0, limit + 1); // lấy dư 1 để biết còn trang sau
      const hasMore = page.length > limit;
      const items = page.slice(0, limit);
      return {
        items: clone(items),
        nextCursor: hasMore ? cursorOf(items[items.length - 1]) : null,
      };
    },

    subscribe({ ownerId, limit } = {}, onData, onError) {
      assertOwnerId(ownerId);
      if (!Number.isInteger(limit) || limit < 1) throw new Error('limit phải là số nguyên >= 1.');
      const listener = { ownerId, limit, onData, onError, active: true };
      listeners.add(listener);
      wait(listLatencyMs).then(() => emit(listener));
      return () => {
        listener.active = false;
        listeners.delete(listener);
      };
    },

    // So sánh rồi ghi: phần kiểm tra và ghi chạy ĐỒNG BỘ (không có await ở giữa) nên nguyên tử,
    // hai lệnh đồng thời chỉ một lệnh thắng.
    async transition(imageId, { from, to, patch = {} }) {
      await wait(latencyMs);
      const doc = docs.get(imageId);
      if (!doc) throw fail(ERROR_CODE.NOT_FOUND, `Không tìm thấy document ${imageId}.`);
      if (doc.status !== from) {
        throw fail(ERROR_CODE.STATUS_CONFLICT, `Trạng thái hiện tại là ${doc.status}, không phải ${from}.`);
      }
      for (const [key, value] of Object.entries(patch)) {
        if (value === null) delete doc[key]; // null = xóa trường
        else doc[key] = clone(value);
      }
      doc.status = to;
      doc.updatedAt = nextDate();
      notifyOwner(doc.ownerId);
    },

    async remove(imageId) {
      await wait(latencyMs);
      const doc = docs.get(imageId);
      if (!doc) return; // không tồn tại = đã xóa
      docs.delete(imageId);
      notifyOwner(doc.ownerId);
    },

    /** Chỉ để kiểm thử: số listener còn đang đăng ký (phát hiện rò rỉ). Không thuộc port. */
    debugListenerCount: () => listeners.size,
  };
}
