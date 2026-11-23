// Smoke/UI test INT-3B — Gallery React nối với API client (MOCK mặc định, REAL tường minh).
// fetch/token GIẢ; mọi fetch/XHR toàn cục bị CHẶN và đếm. KHÔNG gọi Backend/Firebase/Cloudinary thật.
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/int3b-gallery-ui-smoke.mjs .  (xem tests/README.md)
// Không có DOM trong môi trường test: giao diện kiểm bằng SSR (renderToString); hành vi phân trang/đổi user/response muộn kiểm trực tiếp
// trên controller (store thuần) mà hook useGalleryList gắn vào React bằng useSyncExternalStore.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => (ok ? (passed += 1) : failures.push(`${name}${detail ? ` — ${detail}` : ''}`));
const settle = async (p) => { try { return { value: await p }; } catch (error) { return { error }; } };
const out = (s) => process.stdout.write(s + '\n');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, label = '') => { for (let i = 0; i < 200; i += 1) { if (fn()) return true; await tick(1); } failures.push(`hết thời gian chờ: ${label}`); return false; };

// ---------- bẫy mạng toàn cục + ghi console ----------
let globalNetCalls = 0;
globalThis.fetch = async () => { globalNetCalls += 1; throw new Error('INT-3B smoke: bị chặn gọi mạng thật'); };
globalThis.XMLHttpRequest = class { constructor() { globalNetCalls += 1; throw new Error('INT-3B smoke: bị chặn XHR'); } };
const logged = [];
for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = (...a) => { logged.push(a.map(String).join(' ')); };

