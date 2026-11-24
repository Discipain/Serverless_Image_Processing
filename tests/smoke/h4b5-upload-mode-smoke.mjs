// Smoke test H4B-5 — kết nối Signed Upload vào trang Upload: chọn MOCK/REAL (VITE_UPLOAD_MODE), Provider, controller (single-flight, retry thủ công,
// Retry-After, bắt đầu lại, hủy, đổi UID/đăng xuất), giao diện (SSR) và các điều kiện bảo mật.
// KHÔNG gọi mạng thật: fetch/XMLHttpRequest toàn cục là BẪY; REAL chạy qua Dependency Injection với Backend GIẢ, Cloudinary GIẢ, auth GIẢ
// (tests/smoke/h4b4-harness.mjs). Bản thân bài này KHÔNG chứng minh tích hợp với Backend/Cloudinary/Firebase thật (xem H4B-6).
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/h4b5-upload-mode-smoke.mjs .  (xem tests/README.md)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { CLOUD, UUID, counterIds, createFakeAuth, createFakeBackend, createFakeCloud, fakeProcessor, jpeg, settle, tick } from './h4b4-harness.mjs';

const root = path.resolve(process.argv[2]);
const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => (ok ? (passed += 1) : failures.push(`${name}${detail ? ` — ${detail}` : ''}`));
const out = (s) => process.stdout.write(s + '\n');

// ---------- Bẫy mạng toàn cục ----------
const netCalls = [];
globalThis.fetch = (...a) => { netCalls.push(['fetch', String(a[0])]); throw new Error('KHÔNG được gọi fetch thật'); };
globalThis.XMLHttpRequest = class { constructor() { netCalls.push(['XMLHttpRequest']); throw new Error('KHÔNG được dùng XMLHttpRequest thật'); } };
const consoleLines = [];
for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = (...a) => consoleLines.push(a.map(String).join(' '));

const nativeImport = (spec) => import(pathToFileURL(path.join(root, 'node_modules', spec)).href);
const reactMod = await nativeImport('react/index.js'); const React = reactMod.default ?? reactMod;
const domServer = await nativeImport('react-dom/server.node.js'); const renderToString = (domServer.default ?? domServer).renderToString ?? domServer.renderToString;
const Router = await nativeImport('react-router/dist/production/index.js');
const h = React.createElement;
const strip = (html) => html.replace(/<!--.*?-->/g, '');

const baseOptions = (envDir) => ({ root, envDir, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] } });
/** Chạy `fn(server)` với Vite nạp .env TẠM có đúng các dòng `lines` (rỗng = không biến nào). */
async function withEnv(lines, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'h4b5-env-'));
  fs.writeFileSync(path.join(dir, '.env'), lines.length ? `${lines.join('\n')}\n` : '', 'utf8');
  const server = await createServer(baseOptions(dir));
  try { await fn(server); } finally { await server.close(); fs.rmSync(dir, { recursive: true, force: true }); }
}

// Đồng hồ của "thế giới" giả LUÔN bắt đầu từ giờ hệ thống lúc dựng (không có mốc cố định trong quá khứ). Giao diện (UploadFlowStatus.useRemainingSeconds) đọc
// Date.now() thật nên khi kiểm tra giao diện của một lỗi do thế giới giả tạo ra phải dùng CÙNG đồng hồ đó (withDateNow), không trộn đồng hồ giả với giờ thật.
const startClock = () => Date.now();
// Chạy fn với Date.now() CỐ ĐỊNH ở `at`, luôn khôi phục bằng finally. Chỉ dùng trong phạm vi một lần render; không áp dụng cho cả bộ test.
function withDateNow(at, fn) {
  const real = Date.now;
  Date.now = () => at;
  try {
    return fn();
  } finally {
    Date.now = real;
  }
}
const REAL_ENV = { VITE_UPLOAD_MODE: 'real', VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'http://127.0.0.1:8000', VITE_CLOUDINARY_CLOUD_NAME: CLOUD, VITE_CLOUDINARY_UPLOAD_PRESET: 'unsigned-preset-must-not-be-used' };
const FIREBASE_AUTH_SERVICES = (auth) => ({ mode: 'firebase', isMock: false, useCases: { getIdToken: async () => `token-${auth.uid}`, observeAuthState: auth.observe } });