// ---------- Backend giả (ngữ nghĩa Backend thật: uid từ token, cursor mờ, JSON dạng Firestore) ----------
const BASE = 'http://localhost:8000';
const res = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const urlOf = (id, n) => `https://res.cloudinary.com/demo-cloud/image/upload/v1/${id}_${n}.webp`;
const isoAt = (i, tz = '+00:00') => `${new Date(Date.UTC(2026, 2, 1) + i * 60_000).toISOString().slice(0, 19)}.${String(i % 1000).padStart(3, '0')}456${tz}`;
const cdoc = (id, owner, i, over = {}) => ({
  imageId: id, ownerId: owner, retryCount: 0, createdAt: isoAt(i), status: 'DONE', provider: 'cloudinary', fileName: `${id}.png`,
  original: { size: 2457600, width: 4000, height: 3000 }, variants: { thumbnail: urlOf(id, 't'), medium: urlOf(id, 'm'), webp: urlOf(id, 'w') },
  publicIds: {}, assetIds: { thumbnail: `x/${id}_t` }, previewUrl: urlOf(id, 't'), processedSize: 412000, processingMs: 1840, savedPercent: 83.2,
  errorReason: null, updatedAt: isoAt(i), ...over,
});
const ddoc = (fid, owner, i) => ({
  imageId: `drive_${fid}`, ownerId: owner, provider: 'google_drive', originalName: `${fid}.jpg`, sizeBytes: 1234, status: 'DONE',
  previewUrl: `/images/preview/${fid}`, variants: { thumbnail: `/images/preview/${fid}`, medium: `/images/preview/${fid}`, webp: `/images/preview/${fid}` },
  driveFileId: fid, createdAt: isoAt(i, 'Z'), updatedAt: isoAt(i, 'Z'),
});
const TOKENS = { 'TOKEN-A': 'uid-A', 'TOKEN-B': 'uid-B' };
function makeBackend(docsByUid) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    const auth = init.headers?.Authorization ?? '';
    const uid = TOKENS[auth.startsWith('Bearer ') ? auth.slice(7) : ''];
    if (!uid) return res(401, { detail: 'Invalid token' });
    if (u.pathname !== '/images') return res(404, { detail: 'Not Found' });
    const limit = Math.min(u.searchParams.get('limit') === null ? 20 : Number(u.searchParams.get('limit')), 20);
    let list = [...(docsByUid[uid] ?? [])].sort((a, b) => (a.createdAt === b.createdAt ? (a.imageId < b.imageId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
    const cursor = u.searchParams.get('cursor');
    if (cursor) {
      let c; try { c = JSON.parse(unb64(cursor)); } catch { return res(400, { detail: 'Invalid cursor' }); }
      if (c?.o !== uid) return res(400, { detail: 'Invalid cursor' });
      list = list.filter((d) => d.createdAt < c.t || (d.createdAt === c.t && d.imageId < c.i));
    }
    const page = list.slice(0, limit + 1); const hasMore = page.length > limit; const items = page.slice(0, limit); const last = items.at(-1);
    return res(200, { items, nextCursor: hasMore && last ? b64(JSON.stringify({ o: uid, t: last.createdAt, i: last.imageId })) : null, hasMore: hasMore && Boolean(last) });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const scripted = (steps) => { const calls = []; const f = async (url, init) => { calls.push({ url: String(url), init }); return steps[Math.min(calls.length - 1, steps.length - 1)](init, calls.length - 1); }; f.calls = calls; return f; };
const reply = (status, body) => async () => res(status, body);
const hang = () => (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
function deferredFetch() { // mỗi request chờ được giải phóng thủ công
  const pending = []; const calls = [];
  const f = (url, init) => new Promise((resolve, reject) => {
    calls.push({ url: String(url), init });
    pending.push({ resolve, reject, init });
    init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
  });
  f.calls = calls; f.pending = pending;
  return f;
}

const server = await createServer({
  root, envDir: process.env.EMPTY_ENV_DIR, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const load = (p) => server.ssrLoadModule(p);
  const nativeImport = (spec) => import(pathToFileURL(path.join(root, 'node_modules', spec)).href);
  const reactMod = await nativeImport('react/index.js'); const React = reactMod.default ?? reactMod;
  const domServer = await nativeImport('react-dom/server.node.js'); const renderToString = (domServer.default ?? domServer).renderToString ?? domServer.renderToString;
  const Router = await nativeImport('react-router/dist/production/index.js');
  const h = React.createElement;
  const netBefore = globalNetCalls;

  const { createGalleryController, EMPTY_GALLERY_STATE } = await load('/src/presentation/hooks/galleryListController.js');
  const { useGalleryList } = await load('/src/presentation/hooks/useGalleryList.js');
  const { createGalleryServices, resolveGalleryConfig } = await load('/src/app/createGalleryServices.js');
  const { GalleryServicesContext, DEFAULT_GALLERY_SERVICES } = await load('/src/presentation/contexts/GalleryServicesContext.js');
  const { AuthContext } = await load('/src/presentation/contexts/AuthContext.js');
  const { GalleryPage } = await load('/src/presentation/pages/GalleryPage.jsx');
  const { RealGalleryView } = await load('/src/presentation/components/gallery/RealGalleryView.jsx');
  const { ImageCard } = await load('/src/presentation/components/gallery/ImageCard.jsx');
  const { toCardModel, safePreviewUrl, shouldShowPreview } = await load('/src/presentation/components/gallery/galleryCardModel.js');
  const { mapGalleryImage } = await load('/src/infrastructure/api/galleryMapper.js');
  const { MOCK_IMAGES } = await load('/src/infrastructure/mock/mockImages.js');
  const { createBackendClient } = await load('/src/infrastructure/api/backendClient.js');
  const { createListGalleryImages } = await load('/src/application/usecases/listGalleryImages.js');
  check('nạp module/không gọi mạng', globalNetCalls === netBefore);

  const strip = (html) => html.replace(/<!--.*?-->/g, '').replace(/&quot;/g, '"');
  const baseAuth = { user: null, initializing: false, isMock: false, mode: 'firebase', configError: null, authError: null, login: async () => {}, logout: async () => {}, getIdToken: async () => 'x' };
  const realUser = { uid: 'uid-A', displayName: 'A', email: 'a@x.test' };
  const mockUser = { uid: 'mock-uid-001', displayName: 'M', email: 'm@x.test' };
  const renderPage = (auth, element, services) => strip(renderToString(
    h(Router.MemoryRouter, { initialEntries: ['/gallery'] },
      h(AuthContext.Provider, { value: { ...baseAuth, ...auth } },
        services ? h(GalleryServicesContext.Provider, { value: services }, element) : element)),
  ));

  // ============ 1. Chọn MOCK / REAL ============
  const fakeAuth = (mode = 'firebase') => ({ mode, useCases: { getIdToken: async () => 'TOKEN-A' } });
  const GOOD = { VITE_GALLERY_MODE: 'real', VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'http://localhost:8000' };
  const FULL_ENV = { VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'http://localhost:8000', VITE_FIREBASE_API_KEY: 'k', VITE_FIREBASE_AUTH_DOMAIN: 'd', VITE_FIREBASE_PROJECT_ID: 'p', VITE_CLOUDINARY_CLOUD_NAME: 'c', VITE_CLOUDINARY_UPLOAD_PRESET: 'u' };
  {
    const f0 = scripted([reply(200, {})]);
    for (const [label, env] of [['env rỗng', {}], ['VITE_GALLERY_MODE=mock', { VITE_GALLERY_MODE: 'mock' }], ['VITE_GALLERY_MODE rỗng', { VITE_GALLERY_MODE: '  ' }], ['MOCK viết hoa', { VITE_GALLERY_MODE: 'MOCK' }]]) {
      const s = createGalleryServices({ env, isDev: true, authServices: fakeAuth(), fetchImpl: f0 });
      check(`chọn/${label} -> MOCK, không có listPage`, s.mode === 'mock' && s.isMock === true && s.configError === null && s.listPage === null);
    }
    const s2 = createGalleryServices({ env: FULL_ENV, isDev: true, authServices: fakeAuth(), fetchImpl: f0 });
    check('chọn/.env.local ĐẦY ĐỦ Firebase+Cloudinary+Backend real nhưng KHÔNG đặt VITE_GALLERY_MODE -> vẫn MOCK', s2.mode === 'mock' && s2.listPage === null);
    check('chọn/mặc định khi không có Provider là MOCK', DEFAULT_GALLERY_SERVICES.mode === 'mock' && DEFAULT_GALLERY_SERVICES.isMock === true && DEFAULT_GALLERY_SERVICES.listPage === null);
    const ok = createGalleryServices({ env: GOOD, isDev: true, authServices: fakeAuth(), fetchImpl: f0 });
    check('chọn/REAL đủ điều kiện (localhost + dev + Firebase Auth thật) -> real, có listPage', ok.mode === 'real' && ok.isMock === false && ok.configError === null && typeof ok.listPage === 'function');
    check('chọn/khởi tạo REAL KHÔNG gọi mạng', f0.calls.length === 0 && globalNetCalls === netBefore);
    for (const host of ['http://127.0.0.1:8000', 'http://[::1]:8000', 'https://localhost:8443']) {
      check(`chọn/REAL chấp nhận ${host}`, createGalleryServices({ env: { ...GOOD, VITE_API_BASE_URL: host }, isDev: true, authServices: fakeAuth() }).mode === 'real');
    }
    check('chọn/" Real " (khoảng trắng, hoa thường) được chấp nhận như backendConfig', createGalleryServices({ env: { ...GOOD, VITE_GALLERY_MODE: ' Real ' }, isDev: true, authServices: fakeAuth() }).mode === 'real');
    const bad = (label, env, opts = {}) => {
      const s = createGalleryServices({ env, isDev: true, authServices: fakeAuth(), fetchImpl: f0, ...opts });
      check(`chọn/${label} -> invalid (KHÔNG fallback MOCK), không listPage, có thông báo`, s.mode === 'invalid' && s.isMock === false && s.listPage === null && typeof s.configError?.message === 'string' && s.configError.message.length > 20, s.mode);
      return s;
    };
    bad('REAL nhưng VITE_BACKEND_MODE=mock', { ...GOOD, VITE_BACKEND_MODE: 'mock' });
    bad('REAL nhưng thiếu VITE_BACKEND_MODE', { VITE_GALLERY_MODE: 'real', VITE_API_BASE_URL: 'http://localhost:8000' });
    bad('REAL nhưng thiếu VITE_API_BASE_URL', { VITE_GALLERY_MODE: 'real', VITE_BACKEND_MODE: 'real' });
    bad('REAL nhưng URL không hợp lệ', { ...GOOD, VITE_API_BASE_URL: 'khong-phai-url' });
    bad('REAL với Backend từ xa https://api.example.test', { ...GOOD, VITE_API_BASE_URL: 'https://api.example.test' });
    bad('REAL với host giả localhost.evil.test', { ...GOOD, VITE_API_BASE_URL: 'https://localhost.evil.test' });
    bad('REAL với user:pass@', { ...GOOD, VITE_API_BASE_URL: 'http://localhost:8000@evil.test' });
    bad('VITE_GALLERY_MODE giá trị lạ', { ...GOOD, VITE_GALLERY_MODE: 'yes' });
    bad('REAL ngoài development (isDev=false, bản build)', GOOD, { isDev: false });
    bad('REAL khi isDev không phải true (null)', GOOD, { isDev: null });
    const noAuth = bad('REAL với đăng nhập MOCK (Firebase chưa cấu hình)', GOOD, { authServices: fakeAuth('mock') });
    bad('REAL với Firebase cấu hình sai (misconfigured)', GOOD, { authServices: fakeAuth('misconfigured') });
    bad('REAL không có authServices', GOOD, { authServices: undefined });
    bad('REAL thiếu getIdToken', GOOD, { authServices: { mode: 'firebase', useCases: {} } });
    check('chọn/thông báo lỗi nêu điều kiện thiếu (Firebase Authentication thật)', /Firebase Authentication thật/.test(noAuth.configError.message));
    const leaky = createGalleryServices({ env: { ...GOOD, VITE_API_BASE_URL: 'https://bi-mat-host.example.test/duong-dan-rieng' }, isDev: true, authServices: fakeAuth() });
    check('chọn/thông báo lỗi KHÔNG in giá trị cấu hình (chỉ tên biến)', !/bi-mat-host|duong-dan-rieng/.test(JSON.stringify(leaky.configError)));
    check('chọn/resolveGalleryConfig thuần: không gọi mạng, REAL cần cả 4 điều kiện', resolveGalleryConfig({ env: GOOD, isDev: true, authMode: 'firebase', hasIdToken: true }).mode === 'real' && resolveGalleryConfig({ env: GOOD, isDev: true, authMode: 'firebase', hasIdToken: false }).mode === 'invalid');
    check('chọn/mọi cấu hình sai: 0 request mạng', f0.calls.length === 0 && globalNetCalls === netBefore);
  }

  // ============ 2. Controller phân trang ============
  const owners = (n, owner = 'uid-A', prefix = 'img') => Array.from({ length: n }, (_, i) => ({ imageId: `${prefix}-${owner}-${String(i).padStart(3, '0')}`, ownerId: owner }));
  function makeList(docs, { gated = false } = {}) {
    const calls = [];
    const listPage = (args) => {
      const call = { args, signal: args.signal };
      calls.push(call);
      const offset = args.cursor ? Number(args.cursor.slice(1)) : 0;
      const items = docs.slice(offset, offset + args.limit);
      const more = offset + args.limit < docs.length;
      const page = { items, nextCursor: more ? `c${offset + args.limit}` : null, hasMore: more };
      if (!gated) return Promise.resolve(page);
      return new Promise((resolve, reject) => { call.resolve = (p = page) => resolve(p); call.reject = reject; });
    };
    listPage.calls = calls;
    return listPage;
  }
  const started = (controller) => { let n = 0; const unsub = controller.subscribe(() => { n += 1; }); return { unsub, notified: () => n }; };

  {
    const lp = makeList(owners(45));
    const c = createGalleryController({ ownerId: 'uid-A', listPage: lp });
    check('controller/trước khi đăng ký: loading, KHÔNG có request', c.getSnapshot().status === 'loading' && lp.calls.length === 0);
    const s = started(c);
    check('controller/đăng ký xong vẫn chưa gọi đồng bộ (hoãn tới microtask cho StrictMode)', lp.calls.length === 0);
    await until(() => c.getSnapshot().status === 'ready', 'trang đầu');
    const a = lp.calls[0].args;
    check('trang đầu/đúng 1 request, limit 20, không cursor, có ownerId + signal', lp.calls.length === 1 && a.limit === 20 && a.cursor === undefined && a.ownerId === 'uid-A' && a.signal instanceof AbortSignal && Object.keys(a).sort().join() === 'cursor,limit,ownerId,signal');
    let st = c.getSnapshot();
    check('trang đầu/20 ảnh, hasMore, nextCursor, không lỗi', st.items.length === 20 && st.hasMore === true && st.nextCursor === 'c20' && st.error === null && st.loadingMore === false);
    check('trang đầu/snapshot bất biến (frozen)', Object.isFrozen(st) && Object.isFrozen(st.items));
    await c.loadMore();
    await c.loadMore();
    st = c.getSnapshot();
    check('45 ảnh qua 3 trang: 20 + 20 + 5', st.items.length === 45 && st.hasMore === false && st.nextCursor === null);
    check('45 ảnh/cursor đúng thứ tự: (không) -> c20 -> c40, đều là nextCursor trước đó', lp.calls.map((x) => x.args.cursor).join('|') === '|c20|c40');
    check('45 ảnh/không lặp, không mất, đúng thứ tự', new Set(st.items.map((i) => i.imageId)).size === 45 && st.items.every((it, i) => it.imageId === `img-uid-A-${String(i).padStart(3, '0')}`));
    const before = lp.calls.length;
    check('hết trang/loadMore bị bỏ qua, không request', (await c.loadMore()) === false && lp.calls.length === before);
    s.unsub();
  }
  {
    const lp = makeList(owners(45), { gated: true });
    const c = createGalleryController({ ownerId: 'uid-A', listPage: lp });
    const s = started(c);
    await until(() => lp.calls.length === 1, 'request đầu');
    check('loadMore khi trang đầu đang tải bị bỏ qua', (await c.loadMore()) === false && lp.calls.length === 1);
    check('reload khi trang đầu đang tải là no-op (không request trùng)', (c.reload(), lp.calls.length === 1));
    lp.calls[0].resolve();
    await until(() => c.getSnapshot().status === 'ready', 'xong trang đầu');
    const p1 = c.loadMore(); const p2 = c.loadMore(); const p3 = c.loadMore();
    check('bấm Tải thêm liên tục/chỉ 1 request mới, loadingMore=true ngay (đồng bộ)', lp.calls.length === 2 && c.getSnapshot().loadingMore === true);
    check('bấm Tải thêm liên tục/các lần bấm sau trả về false ngay', (await Promise.all([p2, p3])).every((v) => v === false) && lp.calls.length === 2);
    lp.calls[1].resolve();
    check('bấm Tải thêm liên tục/lần đầu thành công, 40 ảnh, không ghép trùng', (await p1) === true && c.getSnapshot().items.length === 40 && new Set(c.getSnapshot().items.map((i) => i.imageId)).size === 40 && c.getSnapshot().loadingMore === false);
    s.unsub();
  }
  {
    // Ghép trùng imageId + cursor lặp
    const base = owners(30);
    const calls = [];
    const lp = async (args) => { calls.push(args); return calls.length === 1 ? { items: base.slice(0, 20), nextCursor: 'cA', hasMore: true } : { items: [...base.slice(15, 30)], nextCursor: null, hasMore: false }; };
    const c = createGalleryController({ ownerId: 'uid-A', listPage: lp }); const s = started(c);
    await until(() => c.getSnapshot().status === 'ready');
    await c.loadMore();
    const ids = c.getSnapshot().items.map((i) => i.imageId);
    check('không ghép trùng imageId khi trang sau lặp lại ảnh đã có (15..19)', ids.length === 30 && new Set(ids).size === 30);
    s.unsub();
    const lp2 = async (args) => ({ items: owners(2, 'uid-A', args.cursor ? 'x' : 'y'), nextCursor: 'cSAME', hasMore: true });
    const c2 = createGalleryController({ ownerId: 'uid-A', listPage: lp2 }); const s2 = started(c2);
    await until(() => c2.getSnapshot().status === 'ready');
    await c2.loadMore(); // cursor 'cSAME' -> trang sau lại trả 'cSAME'
    const r = c2.getSnapshot();
    check('cursor lặp (Backend trả lại đúng cursor cũ) -> loadMoreError INVALID_RESPONSE, giữ ảnh, không lặp vô hạn', r.loadMoreError?.details?.kind === 'INVALID_RESPONSE' && r.items.length === 2 && r.loadingMore === false);
    s2.unsub();
  }
  {
    // Tải thêm lỗi -> giữ ảnh -> thử lại
    let fail = true; const cursors = [];
    const inner = makeList(owners(45));
    const lp = (args) => { cursors.push(args.cursor); if (args.cursor && fail) { fail = false; return Promise.reject(Object.assign(new Error('Backend gặp lỗi (HTTP 503) (Storage unavailable).'), { code: 'UNKNOWN', details: { kind: 'SERVER_ERROR', httpStatus: 503, retryable: true } })); } return inner(args); };
    const c = createGalleryController({ ownerId: 'uid-A', listPage: lp }); const s = started(c);
    await until(() => c.getSnapshot().status === 'ready');
    await c.loadMore();
    let st = c.getSnapshot();
    check('tải thêm lỗi 503/giữ nguyên 20 ảnh đã tải, status vẫn ready, có loadMoreError', st.items.length === 20 && st.status === 'ready' && st.loadMoreError?.details?.httpStatus === 503 && st.error === null && st.loadingMore === false);
    check('tải thêm lỗi/vẫn hasMore và cursor cũ để thử lại', st.hasMore === true && st.nextCursor === 'c20');
    check('tải thêm lỗi/lỗi trang tiếp KHÔNG xóa gallery (không thành rỗng)', st.items.length > 0);
    await c.loadMore();
    st = c.getSnapshot();
    check('thử lại/dùng ĐÚNG cursor cũ, thành công, 40 ảnh, xóa loadMoreError', cursors.join('|') === '|c20|c20' && st.items.length === 40 && st.loadMoreError === null);
    s.unsub();
  }
  {
    // Trang đầu lỗi (503) không thành rỗng; reload khôi phục
    let down = true;
    const inner = makeList(owners(5));
    const err503 = Object.assign(new Error('Backend gặp lỗi (HTTP 503) (Storage unavailable). Hãy thử lại sau.'), { code: 'UNKNOWN', details: { kind: 'SERVER_ERROR', httpStatus: 503, retryable: true } });
    const lp = (args) => (down ? Promise.reject(err503) : inner(args));
    const c = createGalleryController({ ownerId: 'uid-A', listPage: lp }); const s = started(c);
    await until(() => c.getSnapshot().status === 'error');
    let st = c.getSnapshot();
    check('503 trang đầu/status error, giữ lỗi, items rỗng NHƯNG status không phải ready (UI không hiện "Chưa có ảnh")', st.status === 'error' && st.error === err503 && st.items.length === 0 && st.hasMore === false);
    down = false;
    c.reload();
    check('reload sau lỗi/chuyển ngay sang loading, xóa lỗi cũ', c.getSnapshot().status === 'loading' && c.getSnapshot().error === null);
    await until(() => c.getSnapshot().status === 'ready');
    check('reload sau lỗi/khôi phục thành công', c.getSnapshot().items.length === 5);
    s.unsub();
    const lpe = makeList([]);
    const ce = createGalleryController({ ownerId: 'uid-A', listPage: lpe }); const se = started(ce);
    await until(() => ce.getSnapshot().status === 'ready');
    check('gallery rỗng thật/ready + items [] + hasMore false (khác với lỗi)', ce.getSnapshot().items.length === 0 && ce.getSnapshot().hasMore === false && ce.getSnapshot().error === null);
    se.unsub();
  }
  {
    // Reload: xóa dữ liệu + cursor; response muộn của lần trước bị bỏ qua
    const lp = makeList(owners(45), { gated: true });
    const c = createGalleryController({ ownerId: 'uid-A', listPage: lp }); const s = started(c);
    await until(() => lp.calls.length === 1); lp.calls[0].resolve();
    await until(() => c.getSnapshot().status === 'ready');
    const pm = c.loadMore(); await until(() => lp.calls.length === 2); // tải thêm đang bay với cursor c20
    c.reload();
    const st = c.getSnapshot();
    check('reload/xóa NGAY danh sách và cursor, loading', st.status === 'loading' && st.items.length === 0 && st.nextCursor === null && st.loadingMore === false);
    check('reload/hủy request tải thêm đang bay (signal aborted)', lp.calls[1].signal.aborted === true);
    await until(() => lp.calls.length === 3);
    check('reload/request mới KHÔNG dùng cursor cũ', lp.calls[2].args.cursor === undefined);
    lp.calls[1].resolve({ items: owners(20, 'uid-A', 'muon'), nextCursor: 'c40', hasMore: true }); // response MUỘN của epoch cũ
    await pm; await tick(2);
    check('reload/response muộn của lần trước KHÔNG ghi vào state', c.getSnapshot().items.length === 0 && c.getSnapshot().status === 'loading');
    lp.calls[2].resolve();
    await until(() => c.getSnapshot().status === 'ready');
    check('reload/chỉ dữ liệu mới, không lẫn ảnh muộn', c.getSnapshot().items.length === 20 && !c.getSnapshot().items.some((i) => i.imageId.startsWith('muon')) && c.getSnapshot().nextCursor === 'c20');
    s.unsub();
  }
  {
    // StrictMode: subscribe -> unsubscribe -> subscribe đồng bộ
    const lp = makeList(owners(5));
    const c = createGalleryController({ ownerId: 'uid-A', listPage: lp });
    const u1 = c.subscribe(() => {}); u1(); const u2 = c.subscribe(() => {});
    await until(() => c.getSnapshot().status === 'ready');
    await tick(3);
    check('StrictMode/mount-unmount-mount đồng bộ chỉ tạo ĐÚNG 1 request', lp.calls.length === 1 && c.getSnapshot().items.length === 5);
    u2();
    const lp2 = makeList(owners(5), { gated: true });
    const c2 = createGalleryController({ ownerId: 'uid-A', listPage: lp2 });
    const v1 = c2.subscribe(() => {}); await until(() => lp2.calls.length === 1); v1(); const v2 = c2.subscribe(() => {});
    check('StrictMode/unmount thật hủy request đang bay, mount lại bắt đầu lại sạch', lp2.calls[0].signal.aborted === true && c2.getSnapshot().status === 'loading' && c2.getSnapshot().items.length === 0);
    await until(() => lp2.calls.length === 2); lp2.calls[0].resolve(); lp2.calls[1].resolve();
    await until(() => c2.getSnapshot().status === 'ready');
    check('StrictMode/response của lần mount đã hủy không ghi đè, kết quả đúng 5 ảnh', c2.getSnapshot().items.length === 5);
    v2();
  }
  {
    // Unmount: response muộn không ghi, không thông báo listener
    const lp = makeList(owners(45), { gated: true });
    const c = createGalleryController({ ownerId: 'uid-A', listPage: lp });
    const s = started(c);
    await until(() => lp.calls.length === 1); lp.calls[0].resolve();
    await until(() => c.getSnapshot().status === 'ready');
    const pm = c.loadMore(); await until(() => lp.calls.length === 2);
    s.unsub();
    const n = s.notified();
    check('unmount/hủy request đang bay', lp.calls[1].signal.aborted === true);
    lp.calls[1].resolve(); await pm; await tick(2);
    check('unmount/response muộn không thông báo listener, không ghi state (về trạng thái khởi đầu)', s.notified() === n && c.getSnapshot().items.length === 0 && c.getSnapshot().status === 'loading');
    check('unmount/loadMore sau khi dừng bị bỏ qua', (await c.loadMore()) === false && lp.calls.length === 2);
  }
  {
    // Đổi user A -> B khi request của A chưa xong
    const gateA = makeList(owners(45, 'uid-A'), { gated: true });
    const listB = makeList(owners(7, 'uid-B'));
    const cA = createGalleryController({ ownerId: 'uid-A', listPage: gateA });
    const sA = started(cA);
    await until(() => gateA.calls.length === 1); // request của A đang bay
    sA.unsub(); // đổi user: hook hủy đăng ký controller cũ...
    const cB = createGalleryController({ ownerId: 'uid-B', listPage: listB }); // ...và tạo controller mới cho B
    check('đổi user/B bắt đầu với danh sách RỖNG ngay lập tức, không dữ liệu của A', cB.getSnapshot().items.length === 0 && cB.getSnapshot().ownerId === 'uid-B' && cB.getSnapshot().status === 'loading');
    const sB = started(cB);
    check('đổi user/request của A bị abort', gateA.calls[0].signal.aborted === true);
    await until(() => cB.getSnapshot().status === 'ready');
    gateA.calls[0].resolve(); // response của A đến MUỘN, sau khi B đã hiển thị
    await tick(3);
    const stB = cB.getSnapshot();
    check('đổi user/response muộn của A KHÔNG lộ ảnh của A cho B', stB.items.length === 7 && stB.items.every((i) => i.ownerId === 'uid-B') && !JSON.stringify(stB).includes('uid-A'));
    check('đổi user/controller A đã dừng: không còn dữ liệu của A', cA.getSnapshot().items.length === 0);
    check('đổi user/B chỉ gọi listPage của B với ownerId=uid-B', listB.calls.every((x) => x.args.ownerId === 'uid-B'));
    sB.unsub();
  }
  {
    let threw = 0;
    for (const bad of [{}, { ownerId: '', listPage: () => {} }, { ownerId: 'u' }, { ownerId: 'u', listPage: 5 }, { ownerId: 7, listPage: () => {} }]) { try { createGalleryController(bad); } catch (e) { if (e instanceof TypeError) threw += 1; } }
    check('controller/thiếu ownerId hoặc listPage -> TypeError', threw === 5);
    check('controller/EMPTY_GALLERY_STATE: idle, rỗng, không ownerId, bất biến', EMPTY_GALLERY_STATE.status === 'idle' && EMPTY_GALLERY_STATE.ownerId === null && EMPTY_GALLERY_STATE.items.length === 0 && Object.isFrozen(EMPTY_GALLERY_STATE));
  }

  // ============ 3. Hook useGalleryList (SSR: render đầu, không effect) ============
  {
    const spy = makeList(owners(5));
    const Probe = ({ ownerId }) => { const l = useGalleryList({ ownerId, listPage: spy }); return h('pre', null, JSON.stringify({ status: l.status, n: l.items.length, loading: l.loading, owner: l.ownerId, more: l.hasMore })); };
    const none = strip(renderToString(h(Probe, { ownerId: null })));
    check('hook/chưa đăng nhập hoặc đã đăng xuất (ownerId null) -> rỗng + idle, không request', /"status":"idle"/.test(none) && /"n":0/.test(none) && spy.calls.length === 0);
    const withUser = strip(renderToString(h(Probe, { ownerId: 'uid-A' })));
    await tick(5);
    check('hook/có user: render đầu là loading với 0 ảnh, KHÔNG request khi render (chỉ khi mount/đăng ký)', /"status":"loading"/.test(withUser) && /"loading":true/.test(withUser) && /"n":0/.test(withUser) && spy.calls.length === 0);
    const other = strip(renderToString(h(Probe, { ownerId: 'uid-B' })));
    check('hook/user khác không thừa hưởng dữ liệu (owner trong state là của user mới)', /"owner":"uid-B"/.test(other));
  }

  // ============ 4. Giao diện (SSR) ============
  const img = (id, over = {}) => mapGalleryImage(cdoc(id, 'uid-A', 1, over));
  const state = (over = {}) => ({ ownerId: 'uid-A', status: 'ready', items: [], nextCursor: null, hasMore: false, loadingMore: false, error: null, loadMoreError: null, ...over });
  const view = (s) => strip(renderToString(h(Router.MemoryRouter, null, h(RealGalleryView, { list: s, onReload() {}, onLoadMore() {} }))));
  {
    // MOCK như trước
    let html = renderPage({ user: realUser }, h(GalleryPage));
    check('MOCK/không Provider + Firebase thật -> nhãn MOCK, ghi chú chưa kết nối, thanh kịch bản MOCK', html.includes('MOCK') && html.includes('CHƯA kết nối Firestore') && html.includes('Thử trạng thái MOCK') && !html.includes('DỮ LIỆU THẬT'));
    html = renderPage({ user: mockUser, isMock: true, mode: 'mock' }, h(GalleryPage), DEFAULT_GALLERY_SERVICES);
    check('MOCK/Provider mock + đăng nhập MOCK -> thanh kịch bản, không ghi chú Firestore, không nhãn THẬT', html.includes('Thử trạng thái MOCK') && !html.includes('CHƯA kết nối Firestore') && !html.includes('DỮ LIỆU THẬT'));
    check('MOCK/giữ ba kịch bản ?mock=normal|empty|error', ['?mock=empty', '?mock=error'].every((q) => html.includes(q)) && html.includes('Bình thường'));
    const legacy = strip(renderToString(h(Router.MemoryRouter, null, h(ImageCard, { image: MOCK_IMAGES[0] }))));
    check('MOCK/ImageCard model cũ vẫn có nhãn MOCK, tên file từ originalPath, không <img>', legacy.includes('image-card__thumb-label') && legacy.includes('>MOCK<') && !legacy.includes('<img') && /Ảnh minh họa MOCK cho /.test(legacy));
    const spyReal = makeList(owners(3));
    html = renderPage({ user: realUser }, h(GalleryPage), { mode: 'mock', isMock: true, configError: null, listPage: spyReal });
    check('MOCK/Provider mock có listPage cũng KHÔNG gọi (không có đường REAL)', spyReal.calls.length === 0 && html.includes('Thử trạng thái MOCK'));
  }
  {
    // cấu hình sai: lỗi, không MOCK
    const invalidSvc = { mode: 'invalid', isMock: false, configError: { message: 'Gallery REAL chưa dùng được: thiếu VITE_API_BASE_URL.', missing: ['VITE_API_BASE_URL'] }, listPage: null };
    const html = renderPage({ user: realUser }, h(GalleryPage), invalidSvc);
    check('invalid/hiện lỗi cấu hình với thông báo cụ thể', html.includes('Cấu hình Gallery REAL không hợp lệ') && html.includes('thiếu VITE_API_BASE_URL') && html.includes('role="alert"'));
    check('invalid/KHÔNG fallback MOCK: không nhãn MOCK, không thanh kịch bản, không ảnh, không "Chưa có ảnh"', !html.includes('MOCK') && !html.includes('Thử trạng thái') && !html.includes('image-card') && !html.includes('Chưa có ảnh nào') && !html.includes('DỮ LIỆU THẬT'));
    const spy = makeList(owners(3));
    const htmlMockAuth = renderPage({ user: mockUser, isMock: true, mode: 'mock' }, h(GalleryPage), { mode: 'real', isMock: false, configError: null, listPage: spy });
    await tick(3);
    check('real+đăng nhập MOCK/lỗi cấu hình, không request, không dữ liệu MOCK', htmlMockAuth.includes('đăng nhập MOCK') && spy.calls.length === 0 && !htmlMockAuth.includes('image-card'));
    const htmlReal = renderPage({ user: realUser }, h(GalleryPage), { mode: 'real', isMock: false, configError: null, listPage: spy });
    await tick(3);
    check('real+Firebase thật/render đầu: nhãn DỮ LIỆU THẬT, đang tải, không nhãn MOCK, không thanh kịch bản', htmlReal.includes('DỮ LIỆU THẬT') && htmlReal.includes('Đang tải danh sách ảnh') && !htmlReal.includes('MOCK') && !htmlReal.includes('Thử trạng thái'));
    check('real/render KHÔNG tạo request (spy = 0)', spy.calls.length === 0);
  }
  {
    const cloud = view(state({ items: [img('img-0001', { fileName: 'Anh Bien (1).png' })] }));
    check('REAL Cloudinary/<img> dùng previewUrl https', cloud.includes(`src="${urlOf('img-0001', 't')}"`));
    check('REAL Cloudinary/alt theo tên ảnh, lazy, no-referrer', cloud.includes('alt="Anh Bien (1).png"') && cloud.includes('loading="lazy"') && /referrerPolicy="no-referrer"/i.test(cloud));
    check('REAL Cloudinary/không watermark MOCK, không thanh kịch bản', !cloud.includes('MOCK') && !cloud.includes('image-card__thumb-label') && !cloud.includes('Thử trạng thái'));
    check('REAL Cloudinary/nhãn DỮ LIỆU THẬT + trạng thái Hoàn tất + dung lượng + tiết kiệm + thời gian', cloud.includes('DỮ LIỆU THẬT') && cloud.includes('Hoàn tất') && cloud.includes('Dung lượng gốc') && cloud.includes('2,3 MB') && cloud.includes('Tiết kiệm') && cloud.includes('83,2%') && cloud.includes('Tạo lúc'));
    const xss = view(state({ items: [img('img-0002', { fileName: '<script>alert(1)</script>' })] }));
    check('REAL/tên ảnh được escape (không chèn HTML)', !xss.includes('<script>') && xss.includes('&lt;script&gt;'));
    const drive = mapGalleryImage(ddoc('FILE-9', 'uid-A', 3));
    const dh = view(state({ items: [drive] }));
    check('REAL Drive/placeholder, KHÔNG <img>, ghi rõ chưa có bản xem trước', !dh.includes('<img') && dh.includes('Ảnh từ Google Drive (chưa có bản xem trước)') && dh.includes('role="img"'));
    check('REAL Drive/không đưa "/images/preview/..." hay Bearer vào HTML, không nhãn MOCK', !dh.includes('/images/preview') && !dh.includes('Bearer') && !dh.includes('FILE-9.jpg" src') && !dh.includes('MOCK'));
    const np = view(state({ items: [img('img-0003', { variants: null, previewUrl: null, status: 'PENDING' })] }));
    check('REAL/không có previewUrl -> placeholder thường + trạng thái Đang chờ', !np.includes('<img') && np.includes('Chưa có ảnh xem trước') && np.includes('Đang chờ'));
    const lacking = view(state({ items: [img('img-0004', { original: undefined, savedPercent: null, createdAt: null, processedSize: 100 })] }));
    check('REAL/thiếu dữ liệu -> KHÔNG suy diễn: không dòng dung lượng, không Tiết kiệm (dù có processedSize), không thời gian', !lacking.includes('Dung lượng gốc') && !lacking.includes('Tiết kiệm') && !lacking.includes('Tạo lúc'));
    const est = view(state({ items: [mapGalleryImage(ddoc('F2', 'uid-A', 3))].map((i) => ({ ...i, createdAtEstimated: true })) }));
    check('REAL/thời gian ước lượng được ghi rõ', est.includes('(ước lượng)'));
    const failed = view(state({ items: [img('img-0005', { status: 'FAILED', errorReason: 'TIMEOUT', variants: null, previewUrl: null }), img('img-0006', { status: 'PROCESSING', variants: null, previewUrl: null })] }));
    check('REAL/FAILED hiện Lỗi + lý do; PROCESSING hiện Đang xử lý', failed.includes('Lý do: TIMEOUT') && failed.includes('>Lỗi<') && failed.includes('Đang xử lý'));
    const more = view(state({ items: [img('img-0007')], hasMore: true, nextCursor: 'abc' }));
    check('phân trang UI/hasMore=true -> nút Tải thêm (bật)', /<button[^>]*>Tải thêm<\/button>/.test(more) && !/<button[^>]*disabled[^>]*>Tải thêm/.test(more) && more.includes('còn nữa'));
    const moreBusy = view(state({ items: [img('img-0007')], hasMore: true, loadingMore: true }));
    check('phân trang UI/đang tải thêm -> nút vô hiệu hóa "Đang tải thêm…"', /<button[^>]*disabled[^>]*>Đang tải thêm/.test(moreBusy));
    const moreErr = view(state({ items: [img('img-0007')], hasMore: true, loadMoreError: Object.assign(new Error('Backend gặp lỗi (HTTP 503) (Storage unavailable).'), {}) }));
    check('phân trang UI/tải thêm lỗi: vẫn hiện ảnh đã tải + cảnh báo role=alert + nút thử lại', moreErr.includes('image-card') && moreErr.includes('role="alert"') && moreErr.includes('Không tải thêm được') && moreErr.includes('HTTP 503') && moreErr.includes('Thử tải thêm lại'));
    const end = view(state({ items: [img('img-0007')], hasMore: false }));
    check('phân trang UI/hết trang: không nút Tải thêm, có "Đã hiển thị hết ảnh"', !end.includes('Tải thêm') && end.includes('Đã hiển thị hết ảnh'));
    const empty = view(state({ items: [] }));
    check('UI/gallery rỗng thật -> "Chưa có ảnh nào" + liên kết tải ảnh lên', empty.includes('Chưa có ảnh nào') && empty.includes('/upload'));
    const err503 = view(state({ status: 'error', error: Object.assign(new Error('Backend gặp lỗi (HTTP 503) (Storage unavailable). Hãy thử lại sau.'), {}) }));
    check('UI/503 trang đầu -> ErrorState + nút Thử lại, KHÔNG hiện "Chưa có ảnh nào"', err503.includes('Không tải được thư viện') && err503.includes('HTTP 503') && err503.includes('Thử lại') && !err503.includes('Chưa có ảnh nào'));
    const loading = view(state({ status: 'loading' }));
    check('UI/đang tải trang đầu -> LoadingState, nút Làm mới bị vô hiệu hóa', loading.includes('Đang tải danh sách ảnh') && /<button[^>]*disabled[^>]*>Làm mới/.test(loading));
    const idle = view(state({ status: 'idle' }));
    check('UI/idle (chưa có user) -> không bao giờ hiện danh sách hay "Chưa có ảnh"', idle.includes('Đang tải danh sách ảnh') && !idle.includes('Chưa có ảnh nào') && !idle.includes('image-card'));
    const fiftyCards = view(state({ items: Array.from({ length: 45 }, (_, i) => img(`img-big-${String(i).padStart(3, '0')}`)), hasMore: false }));
    check('UI/45 ảnh -> 45 thẻ, tiêu đề đếm đúng', (fiftyCards.match(/<article class="image-card">/g) || []).length === 45 && fiftyCards.includes('45 ảnh đã tải'));
  }
  {
    // Model thẻ & ảnh lỗi
    check('thẻ/safePreviewUrl chỉ nhận https', safePreviewUrl('https://x.test/a.webp') === 'https://x.test/a.webp' && ['/images/preview/1', 'http://x.test/a', 'javascript:alert(1)', 'data:image/png;base64,AA', '', null, undefined, 5].every((v) => safePreviewUrl(v) === null));
    check('thẻ/ảnh lỗi tải -> placeholder (shouldShowPreview)', shouldShowPreview('https://a', null) === true && shouldShowPreview('https://a', 'https://a') === false && shouldShowPreview('https://b', 'https://a') === true && shouldShowPreview(null, null) === false);
    const hostile = { imageId: 'img-h-0001', status: 'DONE', name: 'x', provider: 'google_drive', previewUrl: '/images/preview/ABC', isMock: false, originalSize: null, savedPercent: 50, createdAt: new Date('invalid') };
    const m = toCardModel(hostile);
    check('thẻ/dữ liệu bất thường (đường dẫn tương đối, Date sai, thiếu size) không lọt vào model', m.previewUrl === null && m.showOriginalSize === false && m.showCreatedAt === false && m.savedText === '50%');
    const html = strip(renderToString(h(Router.MemoryRouter, null, h(ImageCard, { image: hostile }))));
    check('thẻ/render dữ liệu bất thường: không <img>, không "Invalid Date"', !html.includes('<img') && !html.includes('Invalid') && !html.includes('/images/preview'));
    const mockBackendImage = { ...mapGalleryImage(cdoc('img-mb-0001', 'uid-A', 1)), isMock: true };
    check('thẻ/GalleryImage do adapter MOCK tạo (isMock=true) hiện nhãn MOCK', strip(renderToString(h(Router.MemoryRouter, null, h(ImageCard, { image: mockBackendImage })))).includes('>MOCK<') && toCardModel(mockBackendImage).isMock === true);
  }

  // ============ 5. Đầu-cuối: createGalleryServices(REAL) + controller + Backend giả ============
  const sessionAuth = (getToken) => ({ mode: 'firebase', useCases: { getIdToken: async (o) => getToken(o) } });
  const realServices = (backend, getToken = () => 'TOKEN-A') => createGalleryServices({ env: GOOD, isDev: true, authServices: sessionAuth(getToken), fetchImpl: backend });
  const drive = async (services, uid) => { const c = createGalleryController({ ownerId: uid, listPage: services.listPage }); const s = started(c); return { c, s }; };
  {
    const docsA = Array.from({ length: 45 }, (_, i) => cdoc(`img-A-${String(i).padStart(3, '0')}`, 'uid-A', i));
    const docsB = Array.from({ length: 7 }, (_, i) => cdoc(`img-B-${String(i).padStart(3, '0')}`, 'uid-B', 100 + i, { fileName: `bi-mat-B-${i}.png` }));
    const backend = makeBackend({ 'uid-A': docsA, 'uid-B': docsB });
    const { c, s } = await drive(realServices(backend), 'uid-A');
    await until(() => c.getSnapshot().status === 'ready', 'E2E trang đầu');
    await c.loadMore(); await c.loadMore();
    const st = c.getSnapshot();
    check('E2E/45 ảnh Cloudinary qua 3 trang bằng HTTP giả', st.items.length === 45 && st.hasMore === false && new Set(st.items.map((i) => i.imageId)).size === 45);
    const urls = backend.calls.map((x) => new URL(x.url));
    check('E2E/URL: GET /images?limit=20, trang sau thêm cursor = nextCursor trước', urls.length === 3 && urls.every((u) => u.pathname === '/images' && u.searchParams.get('limit') === '20') && !urls[0].searchParams.has('cursor') && urls[1].searchParams.get('cursor')?.length > 10 && urls[2].searchParams.get('cursor') !== urls[1].searchParams.get('cursor'));
    check('E2E/không gửi ownerId/uid; Bearer token; không X-User-Id', backend.calls.every((x) => !/owner|uid/i.test(x.url) && x.init.headers.Authorization === 'Bearer TOKEN-A' && !Object.keys(x.init.headers).some((k) => /x-user-id/i.test(k)) && x.init.method === 'GET'));
    check('E2E/dữ liệu DONE ánh xạ đúng và có thể hiển thị', st.items[0].status === 'DONE' && st.items[0].previewUrl === urlOf(st.items[0].imageId, 't') && st.items[0].createdAt instanceof Date);
    s.unsub();
    const { c: cB, s: sB } = await drive(realServices(backend, () => 'TOKEN-B'), 'uid-B');
    await until(() => cB.getSnapshot().status === 'ready');
    check('E2E/User B chỉ thấy ảnh của B, không có ảnh/tên file của A', cB.getSnapshot().items.length === 7 && cB.getSnapshot().items.every((i) => i.ownerId === 'uid-B') && !JSON.stringify(cB.getSnapshot()).includes('img-A-'));
    sB.unsub();
    const { c: cE, s: sE } = await drive(realServices(makeBackend({ 'uid-A': [] })), 'uid-A');
    await until(() => cE.getSnapshot().status === 'ready');
    check('E2E/gallery rỗng -> ready, 0 ảnh', cE.getSnapshot().items.length === 0 && cE.getSnapshot().hasMore === false);
    sE.unsub();
    const mixed = makeBackend({ 'uid-A': [ddoc('DRV1', 'uid-A', 5), cdoc('img-A-mix-1', 'uid-A', 4)] });
    const { c: cM, s: sM } = await drive(realServices(mixed), 'uid-A');
    await until(() => cM.getSnapshot().status === 'ready');
    const mh = view(state({ items: cM.getSnapshot().items }));
    check('E2E/Drive + Cloudinary lẫn nhau: 1 <img> (Cloudinary) + 1 placeholder (Drive), không MOCK', (mh.match(/<img /g) || []).length === 1 && mh.includes('Ảnh từ Google Drive (chưa có bản xem trước)') && !mh.includes('MOCK') && !mh.includes('/images/preview'));
    sM.unsub();
  }
  {
    // Backend/độc hại trả ảnh của B cho A
    const evil = scripted([reply(200, { items: [cdoc('img-A-0001', 'uid-A', 1), cdoc('img-B-0001', 'uid-B', 2, { fileName: 'bi-mat-B.png' })], nextCursor: null, hasMore: false })]);
    const { c, s } = await drive(realServices(evil), 'uid-A');
    await until(() => c.getSnapshot().status === 'error');
    const st = c.getSnapshot();
    check('phòng thủ/response lẫn ảnh user khác -> error, KHÔNG hiển thị ảnh nào (kể cả ảnh đúng chủ)', st.items.length === 0 && st.error?.details?.kind === 'INVALID_RESPONSE' && !JSON.stringify(st).includes('bi-mat-B'));
    s.unsub();
    // Trang sau lẫn ảnh user khác: giữ ảnh đã tải, không thêm ảnh lạ
    let n = 0;
    const evil2 = async () => { n += 1; return n === 1 ? res(200, { items: [cdoc('img-A-0001', 'uid-A', 1)], nextCursor: 'abc', hasMore: true }) : res(200, { items: [cdoc('img-B-0009', 'uid-B', 2, { fileName: 'bi-mat-B2.png' })], nextCursor: null, hasMore: false }); };
    const { c: c2, s: s2 } = await drive(realServices(evil2), 'uid-A');
    await until(() => c2.getSnapshot().status === 'ready'); await c2.loadMore();
    const st2 = c2.getSnapshot();
    check('phòng thủ/trang sau lẫn ảnh user khác -> loadMoreError, giữ ảnh cũ, KHÔNG thêm ảnh lạ', st2.items.length === 1 && st2.loadMoreError?.details?.kind === 'INVALID_RESPONSE' && !JSON.stringify(st2.items).includes('bi-mat-B2'));
    s2.unsub();
  }
  {
    // Lỗi HTTP ở trang đầu
    const cases = [
      ['401 (token sai, không làm mới được)', scripted([reply(401, { detail: 'Invalid token' })]), () => 'TOKEN-SAI', 'UNAUTHENTICATED', 'UNAUTHENTICATED'],
      ['403', scripted([reply(403, { detail: 'Forbidden' })]), () => 'TOKEN-A', 'FORBIDDEN', 'FORBIDDEN'],
      ['404', scripted([reply(404, { detail: 'Image not found' })]), () => 'TOKEN-A', 'NOT_FOUND', 'NOT_FOUND'],
      ['503', scripted([reply(503, { detail: 'Storage unavailable' })]), () => 'TOKEN-A', 'UNKNOWN', 'SERVER_ERROR'],
      ['mạng', scripted([async () => { throw new TypeError('Failed to fetch'); }]), () => 'TOKEN-A', 'NETWORK', 'NETWORK'],
    ];
    for (const [label, f, tok, code, kind] of cases) {
      const { c, s } = await drive(realServices(f, tok), 'uid-A');
      await until(() => c.getSnapshot().status === 'error', label);
      const st = c.getSnapshot();
      check(`HTTP ${label}/controller ở trạng thái error đúng loại, không ảnh, KHÔNG thành gallery rỗng`, st.status === 'error' && st.error?.code === code && st.error?.details?.kind === kind && st.items.length === 0, `${st.error?.code}/${st.error?.details?.kind}`);
      const html = view(st);
      check(`HTTP ${label}/UI hiện lỗi + Thử lại, không "Chưa có ảnh nào"`, html.includes('Không tải được thư viện') && html.includes('Thử lại') && !html.includes('Chưa có ảnh nào'));
      s.unsub();
    }
    const tokenQ = ['TOKEN-OLD', 'TOKEN-A'];
    const exp = makeBackend({ 'uid-A': [cdoc('img-A-0001', 'uid-A', 1)] });
    const { c, s } = await drive(realServices(exp, () => tokenQ.shift() ?? 'TOKEN-A'), 'uid-A');
    await until(() => c.getSnapshot().status === 'ready');
    check('401 hết hạn/làm mới đúng 1 lần rồi tải được: 2 request, token mới ở lần 2', c.getSnapshot().items.length === 1 && exp.calls.length === 2 && exp.calls[0].init.headers.Authorization === 'Bearer TOKEN-OLD' && exp.calls[1].init.headers.Authorization === 'Bearer TOKEN-A');
    s.unsub();
    const missing = scripted([reply(200, {})]);
    const { c: cm, s: sm } = await drive(realServices(missing, () => ''), 'uid-A');
    await until(() => cm.getSnapshot().status === 'error');
    check('token thiếu/lỗi TOKEN_UNAVAILABLE, không gọi mạng', cm.getSnapshot().error?.details?.kind === 'TOKEN_UNAVAILABLE' && missing.calls.length === 0);
    sm.unsub();
    // timeout: ghép thủ công client + use case với timeout ngắn
    const client = createBackendClient({ baseUrl: BASE, getIdToken: async () => 'TOKEN-A', fetchImpl: scripted([hang()]), timeoutMs: 30 });
    const listPage = ({ ownerId, limit, cursor, signal }) => createListGalleryImages({ backendApi: client })({ limit, cursor, expectedOwnerId: ownerId, signal });
    const ct = createGalleryController({ ownerId: 'uid-A', listPage }); const st2 = started(ct);
    await until(() => ct.getSnapshot().status === 'error', 'timeout');
    check('timeout/NETWORK + TIMEOUT retryable, UI có Thử lại', ct.getSnapshot().error?.details?.kind === 'TIMEOUT' && ct.getSnapshot().error?.details?.retryable === true && view(ct.getSnapshot()).includes('Thử lại'));
    st2.unsub();
  }
  {
    // Tải thêm lỗi qua HTTP rồi retry
    const docs = Array.from({ length: 45 }, (_, i) => cdoc(`img-A-${String(i).padStart(3, '0')}`, 'uid-A', i));
    const real = makeBackend({ 'uid-A': docs }); let failOnce = true;
    const flaky = async (url, init) => { if (new URL(url).searchParams.has('cursor') && failOnce) { failOnce = false; return res(503, { detail: 'Storage unavailable' }); } return real(url, init); };
    const { c, s } = await drive(realServices(flaky), 'uid-A');
    await until(() => c.getSnapshot().status === 'ready'); await c.loadMore();
    let st = c.getSnapshot();
    check('HTTP tải thêm 503/giữ 20 ảnh + loadMoreError; UI hiện cảnh báo và vẫn có ảnh', st.items.length === 20 && st.loadMoreError?.details?.httpStatus === 503 && view(st).includes('Không tải thêm được') && view(st).includes('image-card'));
    await c.loadMore(); await c.loadMore();
    st = c.getSnapshot();
    check('HTTP thử lại/hoàn tất đủ 45 ảnh, không lặp', st.items.length === 45 && new Set(st.items.map((i) => i.imageId)).size === 45 && st.loadMoreError === null);
    s.unsub();
  }
  {
    // Đổi user qua HTTP + response muộn + đăng xuất
    const df = deferredFetch(); const getToken = { who: 'TOKEN-A' };
    const svc = realServices(df, () => getToken.who);
    const cA = createGalleryController({ ownerId: 'uid-A', listPage: svc.listPage }); const sA = started(cA);
    await until(() => df.calls.length === 1, 'request A');
    sA.unsub(); getToken.who = 'TOKEN-B';
    const cB = createGalleryController({ ownerId: 'uid-B', listPage: svc.listPage }); const sB = started(cB);
    await until(() => df.calls.length === 2, 'request B');
    check('đổi user qua HTTP/request A bị abort, request B mang token B', df.calls[0].init.signal.aborted === true && df.calls[1].init.headers.Authorization === 'Bearer TOKEN-B');
    df.pending[1].resolve(res(200, { items: [cdoc('img-B-0001', 'uid-B', 1)], nextCursor: null, hasMore: false }));
    await until(() => cB.getSnapshot().status === 'ready');
    df.pending[0].resolve(res(200, { items: [cdoc('img-A-0001', 'uid-A', 1, { fileName: 'bi-mat-A.png' })], nextCursor: null, hasMore: false })); // A đến muộn
    await tick(5);
    check('đổi user qua HTTP/response muộn của A không lộ ảnh A cho B', cB.getSnapshot().items.length === 1 && cB.getSnapshot().items[0].ownerId === 'uid-B' && !JSON.stringify(cB.getSnapshot()).includes('bi-mat-A'));
    sB.unsub();
    const Probe = ({ ownerId }) => { const l = useGalleryList({ ownerId, listPage: svc.listPage }); return h('pre', null, JSON.stringify({ n: l.items.length, status: l.status })); };
    const out2 = strip(renderToString(h(Probe, { ownerId: null })));
    check('đăng xuất/hook trả ngay rỗng + idle (xóa dữ liệu user trước, không cần chờ)', /"n":0/.test(out2) && /"status":"idle"/.test(out2));
  }

  // ============ 6. Mã nguồn ============
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const sstrip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const importsOf = (code) => [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const pfiles = ['src/presentation/hooks/galleryListController.js', 'src/presentation/hooks/useGalleryList.js', 'src/presentation/hooks/useGalleryServices.js',
    'src/presentation/contexts/GalleryServicesContext.js', 'src/presentation/components/gallery/galleryCardModel.js', 'src/presentation/components/gallery/ImageCard.jsx',
    'src/presentation/components/gallery/RealGalleryView.jsx', 'src/presentation/components/common/RealBadge.jsx', 'src/presentation/pages/GalleryPage.jsx'];
  for (const f of [...pfiles, 'src/app/createGalleryServices.js']) {
    const code = sstrip(read(f)); const n = path.basename(f);
    check(`mã nguồn ${n}/không console.*, storage, cookie, X-User-Id, fetch, XHR, Cloudinary uploader`, !/console\.|localStorage|sessionStorage|document\.cookie|x-user-id|\bfetch\s*\(|XMLHttpRequest|cloudinaryUploader|api\.cloudinary\.com/i.test(code));
    check(`mã nguồn ${n}/không import Firebase/Firestore`, importsOf(code).every((i) => !/firebase|firestore/i.test(i)));
    check(`mã nguồn ${n}/không có ownerId/uid trong chuỗi query`, !/[?&](ownerId|uid)=/.test(code));
  }
  for (const f of pfiles) {
    check(`mã nguồn ${path.basename(f)}/Presentation không import Infrastructure hay API client trực tiếp`, importsOf(sstrip(read(f))).every((i) => !/infrastructure\/(api|firebase|cloudinary)/.test(i)));
  }
  const ctrlCode = sstrip(read('src/presentation/hooks/galleryListController.js'));
  check('mã nguồn controller/không import React', importsOf(ctrlCode).every((i) => i !== 'react' && !i.startsWith('react/')));
  const hookCode = sstrip(read('src/presentation/hooks/useGalleryList.js'));
  check('mã nguồn useGalleryList/dùng useSyncExternalStore, không setState trong effect, không useEffect', /useSyncExternalStore/.test(hookCode) && !/useEffect|setState|useState/.test(hookCode));
  const cardCode = sstrip(read('src/presentation/components/gallery/ImageCard.jsx'));
  check('mã nguồn ImageCard/<img> có alt, lazy, no-referrer, onError -> placeholder; chỉ dùng model.previewUrl', /<img[\s\S]*?alt=\{model\.name\}[\s\S]*?loading="lazy"[\s\S]*?referrerPolicy="no-referrer"[\s\S]*?onError=/.test(cardCode) && /src=\{model\.previewUrl\}/.test(cardCode));
  const pageCode = sstrip(read('src/presentation/pages/GalleryPage.jsx'));
  check('mã nguồn GalleryPage/giữ useImageList + mockImageService cho nhánh MOCK, mặc định MOCK khi không phải real/invalid', /useImageList/.test(pageCode) && /MockGalleryPage/.test(pageCode) && /mode === 'real'/.test(pageCode) && /mode === 'invalid'/.test(pageCode));
  check('mã nguồn GalleryPage/không đọc import.meta.env hay cấu hình (chỉ nhận services qua context)', !/import\.meta|VITE_/.test(pageCode));
  const svcCode = sstrip(read('src/app/createGalleryServices.js'));
  check('mã nguồn createGalleryServices/REAL cần isDev === true, localhost, Firebase auth thật; không fallback MOCK từ invalid', /isDev !== true/.test(svcCode) && /LOCAL_HOSTS/.test(svcCode) && /authMode !== 'firebase'/.test(svcCode) && !/mode:\s*GALLERY_MODE\.MOCK[\s\S]{0,80}invalid/.test(svcCode));
  const mainCode = sstrip(read('src/main.jsx'));
  check('mã nguồn main.jsx/nối GalleryServicesContext qua createGalleryServices({ authServices }); không đụng createBackendServices/Cloudinary', /createGalleryServices\(\{ authServices \}\)/.test(mainCode) && /GalleryServicesContext\.Provider/.test(mainCode) && !/createBackendServices|createCloudinaryServices|backendClient/.test(mainCode) && /createUploadServices/.test(mainCode));
  const upload = sstrip(read('src/presentation/pages/UploadPage.jsx')) + sstrip(read('src/presentation/hooks/useUploadFlow.js')) + sstrip(read('src/app/createUploadServices.js'));
  check('UploadPage H4A/không import Gallery, vẫn chỉ dùng MOCK', !/galleryListController|useGalleryList|GalleryServices|createGalleryServices|listGalleryImages/.test(upload) && !/createBackendServices|backendClient/.test(upload));
  check('CSS/có kiểu cho nhãn thật, ảnh thẻ, nút tải thêm', /\.real-badge/.test(read('src/styles/index.css')) && /\.image-card__img/.test(read('src/styles/index.css')) && /\.gallery-more/.test(read('src/styles/index.css')));
  check('.env.example/ghi VITE_GALLERY_MODE=mock mặc định', /^VITE_GALLERY_MODE=mock$/m.test(read('.env.example')));
  check('mạng thật/0 lần gọi fetch/XHR toàn cục trong toàn bộ test', globalNetCalls === netBefore, String(globalNetCalls));
  check('console không bị ghi token hay header Authorization', logged.every((l) => !/TOKEN-|Bearer/.test(l)), logged.join(' | ').slice(0, 120));
} finally {
  await server.close();
}

out(`PASSED: ${passed}`);
out(`FAILED: ${failures.length}`);
failures.forEach((f) => out('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