const server = await createServer(baseOptions(process.env.EMPTY_ENV_DIR));
try {
  const load = (p) => server.ssrLoadModule(p);
  const UM = await load('/src/application/uploadMode.js');
  const { createUploadModeServices, resolveUploadConfig } = await load('/src/app/createUploadModeServices.js');
  const { createUploadServices } = await load('/src/app/createUploadServices.js');
  const { createUploadFlowController } = await load('/src/presentation/hooks/uploadFlowController.js');
  const { initialUploadState, toErrorView, uploadFlowReducer } = await load('/src/presentation/hooks/uploadFlowReducer.js');
  const { UploadFlowStatus } = await load('/src/presentation/components/upload/UploadFlowStatus.jsx');
  const { UploadPage } = await load('/src/presentation/pages/UploadPage.jsx');
  const { UploadServicesContext } = await load('/src/presentation/contexts/UploadServicesContext.js');
  const { remainingSeconds } = await load('/src/presentation/utils/format.js');
  const { SIGNED_UPLOAD_KIND: K } = await load('/src/application/signedUploadErrors.js');
  const { resolveGalleryConfig, createGalleryServices } = await load('/src/app/createGalleryServices.js');

  const authReal = (auth) => FIREBASE_AUTH_SERVICES(auth ?? createFakeAuth('alice'));

  // =====================================================================================================================
  // 1. parseUploadModeSetting
  // =====================================================================================================================
  for (const [raw, expected] of [[undefined, 'mock'], [null, 'mock'], ['', 'mock'], ['   ', 'mock'], ['mock', 'mock'], ['MOCK', 'mock'], [' Mock ', 'mock'], ['real', 'real'], ['REAL', 'real'], [' Real ', 'real'], ['yes', 'invalid'], ['true', 'invalid'], ['reall', 'invalid'], ['mock,real', 'invalid'], ['signed', 'invalid'], ['1', 'invalid'], [1, 'mock']]) {
    check(`parse/${JSON.stringify(raw)} -> ${expected}`, UM.parseUploadModeSetting(raw) === expected);
  }
  check('parse/biến cấu hình tên VITE_UPLOAD_MODE; enum mock|real|invalid', UM.UPLOAD_ENV.mode === 'VITE_UPLOAD_MODE' && Object.values(UM.UPLOAD_MODE).join() === 'mock,real,invalid');

  // =====================================================================================================================
  // 2. resolveUploadConfig (hàm thuần): bảng điều kiện MOCK/REAL
  // =====================================================================================================================
  {
    const ok = { isDev: true, authMode: 'firebase', hasIdToken: true, hasObserveAuth: true };
    const cfg = (env, over = {}) => resolveUploadConfig({ env, ...ok, ...over });
    check('config/1. MOCK mặc định: không biến nào', cfg({}).mode === 'mock' && cfg({}).configError === null);
    check('config/1. MOCK mặc định dù mọi biến REAL khác đã điền (không tự bật REAL)', cfg({ ...REAL_ENV, VITE_UPLOAD_MODE: undefined }).mode === 'mock' && cfg({ VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'http://localhost:8000', VITE_CLOUDINARY_CLOUD_NAME: CLOUD }).mode === 'mock');
    check('config/2. MOCK tường minh', cfg({ VITE_UPLOAD_MODE: 'mock' }).mode === 'mock' && cfg({ VITE_UPLOAD_MODE: ' MOCK ' }).mode === 'mock');
    const real = cfg(REAL_ENV);
    check('config/3. REAL hợp lệ: mode real, có backendConfig + cloudName, không lỗi', real.mode === 'real' && real.configError === null && real.cloudName === CLOUD && real.backendConfig.baseUrl === 'http://127.0.0.1:8000');
    for (const host of ['http://localhost:8000', 'http://127.0.0.1:9000', 'http://[::1]:8000']) check(`config/3. REAL hợp lệ với Backend loopback ${host}`, cfg({ ...REAL_ENV, VITE_API_BASE_URL: host }).mode === 'real');
    check('config/3. REAL không cần (và không dùng) upload preset', cfg({ ...REAL_ENV, VITE_CLOUDINARY_UPLOAD_PRESET: undefined }).mode === 'real' && !JSON.stringify(real).includes('unsigned-preset-must-not-be-used'));
    const bad = (label, r, expectMissing, expectText) => {
      check(`config/${label}: invalid, có lỗi, không dữ liệu REAL`, r.mode === 'invalid' && r.configError && r.backendConfig === null && r.cloudName === null, r.mode);
      if (expectMissing) check(`config/${label}: liệt kê TÊN biến thiếu`, expectMissing.every((m) => r.configError.missing.includes(m)));
      if (expectText) check(`config/${label}: thông báo nêu nguyên nhân`, expectText.test(r.configError.message), r.configError.message);
      check(`config/${label}: thông báo không chứa giá trị cấu hình`, !/127\.0\.0\.1:8000|unsigned-preset|demo-cloud/.test(r.configError.message));
    };
    bad('4. REAL thiếu Backend', cfg({ VITE_UPLOAD_MODE: 'real', VITE_CLOUDINARY_CLOUD_NAME: CLOUD }), ['VITE_BACKEND_MODE', 'VITE_API_BASE_URL'], /VITE_BACKEND_MODE=real/);
    bad('4. REAL với Backend mode mock', cfg({ ...REAL_ENV, VITE_BACKEND_MODE: 'mock' }), ['VITE_BACKEND_MODE']);
    bad('4. REAL thiếu VITE_API_BASE_URL', cfg({ ...REAL_ENV, VITE_API_BASE_URL: '' }), ['VITE_API_BASE_URL']);
    bad('4. REAL Backend cấu hình sai (URL rác)', cfg({ ...REAL_ENV, VITE_API_BASE_URL: 'not a url' }), null, /Backend/);
    bad('5. REAL dùng Backend từ xa (https://api.example.com)', cfg({ ...REAL_ENV, VITE_API_BASE_URL: 'https://api.example.com' }), null, /localhost/);
    bad('5. REAL Backend từ xa (IP LAN)', cfg({ ...REAL_ENV, VITE_API_BASE_URL: 'https://192.168.1.5' }), null, /localhost/);
    bad('6. REAL với Auth MOCK', cfg(REAL_ENV, { authMode: 'mock' }), null, /Firebase Authentication thật/);
    bad('6. REAL với Auth misconfigured', cfg(REAL_ENV, { authMode: 'misconfigured' }), null, /Firebase Authentication thật/);
    bad('6. REAL không có authServices', cfg(REAL_ENV, { authMode: undefined }), null, /Firebase Authentication thật/);
    bad('6. REAL thiếu getIdToken', cfg(REAL_ENV, { hasIdToken: false }), null, /getIdToken|observeAuthState/);
    bad('6. REAL thiếu observeAuthState', cfg(REAL_ENV, { hasObserveAuth: false }), null, /getIdToken|observeAuthState/);
    bad('7. REAL trong production build', cfg(REAL_ENV, { isDev: false }), null, /development/);
    bad('7. REAL isDev không phải true (chuỗi)', cfg(REAL_ENV, { isDev: 'true' }), null, /development/);
    bad('8. Mode không hợp lệ (yes)', cfg({ ...REAL_ENV, VITE_UPLOAD_MODE: 'yes' }), ['VITE_UPLOAD_MODE'], /không hợp lệ/);
    bad('8. Mode không hợp lệ (reall)', cfg({ ...REAL_ENV, VITE_UPLOAD_MODE: 'reall' }), ['VITE_UPLOAD_MODE']);
    bad('REAL thiếu cloud name', cfg({ ...REAL_ENV, VITE_CLOUDINARY_CLOUD_NAME: '' }), ['VITE_CLOUDINARY_CLOUD_NAME']);
    bad('REAL cloud name sai ký tự', cfg({ ...REAL_ENV, VITE_CLOUDINARY_CLOUD_NAME: 'a/b' }), ['VITE_CLOUDINARY_CLOUD_NAME']);
    const many = cfg({ VITE_UPLOAD_MODE: 'real' }, { isDev: false, authMode: 'mock' });
    check('config/nhiều lỗi cùng lúc được liệt kê hết', /Backend/.test(many.configError.message) && /development/.test(many.configError.message) && /Firebase/.test(many.configError.message) && many.configError.missing.includes('VITE_CLOUDINARY_CLOUD_NAME'));
  }

  // =====================================================================================================================
  // 3. createUploadModeServices
  // =====================================================================================================================
  {
    const netBefore = netCalls.length;
    let mockCreated = 0;
    const mockServices = Object.freeze({ mode: 'mock', isMock: true, notice: null, uploadImage: async () => ({ status: 'DONE' }), scenarios: [], scenario: { get: () => 'normal', set() {} } });
    const createMock = () => { mockCreated += 1; return mockServices; };
    const a = createUploadModeServices({ env: {}, isDev: true, authServices: authReal(), createMockServices: createMock });
    check('services/MOCK mặc định: dùng đúng nhà máy MOCK, không dựng gì của REAL', a === mockServices && mockCreated === 1 && netCalls.length === netBefore);
    const b = createUploadModeServices({ env: { ...REAL_ENV, VITE_UPLOAD_MODE: 'mock' }, isDev: true, authServices: authReal(), createMockServices: createMock });
    check('services/MOCK tường minh dù mọi biến REAL đã điền', b === mockServices && mockCreated === 2);
    check('services/MOCK mà thiếu nhà máy: TypeError (lỗi lập trình)', (() => { try { createUploadModeServices({ env: {}, isDev: true }); return false; } catch (e) { return e instanceof TypeError; } })());

    // invalid: không MOCK, không unsigned, không authorize, không mạng
    for (const [label, env, over] of [
      ['mode lạ', { ...REAL_ENV, VITE_UPLOAD_MODE: 'yes' }, {}],
      ['thiếu Backend', { VITE_UPLOAD_MODE: 'real', VITE_CLOUDINARY_CLOUD_NAME: CLOUD }, {}],
      ['Backend từ xa', { ...REAL_ENV, VITE_API_BASE_URL: 'https://api.example.com' }, {}],
      ['Auth MOCK', REAL_ENV, { authServices: { mode: 'mock', useCases: {} } }],
      ['production build', REAL_ENV, { isDev: false }],
    ]) {
      let xhrMade = 0; let fetched = 0;
      const svc = createUploadModeServices({ env, isDev: true, authServices: authReal(), createMockServices: createMock, fetchImpl: async () => { fetched += 1; throw new Error('x'); }, signedOptions: { uploaderOptions: { createXhr: () => { xhrMade += 1; throw new Error('x'); } } }, ...over });
      const r = await settle(svc.uploadImage({ file: jpeg() }));
      check(`services/invalid (${label}): mode invalid, KHÔNG MOCK, có configError`, svc.mode === 'invalid' && svc.isMock === false && !!svc.configError?.message && mockCreated === 2);
      check(`services/invalid (${label}): upload -> lỗi CONFIG; không authorize, không XHR, không fetch (không unsigned)`, r.error?.code === 'CONFIG' && fetched === 0 && xhrMade === 0 && netCalls.length === netBefore, r.error?.message);
      check(`services/invalid (${label}): không có kịch bản MOCK`, svc.scenarios.length === 0);
    }
  }

  // Thế giới REAL qua DI: Backend giả, Cloudinary giả, auth giả
  function world({ uid = 'alice', ttlMs = 900_000, processor = fakeProcessor(), cloudDelay = 0 } = {}) {
    const clock = { now: startClock() };
    const cloud = createFakeCloud({ clock });
    const backend = createFakeBackend({ clock, cloud, ttlMs });
    const auth = createFakeAuth(uid);
    const ids = counterIds();
    const fetchLog = [];
    const services = createUploadModeServices({
      env: REAL_ENV, isDev: true, authServices: FIREBASE_AUTH_SERVICES(auth), createMockServices: () => { throw new Error('không được dựng MOCK ở REAL'); },
      fetchImpl: async (url, init) => { fetchLog.push(String(url)); return backend.fetch(url, init); },
      signedOptions: { imageProcessor: processor, generateId: ids, uploaderOptions: { createXhr: cloud.newXhr, timeoutMs: 5000 }, now: () => clock.now },
    });
    let user = uid ? { uid } : null;
    const ctl = createUploadFlowController({ services, now: () => clock.now });
    ctl.attach();
    ctl.setOwner(user?.uid ?? null, user);
    const setUser = (next) => { user = next ? { uid: next } : null; auth.set(next); ctl.setOwner(user?.uid ?? null, user); };
    const idle = async (ms = 3000) => { const end = Date.now() + ms; while (ctl.debug.isRunning() && Date.now() < end) await tick(5); };
    const count = (p) => backend.log.filter((l) => l.path.endsWith(p)).length;
    return { clock, cloud, backend, auth, ids, services, ctl, setUser, idle, fetchLog, authorize: () => count('/authorize'), confirm: () => count('/confirm'), state: () => ctl.getSnapshot() };
  }

  // 3b. REAL hợp lệ: chạy trọn luồng qua controller
  {
    const netBefore = netCalls.length;
    const w = world();
    check('services/REAL: mode real, isMock=false, không MOCK, không kịch bản', w.services.mode === 'real' && w.services.isMock === false && w.services.configError === null && w.services.scenarios.length === 0);
    check('services/REAL: dựng xong KHÔNG có request nào (không authorize khi chưa chọn ảnh)', w.backend.log.length === 0 && w.cloud.sent.length === 0 && w.cloud.openCount === 0 && w.fetchLog.length === 0);
    const stages = [];
    const unsub = w.ctl.subscribe(() => { const s = w.state(); if (s.phase === 'running' && stages.at(-1) !== s.stage) stages.push(s.stage); });
    w.ctl.selectFile(jpeg());
    check('ui/chọn ảnh: START ngay, hiện tên và dung lượng ảnh gốc', w.state().phase === 'running' && w.state().fileName === 'anh-bien.jpg' && w.state().fileSize === 2_000_000);
    await w.idle();
    unsub();
    const s = w.state();
    check('ui/13. DONE chỉ sau confirm: phase done, result.status DONE, Backend đã ghi DONE', s.phase === 'done' && s.result.status === 'DONE' && s.result.signed === true && w.backend.images.get(UUID(1))?.status === 'DONE');
    check('ui/11. các stage thực tế: VALIDATING, COMPRESSING, AUTHORIZING, UPLOADING, CONFIRMING (PROCESSING của đề = COMPRESSING)', stages.join() === 'VALIDATING,COMPRESSING,AUTHORIZING,UPLOADING,CONFIRMING', stages.join());
    check('REAL/chỉ MỘT authorize, MỘT confirm, 3 upload; Bearer tới Backend, 0 header tới Cloudinary', w.authorize() === 1 && w.confirm() === 1 && w.cloud.sent.length === 3 && w.cloud.sent.every((x) => Object.keys(x.headers).length === 0));
    check('REAL/không gửi upload preset (dù env có preset), không unsigned', w.cloud.sent.every((x) => !x.entries.some(([k, v]) => /preset/.test(k) || /unsigned-preset/.test(String(v)))));
    check('REAL/không request mạng thật', netCalls.length === netBefore);
    check('REAL/không lưu session sau DONE (bộ nhớ dọn sạch)', !w.ctl.debug.hasSession() && !w.ctl.debug.hasRestart() && !w.ctl.debug.isRunning());
    w.ctl.detach?.();
  }

  // 3c. signedOptions không ghi đè được cấu hình đã kiểm tra
  {
    const clock = { now: startClock() }; const cloud = createFakeCloud({ clock }); const backend = createFakeBackend({ clock, cloud });
    const auth = createFakeAuth('alice');
    const svc = createUploadModeServices({
      env: REAL_ENV, isDev: true, authServices: FIREBASE_AUTH_SERVICES(auth), createMockServices: () => ({}), fetchImpl: backend.fetch,
      signedOptions: { cloudName: 'evil-cloud', imageProcessor: fakeProcessor(), generateId: counterIds(), uploaderOptions: { createXhr: cloud.newXhr }, now: () => clock.now },
    });
    const r = await settle(svc.uploadImage({ file: jpeg() }));
    check('services/REAL: signedOptions KHÔNG ghi đè cloud name đã kiểm tra (endpoint vẫn là cloud cấu hình)', r.value?.status === 'DONE' && cloud.sent.every((x) => x.endpoint === `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`), r.error?.message);
  }

  // =====================================================================================================================
  // 4. Controller thuần (dịch vụ giả có kiểm soát)
  // =====================================================================================================================
  const appError = (code, details = {}, message = 'lỗi') => Object.assign(new Error(message), { code, details });
  function deferredServices() {
    const calls = [];
    return {
      calls,
      uploadImage(args) {
        const call = { args, signal: args.signal };
        call.promise = new Promise((resolve, reject) => { call.resolve = resolve; call.reject = reject; });
        calls.push(call);
        return call.promise;
      },
    };
  }
  const outcome = (id = 'img-1') => ({ imageId: id, status: 'DONE', confirm: {}, assets: {}, processed: { blobs: {} }, file: { name: 'a.jpg', size: 1 } });
  const mk = (over = {}) => {
    const svc = deferredServices(); const clock = { now: 1_000_000 };
    const ctl = createUploadFlowController({ services: svc, now: () => clock.now, ...over });
    const detach = ctl.attach(); const user = { uid: 'alice' }; ctl.setOwner('alice', user);
    return { svc, ctl, clock, detach, user };
  };
  const file = (name = 'a.jpg') => ({ name, size: 12345, type: 'image/jpeg' });

  {
    // single-flight (22)
    const { svc, ctl } = mk();
    ctl.selectFile(file()); ctl.selectFile(file()); ctl.selectFile(file('b.jpg'));
    check('single-flight/bấm chọn file liên tục: chỉ MỘT lần uploadImage', svc.calls.length === 1 && ctl.getSnapshot().fileName === 'a.jpg');
    check('single-flight/Thử lại và Bắt đầu lại bị bỏ qua khi đang chạy', ctl.retry() === undefined && ctl.restart() === undefined && svc.calls.length === 1);
    svc.calls[0].resolve(outcome());
    await tick(1);
    check('single-flight/sau khi xong: DONE và cho phép lần mới', ctl.getSnapshot().phase === 'done');
    ctl.selectFile(file('c.jpg'));
    check('single-flight/lần mới sau DONE chạy bình thường', svc.calls.length === 2 && ctl.getSnapshot().fileName === 'c.jpg');
  }
  {
    // DONE chỉ sau khi dịch vụ trả về; stage/progress qua callback
    const { svc, ctl } = mk();
    ctl.selectFile(file());
    check('flow/đang chạy: chưa DONE trước khi dịch vụ trả về', ctl.getSnapshot().phase === 'running' && ctl.getSnapshot().result === null);
    svc.calls[0].args.onStage({ stage: 'AUTHORIZING', imageId: 'img-1', variants: { thumbnail: { bytes: 10, width: 200, height: 150 }, medium: { bytes: 20, width: 800, height: 600 }, webp: { bytes: 30, width: 4000, height: 3000 } } });
    check('flow/stage AUTHORIZING + imageId + kết quả xử lý biến thể được ghi vào state', ctl.getSnapshot().stage === 'AUTHORIZING' && ctl.getSnapshot().imageId === 'img-1' && ctl.getSnapshot().variants.medium.bytes === 20);
    svc.calls[0].args.onStage({ stage: 'UPLOADING', imageId: 'img-1' });
    svc.calls[0].args.onProgress({ variant: 'medium', variantPercent: 40, overallPercent: 55 });
    check('flow/tiến độ upload được ghi (variant, %, tổng %)', ctl.getSnapshot().progress.overallPercent === 55 && ctl.getSnapshot().progress.variant === 'medium' && ctl.getSnapshot().variants !== null);
    svc.calls[0].reject(appError('NETWORK', { stage: 'UPLOADING', retryable: true, session: { imageId: 'img-1' }, imageId: 'img-1', uploadedVariants: ['thumbnail'] }, 'mạng'));
    await tick(1);
    check('flow/lỗi: phase error, KHÔNG DONE', ctl.getSnapshot().phase === 'error' && ctl.getSnapshot().result === null && ctl.getSnapshot().error.retryable === true);
  }
  {
    // retry thủ công dùng session; Retry-After countdown; hết giờ không tự request (16, 17, 18)
    const { svc, ctl, clock } = mk();
    ctl.selectFile(file());
    const sessionObj = { imageId: 'img-1', marker: 'S1' };
    svc.calls[0].reject(appError('QUOTA_EXCEEDED', { stage: 'CONFIRMING', retryable: true, session: sessionObj, imageId: 'img-1', retryAfterSeconds: 120, kind: K.RATE_LIMITED }, 'quá nhanh'));
    await tick(1);
    const err = ctl.getSnapshot().error;
    check('retry-after/state có retryAfterSeconds=120 và mốc retryNotBefore = now + 120s', err.retryAfterSeconds === 120 && err.retryNotBefore === clock.now + 120_000 && ctl.debug.retryNotBefore() === clock.now + 120_000);
    check('retry-after/retry() trong thời gian chờ bị CHẶN (không chỉ nút), không gọi dịch vụ', ctl.retry() === undefined && svc.calls.length === 1 && ctl.getSnapshot().phase === 'error');
    clock.now += 119_999;
    check('retry-after/còn 1ms vẫn chặn', ctl.retry() === undefined && svc.calls.length === 1);
    clock.now += 5_000;
    await tick(30);
    check('retry-after/qua mốc: KHÔNG tự gửi request (vẫn 1 lần gọi)', svc.calls.length === 1 && ctl.getSnapshot().phase === 'error');
    ctl.retry();
    check('retry-after/người dùng bấm sau mốc: retry dùng ĐÚNG session cũ, cùng imageId, không file mới', svc.calls.length === 2 && svc.calls[1].args.session === sessionObj && svc.calls[1].args.file === undefined);
    check('retry/state chuyển running (RESUME): xóa lỗi cũ, giữ tên file và imageId', ctl.getSnapshot().phase === 'running' && ctl.getSnapshot().error === null && ctl.getSnapshot().fileName === 'a.jpg');
    svc.calls[1].resolve(outcome());
    await tick(1);
    check('retry-after/retry thành công -> DONE; mốc đếm ngược được xóa', ctl.getSnapshot().phase === 'done' && ctl.debug.retryNotBefore() === 0);
  }
  {
    // upload một phần / confirm lỗi giữ session: retry hai lần liên tiếp sau lỗi lại dùng session MỚI
    const { svc, ctl } = mk();
    ctl.selectFile(file());
    svc.calls[0].reject(appError('NETWORK', { stage: 'UPLOADING', retryable: true, session: { n: 1 }, imageId: 'i', uploadedVariants: ['thumbnail'] }));
    await tick(1);
    ctl.retry();
    svc.calls[1].reject(appError('NETWORK', { stage: 'CONFIRMING', retryable: true, session: { n: 2 }, imageId: 'i', uploadedVariants: ['thumbnail', 'medium', 'webp'] }));
    await tick(1);
    ctl.retry();
    check('retry/mỗi lần thử lại dùng session MỚI NHẤT mà lỗi trước mang theo', svc.calls[1].args.session.n === 1 && svc.calls[2].args.session.n === 2);
    // double click Retry
    svc.calls[2].reject(appError('NETWORK', { stage: 'CONFIRMING', retryable: true, session: { n: 3 }, imageId: 'i' }));
    await tick(1);
    ctl.retry(); ctl.retry(); ctl.retry();
    check('retry/bấm Thử lại liên tục: chỉ MỘT lần gọi', svc.calls.length === 4);
  }
  {
    // lỗi không retry được: không có session; retry() no-op
    const { svc, ctl } = mk();
    ctl.selectFile(file());
    svc.calls[0].reject(appError('UPDATE', { stage: 'CONFIRMING', retryable: false, kind: K.ASSETS_MISMATCH, newSessionRequired: true, imageId: 'i' }));
    await tick(1);
    const e = ctl.getSnapshot().error;
    check('409 không retry: retryable=false, restartable=false (không có restartFile), không session', e.retryable === false && e.restartable === false && !ctl.debug.hasSession() && ctl.retry() === undefined && svc.calls.length === 1);
  }
  {
    // grant hết hạn -> Bắt đầu lại với imageId mới (19, 20)
    const { svc, ctl, user } = mk();
    const f = file('goc.jpg');
    ctl.selectFile(f);
    svc.calls[0].reject(appError('UPLOAD_FAILED', { stage: 'UPLOADING', retryable: false, newSessionRequired: true, kind: K.GRANT_EXPIRED, imageId: 'img-old', restartFile: f, uploadedVariants: ['thumbnail', 'medium'] }));
    await tick(1);
    const e = ctl.getSnapshot().error;
    check('hết hạn/lỗi: restartable, KHÔNG retryable, không session', e.restartable === true && e.retryable === false && e.newSessionRequired === true && e.kind === K.GRANT_EXPIRED && !ctl.debug.hasSession() && ctl.debug.hasRestart());
    check('hết hạn/retry() không làm gì; KHÔNG tự tạo session mới', ctl.retry() === undefined && svc.calls.length === 1);
    ctl.restart();
    check('hết hạn/Bắt đầu lại: gọi uploadImage với CHÍNH file đó, KHÔNG session (=> imageId mới do use case sinh)', svc.calls.length === 2 && svc.calls[1].args.file === f && svc.calls[1].args.session === undefined);
    check('hết hạn/Bắt đầu lại: state mới (START), imageId cũ bị xóa', ctl.getSnapshot().phase === 'running' && ctl.getSnapshot().imageId === null && ctl.getSnapshot().fileName === 'goc.jpg');
    svc.calls[1].reject(appError('NETWORK', { stage: 'COMPRESSING', retryable: false, imageId: 'img-new' }));
    await tick(1);
    check('hết hạn/restartFile chỉ dùng MỘT lần', ctl.restart() === undefined && svc.calls.length === 2);
    void user;
  }
  {
    // restart bị chặn khi đổi phiên đăng nhập
    const { svc, ctl } = mk();
    const f = file();
    ctl.selectFile(f);
    svc.calls[0].reject(appError('UPLOAD_FAILED', { stage: 'UPLOADING', newSessionRequired: true, kind: K.GRANT_EXPIRED, restartFile: f }));
    await tick(1);
    ctl.setOwner('bob', { uid: 'bob' });
    check('restart/đổi người dùng: state rỗng, restart bị xóa, không dùng được file của alice', ctl.getSnapshot() === initialUploadState && !ctl.debug.hasRestart() && ctl.restart() === undefined && svc.calls.length === 1);
  }
  {
    // cancel (21)
    const { svc, ctl } = mk();
    ctl.selectFile(file());
    svc.calls[0].args.onStage({ stage: 'UPLOADING', imageId: 'i' });
    ctl.cancel();
    check('cancel/AbortSignal được kích hoạt', svc.calls[0].signal.aborted === true);
    svc.calls[0].reject(appError('CANCELLED', { stage: 'UPLOADING', retryable: true, session: { s: 1 }, imageId: 'i', uploadedVariants: ['thumbnail'] }));
    await tick(1);
    check('cancel/kết thúc ở phase error CANCELLED, giữ session, retry được', ctl.getSnapshot().error.code === 'CANCELLED' && ctl.getSnapshot().error.retryable === true && ctl.debug.hasSession());
    ctl.retry();
    check('cancel/thử lại tiếp tục bằng session cũ', svc.calls[1].args.session.s === 1);
    ctl.cancel();
    ctl.cancel();
    check('cancel/hủy nhiều lần vô hại', svc.calls[1].signal.aborted === true && svc.calls.length === 2);
  }
  {
    // đổi UID / logout / login lại cùng UID / response muộn (24, 25, 26)
    const { svc, ctl, user } = mk();
    ctl.selectFile(file());
    svc.calls[0].args.onStage({ stage: 'UPLOADING', imageId: 'i' });
    ctl.setOwner('bob', { uid: 'bob' });
    check('đổi UID A->B: hủy ngay (signal aborted), state về rỗng', svc.calls[0].signal.aborted === true && ctl.getSnapshot() === initialUploadState && !ctl.debug.isRunning());
    svc.calls[0].resolve(outcome('late'));
    await tick(5);
    check('đổi UID: response DONE muộn của alice bị BỎ QUA (bob không thấy gì)', ctl.getSnapshot() === initialUploadState && ctl.getSnapshot().result === null);
    ctl.selectFile(file('b.jpg'));
    check('đổi UID: bob bắt đầu phiên mới bình thường', svc.calls.length === 2 && ctl.getSnapshot().fileName === 'b.jpg');
    svc.calls[1].args.onProgress({ variant: 'x', variantPercent: 1, overallPercent: 1 });
    svc.calls[0].args.onProgress({ variant: 'old', variantPercent: 99, overallPercent: 99 });
    svc.calls[0].args.onStage({ stage: 'CONFIRMING', imageId: 'old' });
    check('đổi UID: callback tiến độ/stage muộn của phiên cũ không ghi vào state mới', ctl.getSnapshot().progress?.variant !== 'old' && ctl.getSnapshot().stage !== 'CONFIRMING');
    void user;
  }
  {
    // logout rồi login lại CÙNG UID: phiên đăng nhập mới không tự tiếp tục việc đã hủy
    const { svc, ctl } = mk();
    ctl.selectFile(file());
    ctl.setOwner(null, null); // đăng xuất
    check('logout: hủy, xóa sạch', svc.calls[0].signal.aborted === true && ctl.getSnapshot() === initialUploadState && !ctl.debug.hasSession());
    ctl.setOwner('alice', { uid: 'alice' }); // đăng nhập lại cùng UID (đối tượng phiên mới)
    svc.calls[0].reject(appError('CANCELLED', { stage: 'UPLOADING', retryable: true, session: { s: 'old' } }));
    await tick(10);
    check('logout -> login lại cùng UID: KHÔNG tự tiếp tục, KHÔNG retry bằng session cũ, state rỗng', svc.calls.length === 1 && ctl.getSnapshot() === initialUploadState && ctl.retry() === undefined);
    const { svc: s2, ctl: c2 } = mk();
    c2.selectFile(file());
    c2.setOwner('alice', { uid: 'alice' }); // CÙNG uid nhưng đối tượng phiên khác (đăng nhập lại nhanh, không thấy null)
    check('cùng UID nhưng phiên đăng nhập mới (không qua null): vẫn HỦY (không chỉ so UID cuối)', s2.calls[0].signal.aborted === true && c2.getSnapshot() === initialUploadState);
    const { svc: s3, ctl: c3, user: u3 } = mk();
    c3.selectFile(file());
    c3.setOwner('alice', u3);
    check('cùng phiên (cùng UID, cùng đối tượng): KHÔNG hủy (StrictMode/effect lặp)', s3.calls[0].signal.aborted === false && c3.debug.isRunning());
  }
  {
    // StrictMode: attach/detach/attach, setOwner lặp, không gọi lặp (23)
    const svc = deferredServices();
    const ctl = createUploadFlowController({ services: svc });
    const user = { uid: 'alice' };
    const d1 = ctl.attach(); ctl.setOwner('alice', user);
    d1(); // cleanup mô phỏng của StrictMode
    ctl.attach(); ctl.setOwner('alice', user); ctl.setOwner('alice', user);
    check('StrictMode/attach-detach-attach + setOwner lặp: không upload, không authorize, không đổi state', svc.calls.length === 0 && ctl.getSnapshot() === initialUploadState && ctl.debug.isAttached());
    ctl.selectFile(file());
    check('StrictMode/sau đó chọn file: đúng MỘT lần gọi', svc.calls.length === 1);
    const detach = ctl.debug.isAttached() && ctl.attach();
    detach();
    check('unmount thật: detach hủy lần chạy đang có', svc.calls[0].signal.aborted === true && !ctl.debug.isRunning());
  }
  {
    // reset + toErrorView an toàn
    const { svc, ctl } = mk();
    ctl.selectFile(file());
    svc.calls[0].reject(appError('NETWORK', { stage: 'CONFIRMING', retryable: true, session: { signature: 'SIG', authorization: { uploads: { webp: { fields: { signature: 'a'.repeat(64) } } } } }, imageId: 'i', retryAfterSeconds: 30, restartFile: file(), cause: { details: { token: 'Bearer abc' } } }, 'x'));
    await tick(1);
    const dumped = JSON.stringify(ctl.getSnapshot());
    check('27. state giao diện KHÔNG chứa session, chữ ký, token, file, cause', !/SIG|signature|Bearer|authorization|restartFile|a{30}|token/i.test(dumped), dumped.slice(0, 200));
    ctl.reset();
    check('reset/xóa state, session, restart, mốc đếm ngược', ctl.getSnapshot() === initialUploadState && !ctl.debug.hasSession() && ctl.debug.retryNotBefore() === 0);
    const v = toErrorView(appError('NETWORK', { retryAfterSeconds: 0 }), { now: 5 });
    check('toErrorView/Retry-After không dương -> không có mốc', v.retryAfterSeconds === null && v.retryNotBefore === null);
    check('toErrorView/Retry-After hợp lệ -> mốc = now + giây*1000', toErrorView(appError('NETWORK', { retryAfterSeconds: 7 }), { now: 1000 }).retryNotBefore === 8000);
    check('toErrorView/mặc định giữ hành vi cũ (retryable chỉ khi có session)', toErrorView(appError('NETWORK', { retryable: true })).retryable === false);
    check('reducer/START ghi fileSize; không phải số -> null', uploadFlowReducer(initialUploadState, { type: 'START', fileName: 'a', fileSize: 5 }).fileSize === 5 && uploadFlowReducer(initialUploadState, { type: 'START', fileName: 'a', fileSize: 'x' }).fileSize === null);
  }

  // =====================================================================================================================
  // 5. Controller + dịch vụ REAL (Backend/Cloudinary/auth giả) — các tình huống end-to-end ở tầng Application
  // =====================================================================================================================
  {
    // 14. lỗi authorize
    const w = world();
    w.backend.faults.authorize.push({ status: 503, detail: 'Signed upload unavailable' });
    w.ctl.selectFile(jpeg()); await w.idle();
    const e = w.state().error;
    check('real/14. lỗi authorize (Backend tắt signed): state error AUTHORIZING/SIGNED_UNAVAILABLE, không retry, KHÔNG upload', w.state().phase === 'error' && e.stage === 'AUTHORIZING' && e.kind === K.SIGNED_UNAVAILABLE && e.retryable === false && w.cloud.sent.length === 0 && w.confirm() === 0);
    check('real/10. không fallback MOCK/unsigned khi authorize lỗi', w.cloud.openCount === 0 && w.fetchLog.every((u) => /\/images\/cloudinary\/authorize$/.test(u)));
    const w2 = world();
    w2.backend.faults.authorize.push({ status: 429, detail: 'Too many upload authorizations', headers: { 'Retry-After': '90' } });
    w2.ctl.selectFile(jpeg()); await w2.idle();
    check('real/17. authorize 429 + Retry-After=90: retryAfterSeconds=90, retryNotBefore, retry bị chặn', w2.state().error.retryAfterSeconds === 90 && w2.ctl.retry() === undefined && w2.authorize() === 1);
    w2.clock.now += 91_000; await tick(20);
    check('real/18. hết đếm ngược KHÔNG tự authorize lại', w2.authorize() === 1 && w2.state().phase === 'error');
    w2.ctl.retry(); await w2.idle();
    check('real/16. người dùng bấm sau đếm ngược: authorize lại cùng imageId rồi DONE', w2.state().phase === 'done' && w2.state().result.imageId === UUID(1) && w2.authorize() === 2);
  }
  {
    // 15. upload một phần
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), network: true });
    w.ctl.selectFile(jpeg()); await w.idle();
    const e = w.state().error;
    check('real/15. upload một phần: UPLOADING, retryable, đã có thumbnail, authorize 1 lần', e.stage === 'UPLOADING' && e.retryable === true && e.uploadedVariants.join() === 'thumbnail' && w.authorize() === 1);
    w.ctl.retry(); await w.idle();
    check('real/15. retry: chỉ upload biến thể còn thiếu (thumb không lặp), cùng imageId, không authorize lại, DONE', w.state().phase === 'done' && w.cloud.sent.map((s) => s.publicId.split('/').pop()).join() === 'thumb,medium,medium,full' && w.authorize() === 1 && w.ids.count() === 1);
  }
  {
    // 16. retry confirm (503 sau commit, mất phản hồi)
    const w = world();
    w.backend.faults.confirm.push({ afterCommit: true, status: 503, detail: 'Storage unavailable' });
    w.ctl.selectFile(jpeg()); await w.idle();
    check('real/16. confirm 503 sau commit: CONFIRMING retryable; Backend đã ghi DONE nhưng UI KHÔNG hiện DONE', w.state().phase === 'error' && w.state().error.stage === 'CONFIRMING' && w.state().error.retryable === true && w.backend.images.get(UUID(1))?.status === 'DONE' && w.state().result === null);
    const uploads = w.cloud.sent.length; const auths = w.authorize();
    w.ctl.retry(); await w.idle();
    check('real/16. retry confirm: cùng imageId, KHÔNG upload lại, KHÔNG authorize/grant mới, DONE (idempotent)', w.state().phase === 'done' && w.cloud.sent.length === uploads && w.authorize() === auths && w.confirm() === 2 && w.backend.grants.size === 1);
    const w2 = world();
    w2.backend.faults.confirm.push({ status: 409, detail: 'Uploaded assets not found' });
    w2.ctl.selectFile(jpeg()); await w2.idle();
    check('real/D. 409 assets not found: cho phép retry THỦ CÔNG, không tự gọi lại', w2.state().error.retryable === true && w2.state().error.kind === K.ASSETS_NOT_FOUND && w2.confirm() === 1);
    await tick(30);
    check('real/D. không có request ngầm sau 409 assets not found', w2.confirm() === 1);
    w2.ctl.retry(); await w2.idle();
    check('real/D. bấm thử lại -> DONE', w2.state().phase === 'done' && w2.confirm() === 2);
    const w3 = world();
    w3.backend.faults.confirm.push({ status: 409, detail: 'Uploaded assets do not match the upload grant' });
    w3.ctl.selectFile(jpeg()); await w3.idle();
    check('real/E. 409 không retry được: không retryable, không nút thử lại; chỉ chọn ảnh khác', w3.state().error.retryable === false && w3.state().error.restartable === true && w3.confirm() === 1);
  }
  {
    // 19, 20. grant hết hạn khi confirm -> restart
    const w = world();
    w.backend.faults.confirm.push({ status: 409, detail: 'Upload grant expired' });
    w.ctl.selectFile(jpeg()); await w.idle();
    const e = w.state().error;
    check('real/19. grant hết hạn khi confirm: GRANT_EXPIRED, restartable, không retryable, không auto-retry', e.kind === K.GRANT_EXPIRED && e.restartable === true && e.retryable === false && w.confirm() === 1);
    w.ctl.retry();
    check('real/19. retry() không có tác dụng', w.confirm() === 1 && w.authorize() === 1);
    w.ctl.restart(); await w.idle();
    check('real/20. Bắt đầu lại: imageId MỚI, grant mới, DONE; imageId cũ không được xác nhận', w.state().phase === 'done' && w.state().result.imageId === UUID(2) && w.backend.grants.size === 2 && !w.backend.images.has(UUID(1)));
    check('real/20. không xóa asset đã upload (không có request xóa, asset cũ còn trong Cloudinary giả)', w.cloud.assets.size === 6 && w.cloud.sent.every((s) => s.method === 'POST'));
  }
  {
    // 24/26. đổi UID trong từng giai đoạn
    const stagesToTry = [
      ['AUTHORIZING', (w) => { w.backend.fetchDelay = 30; }],
      ['UPLOADING', (w) => { w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), delayMs: 40 }); }],
      ['CONFIRMING', (w) => { w.backend.faults.confirm.push({ afterCommit: true, status: 200, detail: 'x', delay: 40 }); }],
    ];
    for (const [stage] of stagesToTry) {
      const w = world();
      const origFetch = w.services; void origFetch;
      // làm chậm giai đoạn cần thử bằng cách bọc fetch của Backend
      const realFetch = w.backend.fetch;
      const slowPath = stage === 'AUTHORIZING' ? '/authorize' : stage === 'CONFIRMING' ? '/confirm' : null;
      w.backend.fetch = async (url, init) => { if (slowPath && String(url).endsWith(slowPath)) { const res = await realFetch(url, init); await tick(60); return res; } return realFetch(url, init); };
      if (stage === 'UPLOADING') w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), delayMs: 60 });
      // dựng lại services dùng fetch đã bọc
      const clock = w.clock;
      const svc = createUploadModeServices({
        env: REAL_ENV, isDev: true, authServices: FIREBASE_AUTH_SERVICES(w.auth), createMockServices: () => ({}), fetchImpl: (u, i) => w.backend.fetch(u, i),
        signedOptions: { imageProcessor: fakeProcessor(), generateId: counterIds(), uploaderOptions: { createXhr: w.cloud.newXhr }, now: () => clock.now },
      });
      const ctl = createUploadFlowController({ services: svc, now: () => clock.now });
      ctl.attach(); let user = { uid: 'alice' }; ctl.setOwner('alice', user);
      ctl.selectFile(jpeg());
      const want = stage;
      for (let i = 0; i < 400 && ctl.getSnapshot().stage !== want; i += 1) await tick(3);
      check(`logout/đổi UID trong ${stage}: (chuẩn bị) đã tới đúng giai đoạn`, ctl.getSnapshot().stage === want, String(ctl.getSnapshot().stage));
      const authBefore = w.backend.log.filter((l) => l.path.endsWith('/authorize')).length;
      const sentBefore = w.cloud.sent.length;
      user = { uid: 'bob' }; w.auth.set('bob'); ctl.setOwner('bob', user);
      await tick(250);
      const confirmedByBackend = w.backend.images.has(UUID(1));
      check(`logout/đổi UID trong ${stage}: UI rỗng, không DONE, không lỗi của alice hiện cho bob`, ctl.getSnapshot() === initialUploadState && !ctl.debug.isRunning() && !ctl.debug.hasSession());
      check(`logout/đổi UID trong ${stage}: không upload biến thể mới/authorize mới sau khi đổi`, w.cloud.sent.length <= sentBefore + (stage === 'UPLOADING' ? 0 : 0) + 1 && w.backend.log.filter((l) => l.path.endsWith('/authorize')).length === authBefore);
      check(`logout/đổi UID trong ${stage}: mọi request Backend dùng token của alice (không bao giờ token của bob)`, w.backend.log.every((l) => l.headers.Authorization === 'Bearer token-alice'));
      if (stage === 'CONFIRMING') check('logout/đổi UID trong CONFIRMING: Backend có thể ĐÃ commit nhưng UI không hiện DONE cho bob (không khẳng định hủy = chưa ghi)', confirmedByBackend === true && ctl.getSnapshot().result === null);
      ctl.attach()(); // detach
    }
  }
  {
    // 25. đăng xuất rồi đăng nhập lại cùng UID giữa upload (qua dịch vụ REAL + guard)
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), delayMs: 60 });
    w.ctl.selectFile(jpeg());
    for (let i = 0; i < 400 && w.state().stage !== 'UPLOADING'; i += 1) await tick(3);
    w.setUser(null);
    await tick(10);
    w.setUser('alice');
    await tick(250);
    check('real/25. logout rồi login lại cùng UID: không tự tiếp tục (không confirm, không DONE), UI rỗng', w.state() === initialUploadState && w.confirm() === 0 && w.cloud.sent.length <= 2);
    check('real/25. sau đó người dùng chọn lại: phiên MỚI (imageId mới) chạy bình thường', (() => { w.ctl.selectFile(jpeg()); return true; })());
    await w.idle();
    check('real/25. phiên mới DONE bằng imageId mới', w.state().phase === 'done' && w.state().result.imageId === UUID(2));
  }
  {
    // 26. response DONE đến sau logout (confirm đã commit, phản hồi bị giữ)
    const w = world();
    const realFetch = w.backend.fetch; let release; const gate = new Promise((r) => { release = r; }); let held = false;
    w.backend.fetch = async (url, init) => { const res = await realFetch(url, init); if (String(url).endsWith('/confirm')) { held = true; await gate; } return res; };
    const clock = w.clock;
    const svc = createUploadModeServices({
      env: REAL_ENV, isDev: true, authServices: FIREBASE_AUTH_SERVICES(w.auth), createMockServices: () => ({}), fetchImpl: (u, i) => w.backend.fetch(u, i),
      signedOptions: { imageProcessor: fakeProcessor(), generateId: counterIds(), uploaderOptions: { createXhr: w.cloud.newXhr }, now: () => clock.now },
    });
    const ctl = createUploadFlowController({ services: svc, now: () => clock.now });
    ctl.attach(); const user = { uid: 'alice' }; ctl.setOwner('alice', user);
    ctl.selectFile(jpeg());
    for (let i = 0; i < 600 && !held; i += 1) await tick(3);
    w.auth.set(null); ctl.setOwner(null, null);
    release();
    await tick(100);
    check('real/26. DONE đến SAU logout bị bỏ qua: UI rỗng, không result', held && ctl.getSnapshot() === initialUploadState && ctl.getSnapshot().result === null && w.backend.images.get(UUID(1))?.status === 'DONE');
  }
  {
    // single-flight + REAL: bấm chọn nhiều lần chỉ một authorize
    const w = world();
    w.ctl.selectFile(jpeg()); w.ctl.selectFile(jpeg()); w.ctl.selectFile(jpeg());
    await w.idle();
    check('real/22. chọn file liên tục: đúng MỘT authorize, MỘT imageId', w.authorize() === 1 && w.ids.count() === 1 && w.state().phase === 'done');
    // 21. hủy trong REAL, rồi thử lại
    const w2 = world();
    w2.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), hang: true });
    w2.ctl.selectFile(jpeg());
    for (let i = 0; i < 400 && w2.cloud.sent.length < 2; i += 1) await tick(3);
    w2.ctl.cancel(); await w2.idle();
    check('real/21. hủy giữa upload: CANCELLED, xhr.abort, không confirm, giữ session', w2.state().error.code === 'CANCELLED' && w2.cloud.sent[1].xhr.aborted === true && w2.confirm() === 0 && w2.ctl.debug.hasSession());
    w2.ctl.retry(); await w2.idle();
    check('real/21. thử lại sau hủy: DONE, cùng imageId, thumbnail không upload lại', w2.state().phase === 'done' && w2.state().result.imageId === UUID(1) && w2.cloud.sent.map((s) => s.publicId.split('/').pop()).join() === 'thumb,medium,medium,full');
  }

  // =====================================================================================================================
  // 6. Giao diện (SSR)
  // =====================================================================================================================
  {
    const noop = () => {};
    const R = (mode, state, extra = {}) => strip(renderToString(h(Router.MemoryRouter, { initialEntries: ['/upload'] }, h(UploadFlowStatus, { state, mode, onRetry: noop, onRestart: noop, onCancel: noop, onReset: noop, ...extra }))));
    const base = { ...initialUploadState, phase: 'running', fileName: 'a.jpg', fileSize: 2_000_000, imageId: 'id-x' };
    let v = R('real', { ...base, stage: 'AUTHORIZING' });
    check('ui/11. AUTHORIZING hiển thị "Đang xin quyền tải ảnh lên…" + nhãn REAL + nút Hủy', v.includes('Đang xin quyền tải ảnh lên') && v.includes('real-badge') && !v.includes('mock-badge') && v.includes('Hủy'));
    check('ui/ảnh được chọn + dung lượng ảnh gốc hiển thị', v.includes('a.jpg') && /1,9\s?MB|1\.9\s?MB|1,91|1\.91|MB/.test(v) && v.includes('(ảnh gốc)'));
    v = R('real', { ...base, stage: 'UPLOADING', progress: { variant: 'medium', variantPercent: 40, overallPercent: 55 }, variants: { thumbnail: { bytes: 1000, width: 200, height: 150 }, medium: { bytes: 20000, width: 800, height: 600 }, webp: { bytes: 300000, width: 4000, height: 3000 } } });
    check('ui/12. tiến độ upload REAL: <progress value=55>, không chữ "giả lập"/MOCK', v.includes('<progress') && v.includes('value="55"') && v.includes('Tiến độ upload: 55%') && !/giả lập|MOCK/.test(v));
    check('ui/kết quả xử lý biến thể (dung lượng + kích thước) hiển thị', v.includes('200×150') && v.includes('800×600') && v.includes('4000×3000'));
    v = R('real', { ...base, stage: 'CONFIRMING' });
    check('ui/CONFIRMING REAL: "Đang chờ Backend xác nhận ảnh", có Hủy', v.includes('Đang chờ Backend xác nhận ảnh') && v.includes('Hủy'));
    v = R('real', { ...base, stage: 'COMPRESSING' });
    check('ui/COMPRESSING REAL: không có Hủy', v.includes('Đang nén') && !v.includes('Hủy'));
    // MOCK giữ nguyên
    v = R('mock', { ...base, stage: 'UPLOADING', progress: { variant: 'medium', variantPercent: 40, overallPercent: 55 } });
    check('ui/MOCK giữ nguyên chữ giả lập + nhãn MOCK', v.includes('Tiến độ giả lập (MOCK)') && v.includes('mock-badge') && !v.includes('real-badge'));
    v = R(undefined, { ...base, stage: 'AUTHORIZING' });
    check('ui/mode mặc định (không truyền) là MOCK', v.includes('mock-badge') && !v.includes('Đang xin quyền'));

    const err = (over) => ({ message: 'm', code: 'NETWORK', kind: null, stage: 'CONFIRMING', imageId: 'id-e', retryable: true, uploadedVariants: ['thumbnail', 'medium', 'webp'], retryNotBefore: null, retryAfterSeconds: null, newSessionRequired: false, restartable: false, ...over });
    const errState = (over) => ({ ...initialUploadState, phase: 'error', error: err(over) });
    v = R('real', errState({}));
    check('ui/REAL confirm lỗi: nút "Thử lại xác nhận (không upload lại)" bật, giải thích chưa DONE', v.includes('Thử lại xác nhận (không upload lại)') && !/disabled/.test(v) && v.includes('chưa được coi là hoàn tất') && v.includes('real-badge'));
    v = R('real', errState({ retryNotBefore: Date.now() + 120_000, retryAfterSeconds: 120, code: 'QUOTA_EXCEEDED' }));
    check('ui/17. Retry-After: nút bị VÔ HIỆU HÓA kèm "chờ N giây" và nêu thời gian Backend yêu cầu', /disabled/.test(v) && /chờ (119|120) giây/.test(v) && v.includes('Backend yêu cầu chờ khoảng 120 giây'));
    v = R('real', errState({ retryNotBefore: Date.now() - 1000, retryAfterSeconds: 5, code: 'QUOTA_EXCEEDED' }));
    check('ui/18. mốc đã qua: nút bật lại (không disabled, không đếm ngược)', !/disabled/.test(v) && !/chờ \d+ giây\)/.test(v) && v.includes('Thử lại xác nhận'));
    // H4B-7B.2.1: đếm ngược tại từng thời điểm, độc lập với ngày giờ thật (đồng hồ ghim bằng withDateNow, luôn khôi phục)
    const realDateNow = Date.now;
    for (const [label, pin] of [['quá khứ xa (2001)', Date.UTC(2001, 0, 1)], ['mốc cũ 2026-11-24T10:00Z', Date.UTC(2026, 10, 24, 10, 0, 0)], ['tương lai xa (2099)', Date.UTC(2099, 11, 31, 23, 59, 59)], ['giờ hệ thống hiện tại', Date.now()]]) {
      const notBefore = pin + 60_000;
      const at = (offsetMs, nb = notBefore) => withDateNow(pin + offsetMs, () => R('real', errState({ retryNotBefore: nb, retryAfterSeconds: 60, code: 'QUOTA_EXCEEDED' })));
      const locked = (html, n) => /disabled/.test(html) && new RegExp(`chờ ${n} giây`).test(html);
      const open = (html) => !/disabled/.test(html) && !/chờ \d+ giây\)/.test(html) && html.includes('Thử lại xác nhận');
      check(`ui/đồng hồ ${label}: trước hạn (chờ 60 giây) nút bị khóa; còn 1 giây vẫn khóa`, locked(at(0), 60) && locked(at(59_000), 1) && locked(at(59_999), 1));
      check(`ui/đồng hồ ${label}: ĐÚNG thời điểm hết hạn nút mở (không đếm ngược)`, open(at(60_000)));
      check(`ui/đồng hồ ${label}: sau hết hạn (1 ms, 1 s, 1 giờ) nút vẫn mở`, open(at(60_001)) && open(at(61_000)) && open(at(3_600_000)));
      check(`ui/đồng hồ ${label}: mốc cách 1 ngày trong quá khứ => mở; cách 1 ngày trong tương lai => khóa "chờ 86400 giây"`, open(at(0, pin - 86_400_000)) && locked(at(0, pin + 86_400_000), 86_400));
      check(`ui/đồng hồ ${label}: không có mốc (null) => nút mở`, open(at(0, null)));
    }
    let threw = false;
    try { withDateNow(1, () => { throw new Error('mô phỏng lỗi khi render'); }); } catch { threw = true; }
    check('ui/withDateNow luôn khôi phục Date.now (kể cả khi render ném lỗi), không rò sang test khác', threw && Date.now === realDateNow && Math.abs(Date.now() - realDateNow()) < 50);
    check('ui/remainingSeconds: làm tròn lên, 0 khi không mốc/đã qua', remainingSeconds(10_500, 10_000) === 1 && remainingSeconds(11_000, 10_000) === 1 && remainingSeconds(10_000, 10_000) === 0 && remainingSeconds(null, 1) === 0 && remainingSeconds(5, 10) === 0 && remainingSeconds(121_000, 0) === 121);
    v = R('real', errState({ kind: K.GRANT_EXPIRED, retryable: false, newSessionRequired: true, restartable: true, stage: 'UPLOADING', uploadedVariants: ['thumbnail'], message: 'Quyền upload đã hết hạn.' }));
    check('ui/19. grant hết hạn: tiêu đề riêng, nút "Bắt đầu lại", KHÔNG nút Thử lại, nêu asset không bị tự xóa', v.includes('Quyền upload đã hết hạn') && v.includes('Bắt đầu lại (phiên upload mới)') && !v.includes('Thử lại') && v.includes('KHÔNG bị tự xóa'));
    v = R('real', errState({ kind: K.ASSETS_MISMATCH, retryable: false, newSessionRequired: true, restartable: false }));
    check('ui/E. 409 không retry được, không restartFile: KHÔNG có Thử lại/Bắt đầu lại; chỉ Chọn ảnh khác', !v.includes('Thử lại') && !v.includes('Bắt đầu lại') && v.includes('Chọn ảnh khác'));
    v = R('real', errState({ code: 'CANCELLED', stage: 'UPLOADING', uploadedVariants: ['thumbnail'] }));
    check('ui/hủy REAL: "Đã hủy", nêu hủy không bảo đảm server chưa nhận, vẫn thử lại được', v.includes('Đã hủy') && v.includes('không bảo đảm') && v.includes('Thử lại upload'));
    v = R('real', errState({ code: 'CANCELLED', kind: K.AUTH_CHANGED, retryable: false, uploadedVariants: [] }));
    check('ui/đổi tài khoản: tiêu đề "Tài khoản đã thay đổi", không nút thử lại', v.includes('Tài khoản đã thay đổi') && !v.includes('Thử lại'));
    v = R('real', errState({ stage: 'AUTHORIZING', kind: K.SIGNED_UNAVAILABLE, code: 'CONFIG', retryable: false, uploadedVariants: [] }));
    check('ui/14. lỗi authorize/cấu hình Backend: tiêu đề rõ, không thử lại', v.includes('Backend chưa bật upload có chữ ký') && !v.includes('Thử lại') && v.includes('role="alert"'));
    v = R('real', errState({ stage: 'AUTHORIZING', retryable: true, uploadedVariants: [] }));
    check('ui/authorize retry được: nhãn "Thử lại xin quyền tải ảnh lên"', v.includes('Thử lại xin quyền tải ảnh lên'));
    // DONE REAL
    const wd = world();
    wd.ctl.selectFile(jpeg()); await wd.idle();
    v = R('real', wd.state());
    check('ui/13. kết quả REAL: "Hoàn tất", DONE (Backend đã xác nhận), nhãn REAL, KHÔNG chữ MOCK/giả lập', v.includes('Hoàn tất') && v.includes('DONE (Backend đã xác nhận)') && v.includes('real-badge') && !/MOCK|giả lập|GIẢ LẬP/.test(v));
    check('ui/kết quả REAL: nút "Xem thư viện ảnh" trỏ đúng /gallery, không ảnh giả', /<a[^>]+href="\/gallery"[^>]*>Xem thư viện ảnh/.test(v) && !/<img[^>]+res\.cloudinary\.com/.test(v) && v.includes('Tải ảnh khác'));
    check('27. DOM kết quả REAL không chứa signature/api_key/token/Bearer/session/authorization', !/signature|api_key|token|Bearer|authoriz|timestamp|a{40}/i.test(v.replace(/Tải ảnh/g, '')), v.match(/signature|api_key|token|Bearer|authoriz|timestamp/i)?.[0]);
    const failedWorld = world();
    failedWorld.backend.faults.confirm.push({ status: 503, detail: 'Upload verification unavailable', headers: { 'Retry-After': '60' } });
    failedWorld.ctl.selectFile(jpeg()); await failedWorld.idle();
    v = withDateNow(failedWorld.clock.now + 1000, () => R('real', failedWorld.state())); // cùng đồng hồ với controller: 1 giây sau khi lỗi xảy ra
    check('27. DOM lỗi REAL (có session thật) không chứa chữ ký/token/session', !/signature|api_key|Bearer|authoriz|a{40}|[0-9a-f]{64}/i.test(v), v.match(/signature|Bearer|authoriz|[0-9a-f]{64}/i)?.[0]);
    check('real/lỗi 503 verification+Retry-After=60 vào UI: đếm ngược, disabled', failedWorld.state().error.retryAfterSeconds === 60 && /disabled/.test(v) && /chờ 59 giây/.test(v));
    // Hết đếm ngược chỉ MỞ nút: không tự gửi request; chỉ bấm tay mới retry (cùng đồng hồ với controller)
    failedWorld.clock.now += 61_000;
    await tick(30);
    const afterExpiry = withDateNow(failedWorld.clock.now, () => R('real', failedWorld.state()));
    check('real/hết đếm ngược 60s: nút mở lại (không disabled, không "chờ"), KHÔNG tự gửi confirm (vẫn 1 lần), vẫn ở lỗi', !/disabled/.test(afterExpiry) && !/chờ \d+ giây\)/.test(afterExpiry) && failedWorld.confirm() === 1 && failedWorld.state().phase === 'error');
    failedWorld.ctl.retry(); await failedWorld.idle();
    check('real/bấm thử lại thủ công sau hết đếm ngược: đúng 1 confirm mới (tổng 2), DONE, mốc đếm ngược được xóa', failedWorld.confirm() === 2 && failedWorld.state().phase === 'done' && failedWorld.ctl.debug.retryNotBefore() === 0);
    // MOCK hoàn tất vẫn không có link
    const { createUploadServices: cu } = await load('/src/app/createUploadServices.js');
    void cu;

    // --- Trang Upload theo từng dịch vụ ---
    const page = (services, path0 = '/upload') => strip(renderToString(h(Router.MemoryRouter, { initialEntries: [path0] }, h(UploadServicesContext.Provider, { value: services }, h(UploadPage)))));
    const mockSvc = createUploadServices({ imageProcessor: fakeProcessor(), generateId: counterIds(), latencyMs: 0 });
    let p = page(mockSvc);
    check('trang/1. MOCK: banner MOCK, nhãn MOCK, thanh kịch bản 8 mục, có vùng chọn ảnh', p.includes('MOCK – Không upload Cloudinary') && /Tải ảnh lên[\s\S]{0,40}mock-badge/.test(p) && (p.match(/scenario-bar__link/g) || []).length >= 8 && p.includes('type="file"') && !p.includes('real-badge'));
    const realSvc = world().services;
    p = page(realSvc);
    check('trang/3. REAL: nhãn REAL trên tiêu đề, banner REAL, có vùng chọn ảnh', /Tải ảnh lên[\s\S]{0,40}real-badge/.test(p) && p.includes('REAL – Ảnh sẽ được tải lên Cloudinary') && p.includes('type="file"'));
    check('trang/3. REAL: KHÔNG banner MOCK, KHÔNG thanh kịch bản, KHÔNG nhãn MOCK, không có request khi render', !p.includes('MOCK – Không upload') && !p.includes('scenario-bar') && !p.includes('mock-badge') && netCalls.length === 0);
    const inv = createUploadModeServices({ env: { ...REAL_ENV, VITE_UPLOAD_MODE: 'yes' }, isDev: true, authServices: authReal(), createMockServices: () => mockSvc });
    p = page(inv);
    check('trang/8. invalid: LỖI CẤU HÌNH, KHÔNG vùng chọn ảnh, KHÔNG MOCK, KHÔNG nhãn', p.includes('Lỗi cấu hình Upload') && p.includes('role="alert"') && p.includes('không hợp lệ') && !p.includes('type="file"') && !p.includes('mock-badge') && !p.includes('real-badge') && !p.includes('scenario-bar') && p.includes('không dùng MOCK'));
    const remote = createUploadModeServices({ env: { ...REAL_ENV, VITE_API_BASE_URL: 'https://api.example.com' }, isDev: true, authServices: authReal(), createMockServices: () => mockSvc });
    p = page(remote);
    check('trang/5. REAL với Backend từ xa: lỗi cấu hình nêu "Backend localhost", không upload', p.includes('Backend localhost') && !p.includes('type="file"'));
    const prod = createUploadModeServices({ env: REAL_ENV, isDev: false, authServices: authReal(), createMockServices: () => mockSvc });
    p = page(prod);
    check('trang/7. REAL trong production build: lỗi "development", không upload', p.includes('development') && !p.includes('type="file"'));
    const authMock = createUploadModeServices({ env: REAL_ENV, isDev: true, authServices: { mode: 'mock', useCases: {} }, createMockServices: () => mockSvc });
    check('trang/6. REAL với Auth MOCK: lỗi, không MOCK', page(authMock).includes('Firebase Authentication thật') && !page(authMock).includes('type="file"'));
  }

  // =====================================================================================================================
  // 7. Thiếu Provider (Vite nạp .env tạm) — 9
  // =====================================================================================================================
  const missingCases = [
    ['trống (MOCK mặc định)', [], 'mock'],
    ['VITE_UPLOAD_MODE=mock', ['VITE_UPLOAD_MODE=mock'], 'mock'],
    ['VITE_UPLOAD_MODE=real', ['VITE_UPLOAD_MODE=real'], 'real'],
    ['VITE_UPLOAD_MODE=REAL', ['VITE_UPLOAD_MODE=REAL'], 'real'],
    ['VITE_UPLOAD_MODE=yes (lạ)', ['VITE_UPLOAD_MODE=yes'], 'invalid'],
  ];
  for (const [label, lines, kind] of missingCases) {
    await withEnv(lines, async (s) => {
      const L = (p) => s.ssrLoadModule(p);
      const { UploadPage: Page } = await L('/src/presentation/pages/UploadPage.jsx');
      const { AuthContext } = await L('/src/presentation/contexts/AuthContext.js');
      const base = { user: { uid: 'u1' }, initializing: false, isMock: false, mode: 'firebase', configError: null, authError: null, login: async () => {}, logout: async () => {}, getIdToken: async () => 'x' };
      const html = strip(renderToString(h(Router.MemoryRouter, { initialEntries: ['/upload'] }, h(AuthContext.Provider, { value: base }, h(Page)))));
      if (kind === 'mock') {
        check(`9. thiếu Provider [${label}]: CẢNH BÁO rõ thiếu UploadServicesContext.Provider, nhãn MOCK`, html.includes('thiếu UploadServicesContext.Provider') && html.includes('mock-badge') && html.includes('role="note"'));
        check(`9. thiếu Provider [${label}]: không crash, không request mạng`, netCalls.length === 0);
      } else {
        check(`9/10. thiếu Provider [${label}]: LỖI CẤU HÌNH, KHÔNG MOCK, KHÔNG vùng chọn ảnh, KHÔNG nhãn`, html.includes('Lỗi cấu hình Upload') && html.includes('role="alert"') && !html.includes('type="file"') && !html.includes('mock-badge') && !html.includes('scenario-bar') && !html.includes('MOCK – Không upload'));
        check(`9. thiếu Provider [${label}]: lỗi nêu thiếu UploadServicesContext.Provider (và hướng dẫn nối ở src/main.jsx khi cấu hình đúng)`, html.includes('UploadServicesContext.Provider') && (kind === 'invalid' || html.includes('src/main.jsx')));
        if (kind === 'real') check(`10. thiếu Provider [${label}]: nói rõ KHÔNG dùng MOCK hay upload không ký`, html.includes('KHÔNG dùng MOCK hay upload không ký thay thế'));
        if (kind === 'invalid') check(`9. thiếu Provider [${label}]: nêu giá trị không hợp lệ (chỉ nhận mock hoặc real)`, html.includes('không hợp lệ') && html.includes('mock') && html.includes('real'));
      }
      const hook = await L('/src/application/uploadMode.js');
      const a = hook.resolveMissingUploadProvider(lines[0]?.split('=')[1]); const b = hook.resolveMissingUploadProvider(lines[0]?.split('=')[1]);
      check(`9. thiếu Provider [${label}]: kết quả ỔN ĐỊNH (cùng đối tượng, không tạo lại controller mỗi lần render)`, a === b);
      const r = await settle(a.uploadImage({ file: jpeg() }));
      check(`9. thiếu Provider [${label}]: uploadImage báo CONFIG, không mạng`, r.error?.code === 'CONFIG' && netCalls.length === 0);
    });
  }

  // =====================================================================================================================
  // 8. Gallery không bị ảnh hưởng — 28
  // =====================================================================================================================
  {
    const authG = { mode: 'firebase', useCases: { getIdToken: async () => 'T' } };
    const GOOD = { VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'http://localhost:8000' };
    const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
    for (const [label, env] of [['mock', {}], ['gallery real', { ...GOOD, VITE_GALLERY_MODE: 'real' }], ['gallery lạ', { VITE_GALLERY_MODE: 'yes' }], ['gallery real thiếu backend', { VITE_GALLERY_MODE: 'real' }]]) {
      const without = resolveGalleryConfig({ env, isDev: true, authMode: authG.mode, hasIdToken: true });
      const withUp = resolveGalleryConfig({ env: { ...env, VITE_UPLOAD_MODE: 'real', VITE_CLOUDINARY_CLOUD_NAME: CLOUD }, isDev: true, authMode: authG.mode, hasIdToken: true });
      check(`gallery/28. Gallery [${label}] không đổi dù VITE_UPLOAD_MODE=real`, same(without, withUp));
    }
    const g = createGalleryServices({ env: { VITE_UPLOAD_MODE: 'real', ...REAL_ENV }, isDev: true, authServices: authG });
    check('gallery/28. VITE_UPLOAD_MODE=real không bật Gallery REAL (vẫn MOCK mặc định)', g.mode === 'mock' && g.listPage === null);
    const u = createUploadModeServices({ env: { VITE_GALLERY_MODE: 'real', ...GOOD, VITE_CLOUDINARY_CLOUD_NAME: CLOUD }, isDev: true, authServices: authReal(), createMockServices: () => ({ mode: 'mock' }) });
    check('gallery/28. VITE_GALLERY_MODE=real không bật Upload REAL (vẫn MOCK mặc định)', u.mode === 'mock');
  }

  // =====================================================================================================================
  // 9. Quét mã nguồn
  // =====================================================================================================================
  {
    const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
    const code = (p) => read(p).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
    const files = ['src/application/uploadMode.js', 'src/app/createUploadModeServices.js', 'src/presentation/hooks/uploadFlowController.js', 'src/presentation/hooks/useUploadFlow.js', 'src/presentation/hooks/useUploadServices.js', 'src/presentation/components/upload/UploadFlowStatus.jsx', 'src/presentation/pages/UploadPage.jsx'];
    for (const f of files) {
      const c = code(f); const n = path.basename(f);
      check(`mã nguồn ${n}/không console.*`, !/console\./.test(c));
      check(`mã nguồn ${n}/không localStorage/sessionStorage/IndexedDB/cookie`, !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(c));
      check(`mã nguồn ${n}/không api_secret, upload_preset, VITE_*SECRET`, !/api_secret|API_SECRET|upload_preset|VITE_[A-Z_]*SECRET/.test(c));
    }
    check('mã nguồn/Presentation (controller, hook, trang, status) không import adapter/Infrastructure/Firebase/uploader', ['src/presentation/hooks/uploadFlowController.js', 'src/presentation/hooks/useUploadFlow.js', 'src/presentation/components/upload/UploadFlowStatus.jsx', 'src/presentation/pages/UploadPage.jsx'].every((f) => !/from ['"][^'"]*(infrastructure|firebase|firestore|\/app\/|cloudinary)/i.test(code(f))));
    check('mã nguồn/createUploadModeServices KHÔNG đọc VITE_CLOUDINARY_UPLOAD_PRESET và không import uploader unsigned', !/UPLOAD_PRESET|uploadPreset|cloudinaryUploader'|createCloudinaryServices/.test(code('src/app/createUploadModeServices.js')));
    check('mã nguồn/createUploadServices.js (MOCK H4A) KHÔNG đổi: vẫn không import signed/backend client', !/createSignedUploadServices|createUploadModeServices|backendClient|signedCloudinaryUploader/.test(code('src/app/createUploadServices.js')));
    check('mã nguồn/main.jsx nối createUploadModeServices({ authServices, createMockServices: createUploadServices }) và vẫn bọc cả hai Provider', /createUploadModeServices\(\{ authServices, createMockServices: createUploadServices \}\)/.test(code('src/main.jsx')) && /UploadServicesContext\.Provider/.test(code('src/main.jsx')) && /GalleryServicesContext\.Provider/.test(code('src/main.jsx')) && /createGalleryServices\(\{ authServices \}\)/.test(code('src/main.jsx')));
    check('mã nguồn/uploadMode.js: import duy nhất là errors; không import.meta/fetch', (code('src/application/uploadMode.js').match(/from\s+'[^']+'/g) || []).join() === "from './errors'" && !/import\.meta|fetch/.test(code('src/application/uploadMode.js')));
    check('mã nguồn/createUploadModeServices chỉ khởi tạo Signed Upload trong nhánh REAL (một lần gọi createSignedUploadServices, sau nhánh MOCK/INVALID return)', (code('src/app/createUploadModeServices.js').match(/createSignedUploadServices\(/g) || []).length === 1 && code('src/app/createUploadModeServices.js').indexOf('createSignedUploadServices({') > code('src/app/createUploadModeServices.js').indexOf('return createUnavailableUploadServices'));
    check('mã nguồn/biến VITE_UPLOAD_MODE trong .env.example mặc định mock, không biến secret mới', /^VITE_UPLOAD_MODE=mock\s*$/m.test(read('.env.example')) && !/^\s*[A-Z_]*SECRET[A-Z_]*\s*=/m.test(read('.env.example')));
    check('mã nguồn/không sửa Backend/CONTRACT/SCHEMA/CI: các file đó không nhắc VITE_UPLOAD_MODE', ['CONTRACT.md', 'SCHEMA.md', '.github/workflows/ci.yml'].every((f) => !/VITE_UPLOAD_MODE/.test(read(f))));
  }

  check('27. console không ghi chữ ký/token/Bearer/session', consoleLines.every((l) => !/Bearer|token-|signature|authoriz/i.test(l)), consoleLines.slice(0, 2).join('|'));
  check('MẠNG/toàn bộ H4B-5: 0 lần gọi fetch/XMLHttpRequest toàn cục', netCalls.length === 0, JSON.stringify(netCalls.slice(0, 3)));
} finally {
  await server.close();
}

out(`PASSED: ${passed}`);
out(`FAILED: ${failures.length}`);
failures.forEach((f) => out('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
