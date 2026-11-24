// Smoke test H4A — UploadPage Hybrid bằng MOCK. KHÔNG gọi mạng: fetch và XMLHttpRequest bị thay bằng bẫy ném lỗi + đếm.
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/h4a-smoke.mjs .  (xem tests/README.md)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => (ok ? (passed += 1) : failures.push(`${name}${detail ? ` — ${detail}` : ''}`));
const settle = async (p) => { try { return { value: await p }; } catch (error) { return { error }; } };
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
const out = (s) => process.stdout.write(s + '\n');

// ---------- Bẫy mạng ----------
const netCalls = [];
globalThis.fetch = (...a) => { netCalls.push(['fetch', String(a[0])]); throw new Error('KHÔNG được gọi fetch trong H4A'); };
globalThis.XMLHttpRequest = class { constructor() { netCalls.push(['XMLHttpRequest']); throw new Error('KHÔNG được dùng XMLHttpRequest trong H4A'); } };
const consoleLines = [];
for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = (...a) => consoleLines.push(a.map(String).join(' '));

// ---------- Fixtures ----------
const webp = (n = 100) => new Blob([new Uint8Array(n)], { type: 'image/webp' });
const jpeg = (over = {}) => ({ name: 'anh-bien.jpg', type: 'image/jpeg', size: 2_000_000, ...over });
function fakeProcessor({ fail } = {}) {
  const calls = [];
  return {
    calls,
    async process(file) {
      calls.push(file.name);
      if (fail) { const f = fail(calls.length); if (f) throw Object.assign(new Error('nén lỗi'), { errorReason: f }); }
      return { blobs: { thumbnail: webp(1000), medium: webp(20000), webp: webp(300000) }, width: 4000, height: 3000, processingMs: 321 };
    },
  };
}
function counterId() { let n = 0; const f = () => `fixture-id-${++n}`; f.count = () => n; return f; }

const server = await createServer({
  root, envDir: process.env.EMPTY_ENV_DIR, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const load = (p) => server.ssrLoadModule(p);
  const { createUploadServices, UPLOAD_MOCK_SCENARIOS: SC } = await load('/src/app/createUploadServices.js');
  const { createUploadImageHybrid, UPLOAD_STAGE } = await load('/src/application/usecases/uploadImageHybrid.js');
  const { createUploadVariantsToCloudinary } = await load('/src/application/usecases/uploadVariantsToCloudinary.js');
  const { createConfirmCloudinaryUpload } = await load('/src/application/usecases/confirmCloudinaryUpload.js');
  const { createMockCloudinaryUploader } = await load('/src/infrastructure/mock/mockCloudinaryUploader.js');
  const { backendError } = await load('/src/infrastructure/api/backendErrors.js');
  const { initialUploadState, uploadFlowReducer, toErrorView } = await load('/src/presentation/hooks/uploadFlowReducer.js');

  const mkServices = (processor, over = {}) => {
    const id = counterId();
    const services = createUploadServices({ imageProcessor: processor, generateId: id, latencyMs: 0, ...over });
    return { services, id };
  };
  const run = (services, args) => services.uploadImage(args);

  // ===== Composition root =====
  {
    const { services } = mkServices(fakeProcessor());
    check('composition/mode mock, isMock, không notice khi không cấu hình', services.mode === 'mock' && services.isMock === true && services.notice === null);
    check('composition/8 kịch bản MOCK', services.scenarios.length === 8 && services.scenarios[0].value === 'normal');
    services.scenario.set('khong-ton-tai');
    check('composition/kịch bản lạ -> normal', services.scenario.get() === 'normal');
    services.scenario.set(SC.CONFIRM_FAIL_ONCE);
    check('composition/đổi kịch bản được', services.scenario.get() === 'confirm-fail-once');
    const bad = await settle((async () => createUploadServices({ mode: 'real' }))());
    check('composition/mode khác "mock" bị từ chối (không có đường tới thật)', bad.error instanceof Error && /chỉ hỗ trợ mode "mock"/.test(bad.error.message));
  }

  // ===== Validate: file sai loại / quá 10MB / rỗng =====
  {
    const proc = fakeProcessor();
    const { services, id } = mkServices(proc);
    const stages = [];
    for (const [label, file, reason] of [
      ['file sai loại (text/plain)', { name: 'a.txt', type: 'text/plain', size: 10 }, 'INVALID_IMAGE'],
      ['file gif', { name: 'a.gif', type: 'image/gif', size: 10 }, 'INVALID_IMAGE'],
      ['file > 10MB', jpeg({ size: 10 * 1024 * 1024 + 1 }), 'TOO_LARGE'],
      ['file rỗng', jpeg({ size: 0 }), 'INVALID_IMAGE'],
      ['không có file', undefined, 'INVALID_IMAGE'],
    ]) {
      const r = await settle(run(services, { file, onStage: (e) => stages.push(e.stage) }));
      check(`validate/${label} -> VALIDATION (${reason})`, r.error?.code === 'VALIDATION' && r.error.details.errorReason === reason && r.error.details.stage === 'VALIDATING', `${r.error?.code}/${r.error?.details?.errorReason}`);
      check(`validate/${label} -> không thử lại được (không session)`, r.error?.details.retryable === false && r.error.details.session === undefined);
    }
    check('validate/file sai: KHÔNG tạo imageId, KHÔNG nén, KHÔNG upload, KHÔNG confirm', id.count() === 0 && proc.calls.length === 0 && services.debug.uploadAttempts().length === 0 && services.debug.storedCount() === 0);
    check('validate/chỉ phát giai đoạn VALIDATING', stages.every((s) => s === 'VALIDATING'));
  }

  // ===== Thành công =====
  {
    const proc = fakeProcessor();
    const { services, id } = mkServices(proc);
    const stages = []; const progress = [];
    const r = await settle(run(services, { file: jpeg(), onStage: (e) => stages.push(`${e.stage}:${e.imageId}`), onProgress: (p) => progress.push(p) }));
    const o = r.value;
    check('thành công/DONE chỉ sau confirm, isMock', o?.status === 'DONE' && o.confirm.status === 'DONE' && o.confirm.isMock === true, r.error?.message);
    check('thành công/CHỈ MỘT imageId, tạo sau validate và trước khi nén', id.count() === 1 && o.imageId === 'fixture-id-1' && stages[0] === 'VALIDATING:null' && stages[1] === 'COMPRESSING:fixture-id-1');
    check('thành công/thứ tự giai đoạn VALIDATING -> COMPRESSING -> UPLOADING -> CONFIRMING', stages.map((s) => s.split(':')[0]).join() === 'VALIDATING,COMPRESSING,UPLOADING,CONFIRMING');
    check('thành công/mọi giai đoạn sau validate dùng cùng imageId', stages.slice(1).every((s) => s.endsWith(':fixture-id-1')) && o.confirm.imageId === 'fixture-id-1');
    check('thành công/nén 1 lần, tạo đúng 3 WebP (thumbnail, medium, webp), không ảnh gốc', proc.calls.length === 1 && Object.keys(o.processed.blobs).join() === 'thumbnail,medium,webp' && Object.values(o.processed.blobs).every((b) => b.type === 'image/webp'));
    check('thành công/mock upload đúng 3 file theo thứ tự, mock confirm 1 bản ghi', services.debug.uploadAttempts().join() === 'thumbnail,medium,webp' && services.debug.uploadsSucceeded() === 3 && services.debug.storedCount() === 1 && services.debug.confirmAttempts('fixture-id-1') === 1);
    check('thành công/asset là dữ liệu GIẢ (cloud mock, public_id mock-)', Object.values(o.assets).every((a) => a.secureUrl.includes('mock-cloud-not-real') && a.publicId.startsWith('mock-')));
    const overall = progress.map((p) => p.overallPercent);
    check('thành công/tiến độ upload đơn điệu, kết thúc 100, có tên biến thể', overall.length > 3 && overall.every((v, i) => i === 0 || v >= overall[i - 1]) && overall.at(-1) === 100 && ['thumbnail', 'medium', 'webp'].every((v) => progress.some((p) => p.variant === v)));
    const r2 = await settle(run(services, { file: jpeg({ name: 'khac.png', type: 'image/png' }) }));
    check('thành công/ảnh thứ hai có imageId mới khác', r2.value?.imageId === 'fixture-id-2' && id.count() === 2);
  }

  // ===== Payload gửi tới Backend (tạo thủ công để chặn và đọc payload) =====
  {
    const captured = [];
    const backendApi = {
      async confirmCloudinaryUpload(payload) {
        captured.push(payload);
        if (captured.length === 1) throw backendError('NETWORK', 'NETWORK', 'mất mạng', { retryable: true });
        return { imageId: payload.imageId, status: 'DONE', ownerId: 'o', variants: { thumbnail: payload.thumbnail, medium: payload.medium, webp: payload.webp }, processingMs: payload.processingMs, savedPercent: null, isMock: true };
      },
    };
    const uploader = createMockCloudinaryUploader({ latencyMs: 0 });
    const proc = fakeProcessor(); const id = counterId();
    const flow = createUploadImageHybrid({ imageProcessor: proc, uploadVariantsToCloudinary: createUploadVariantsToCloudinary({ cloudinaryUploader: uploader }), confirmCloudinaryUpload: createConfirmCloudinaryUpload({ backendApi }), generateId: id });
    const first = await settle(flow({ file: jpeg() }));
    check('retry confirm/lần 1 lỗi mạng ở CONFIRMING, retryable, mang session', first.error?.code === 'NETWORK' && first.error.details.stage === 'CONFIRMING' && first.error.details.retryable === true && !!first.error.details.session);
    check('retry confirm/lỗi KHÔNG phải DONE, session giữ imageId + bản nén + 3 asset', first.value === undefined && first.error.details.session.imageId === 'fixture-id-1' && !!first.error.details.session.processed && Object.keys(first.error.details.session.assets).join() === 'thumbnail,medium,webp');
    check('retry confirm/uploadedVariants báo 3 biến thể đã upload', first.error.details.uploadedVariants.join() === 'thumbnail,medium,webp');
    const uploadsBefore = uploader.debug.attempts().length;
    const second = await settle(flow({ session: first.error.details.session }));
    check('retry confirm/lần 2 thành công DONE', second.value?.status === 'DONE');
    check('retry confirm/KHÔNG upload lại 3 ảnh (số lần upload không đổi)', uploader.debug.attempts().length === uploadsBefore && uploadsBefore === 3 && uploader.debug.succeededCount() === 3);
    check('retry confirm/KHÔNG nén lại, KHÔNG tạo imageId mới', proc.calls.length === 1 && id.count() === 1);
    check('retry confirm/imageId GIỮ NGUYÊN ở cả hai request', captured.length === 2 && captured[0].imageId === 'fixture-id-1' && captured[1].imageId === 'fixture-id-1');
    check('retry confirm/payload y hệt (cùng 3 URL + 3 *Id)', JSON.stringify(captured[0]) === JSON.stringify(captured[1]));
    const p = captured[0];
    check('payload/đủ 6 field bắt buộc', ['imageId', 'thumbnail', 'medium', 'webp', 'originalSize', 'processingMs'].every((k) => p[k] !== undefined) && p.originalSize === 2_000_000 && p.processingMs === 321);
    check('payload/tùy chọn: fileName, width, height và 3 *Id từ publicId (mock)', p.fileName === 'anh-bien.jpg' && p.width === 4000 && p.height === 3000 && /^mock-\d+\/thumb$/.test(p.thumbnailId) && /^mock-\d+\/medium$/.test(p.mediumId) && /^mock-\d+\/full$/.test(p.webpId));
    check('payload/KHÔNG có contentType; có processedSize = tổng 3 Blob thật (1000+20000+300000)', !('contentType' in p) && p.processedSize === 321000 && Number.isInteger(p.processedSize));
    check('payload/đủ 13 field (6 bắt buộc + 7 tùy chọn)', Object.keys(p).length === 13);
  }

  // ===== Kịch bản upload =====
  {
    const proc = fakeProcessor();
    const { services, id } = mkServices(proc);
    services.scenario.set(SC.UPLOAD_FAIL_ONCE);
    const first = await settle(run(services, { file: jpeg() }));
    const d = first.error?.details;
    check('upload lỗi 1 lần/lỗi NETWORK ở UPLOADING, retryable', first.error?.code === 'NETWORK' && d.stage === 'UPLOADING' && d.retryable === true);
    check('upload lỗi 1 lần/thumbnail đã "lên", medium lỗi => cảnh báo ảnh mồ côi giả lập', d.uploadedVariants.join() === 'thumbnail' && services.debug.uploadAttempts().join() === 'thumbnail,medium');
    check('upload lỗi 1 lần/KHÔNG gọi confirm, KHÔNG phải DONE', services.debug.confirmAttempts('fixture-id-1') === 0 && services.debug.storedCount() === 0 && first.value === undefined);
    check('upload lỗi 1 lần/session giữ imageId và bản nén (chưa có assets)', d.session.imageId === 'fixture-id-1' && !!d.session.processed && d.session.assets === null);
    await tick(20);
    check('upload lỗi/KHÔNG tự upload lại', services.debug.uploadAttempts().length === 2);
    const second = await settle(run(services, { session: d.session }));
    check('upload lỗi 1 lần/thử lại thành công DONE, cùng imageId', second.value?.status === 'DONE' && second.value.imageId === 'fixture-id-1');
    check('upload lỗi 1 lần/thử lại KHÔNG nén lại, KHÔNG tạo imageId mới', proc.calls.length === 1 && id.count() === 1);
    check('upload lỗi 1 lần/thử lại upload lại cả 3 biến thể từ bản nén', services.debug.uploadAttempts().join() === 'thumbnail,medium,thumbnail,medium,webp');
  }
  {
    const { services } = mkServices(fakeProcessor());
    services.scenario.set(SC.UPLOAD_NETWORK);
    const first = await settle(run(services, { file: jpeg() }));
    const second = await settle(run(services, { session: first.error.details.session }));
    check('upload lỗi mạng liên tục/thử lại vẫn lỗi, không bao giờ DONE, không confirm', second.error?.code === 'NETWORK' && services.debug.storedCount() === 0 && services.debug.confirmAttempts('fixture-id-1') === 0);
  }

  // ===== Kịch bản confirm (qua composition root MOCK) =====
  {
    const proc = fakeProcessor();
    const { services, id } = mkServices(proc);
    services.scenario.set(SC.CONFIRM_FAIL_ONCE);
    const first = await settle(run(services, { file: jpeg() }));
    check('confirm lỗi 1 lần/CONFIRMING NETWORK retryable, 3 ảnh đã upload', first.error?.code === 'NETWORK' && first.error.details.stage === 'CONFIRMING' && first.error.details.retryable === true && services.debug.uploadsSucceeded() === 3);
    check('confirm lỗi 1 lần/chưa DONE: chưa có bản ghi trong Backend giả', services.debug.storedCount() === 0 && first.value === undefined);
    const second = await settle(run(services, { session: first.error.details.session }));
    check('confirm lỗi 1 lần/retry thành công DONE, cùng imageId', second.value?.status === 'DONE' && second.value.imageId === 'fixture-id-1');
    check('confirm lỗi 1 lần/retry KHÔNG upload lại (vẫn 3), KHÔNG nén lại, KHÔNG imageId mới', services.debug.uploadsSucceeded() === 3 && services.debug.uploadAttempts().length === 3 && proc.calls.length === 1 && id.count() === 1);
  }
  for (const [scenario, code, retryable, kind] of [
    [SC.CONFIRM_UNAUTHENTICATED, 'UNAUTHENTICATED', false, 'UNAUTHENTICATED'],
    [SC.CONFIRM_FORBIDDEN, 'FORBIDDEN', false, 'FORBIDDEN'],
    [SC.CONFIRM_SERVER_ERROR, 'UNKNOWN', true, 'SERVER_ERROR'],
    [SC.CONFIRM_INVALID_RESPONSE, 'UNKNOWN', false, 'INVALID_RESPONSE'],
  ]) {
    const { services } = mkServices(fakeProcessor());
    services.scenario.set(scenario);
    const r = await settle(run(services, { file: jpeg() }));
    check(`${scenario}/${code}, retryable=${retryable}, không DONE`, r.error?.code === code && r.error.details.retryable === retryable && r.error.details.kind === kind && r.error.details.stage === 'CONFIRMING' && r.value === undefined, `${r.error?.code}/${r.error?.details?.kind}/${r.error?.details?.retryable}`);
    check(`${scenario}/3 ảnh đã upload giữ lại, không upload lại`, services.debug.uploadsSucceeded() === 3 && services.debug.uploadAttempts().length === 3);
  }

  // ===== Nén lỗi =====
  {
    const id = counterId();
    const proc = fakeProcessor({ fail: (n) => (n === 1 ? 'COMPRESS_FAIL' : null) });
    const { services } = mkServices(proc, { generateId: id });
    const first = await settle(run(services, { file: jpeg() }));
    check('nén lỗi COMPRESS_FAIL/UPLOAD_FAILED ở COMPRESSING, retryable', first.error?.code === 'UPLOAD_FAILED' && first.error.details.stage === 'COMPRESSING' && first.error.details.retryable === true);
    check('nén lỗi/chưa upload gì', services.debug.uploadAttempts().length === 0);
    const second = await settle(run(services, { session: first.error.details.session }));
    check('nén lỗi/thử lại nén lại với CÙNG imageId, thành công', second.value?.status === 'DONE' && second.value.imageId === 'fixture-id-1' && proc.calls.length === 2 && id.count() === 1);
    const procBad = fakeProcessor({ fail: () => 'INVALID_IMAGE' });
    const { services: s2 } = mkServices(procBad);
    const r = await settle(run(s2, { file: jpeg({ name: 'gia.jpg' }) }));
    check('nén lỗi/file giả (INVALID_IMAGE) -> VALIDATION, không thử lại', r.error?.code === 'VALIDATION' && r.error.details.stage === 'COMPRESSING' && r.error.details.retryable === false);
    check('nén lỗi/file giả: không upload, không confirm', s2.debug.uploadAttempts().length === 0 && s2.debug.storedCount() === 0);
  }

  // ===== Hủy =====
  {
    const proc = fakeProcessor();
    const { services, id } = mkServices(proc, { latencyMs: 200 });
    const ctl = new AbortController();
    const pr = settle(run(services, { file: jpeg(), signal: ctl.signal }));
    await tick(60); ctl.abort();
    const first = await pr;
    check('hủy/giữa lúc upload -> CANCELLED ở UPLOADING, retryable, có session', first.error?.code === 'CANCELLED' && first.error.details.stage === 'UPLOADING' && first.error.details.retryable === true && !!first.error.details.session);
    const attemptsAfterCancel = services.debug.uploadAttempts().length;
    await tick(300);
    check('hủy/KHÔNG tự upload lại sau khi hủy', services.debug.uploadAttempts().length === attemptsAfterCancel && services.debug.storedCount() === 0);
    const second = await settle(run(services, { session: first.error.details.session }));
    check('hủy/tiếp tục (resume) -> DONE, cùng imageId, không nén lại', second.value?.status === 'DONE' && second.value.imageId === 'fixture-id-1' && proc.calls.length === 1 && id.count() === 1);
  }
  {
    const { services } = mkServices(fakeProcessor(), { latencyMs: 200 });
    const ctl = new AbortController(); ctl.abort();
    const r = await settle(run(services, { file: jpeg(), signal: ctl.signal }));
    check('hủy/trước khi bắt đầu nén -> CANCELLED, không upload', r.error?.code === 'CANCELLED' && services.debug.uploadAttempts().length === 0);
  }
  {
    const { services } = mkServices(fakeProcessor());
    const r = await settle(run(services, { session: { imageId: '', file: jpeg() } }));
    const r2 = await settle(run(services, { session: { imageId: 'x' } }));
    check('session không hợp lệ -> VALIDATION', r.error?.code === 'VALIDATION' && r2.error?.code === 'VALIDATION');
  }

  // ===== Reducer / view model =====
  {
    let s = initialUploadState;
    const step = (a) => (s = uploadFlowReducer(s, a));
    step({ type: 'START', fileName: 'a.jpg' });
    check('reducer/START -> running VALIDATING', s.phase === 'running' && s.stage === 'VALIDATING' && s.fileName === 'a.jpg' && s.imageId === null);
    step({ type: 'STAGE', stage: 'COMPRESSING', imageId: 'id-9' });
    step({ type: 'STAGE', stage: 'UPLOADING', imageId: 'id-9' });
    step({ type: 'PROGRESS', variant: 'medium', variantPercent: 40, overallPercent: 33 });
    check('reducer/UPLOADING có tiến độ', s.stage === 'UPLOADING' && s.progress.overallPercent === 33 && s.imageId === 'id-9');
    check('reducer/chưa DONE trước khi nhận action DONE', s.phase !== 'done' && s.result === null);
    step({ type: 'FAILED', error: { message: 'x', code: 'NETWORK', stage: 'CONFIRMING', imageId: 'id-9', retryable: true, uploadedVariants: [] } });
    check('reducer/FAILED -> error, giữ imageId', s.phase === 'error' && s.error.stage === 'CONFIRMING' && s.imageId === 'id-9');
    step({ type: 'RESUME' });
    check('reducer/RESUME giữ fileName + imageId, xóa lỗi', s.phase === 'running' && s.fileName === 'a.jpg' && s.imageId === 'id-9' && s.error === null);
    step({ type: 'DONE', result: { imageId: 'id-9' } });
    check('reducer/DONE chỉ khi có action DONE', s.phase === 'done' && s.result.imageId === 'id-9');
    step({ type: 'RESET' });
    check('reducer/RESET -> idle', s === initialUploadState);
    const view = toErrorView(Object.assign(new Error('m'), { code: 'NETWORK', details: { stage: 'CONFIRMING', retryable: true, session: {}, imageId: 'i', uploadedVariants: ['thumbnail'] } }));
    check('toErrorView/retryable chỉ khi có session', view.retryable === true && toErrorView(Object.assign(new Error('m'), { code: 'NETWORK', details: { retryable: true } })).retryable === false);
  }

  // ===== Giao diện (SSR, chỉ render trạng thái) =====
  {
    const nativeImport = (spec) => import(pathToFileURL(path.join(root, 'node_modules', spec)).href);
    const reactMod = await nativeImport('react/index.js'); const React = reactMod.default ?? reactMod;
    const domServer = await nativeImport('react-dom/server.node.js'); const renderToString = (domServer.default ?? domServer).renderToString ?? domServer.renderToString;
    const Router = await nativeImport('react-router/dist/production/index.js');
    const { UploadServicesContext } = await load('/src/presentation/contexts/UploadServicesContext.js');
    const { UploadPage } = await load('/src/presentation/pages/UploadPage.jsx');
    const { UploadFlowStatus } = await load('/src/presentation/components/upload/UploadFlowStatus.jsx');
    const strip = (h) => h.replace(/<!--.*?-->/g, '');
    const h = React.createElement;
    const noop = () => {};
    const { services } = mkServices(fakeProcessor());
    const page = strip(renderToString(h(Router.MemoryRouter, { initialEntries: ['/upload'] }, h(UploadServicesContext.Provider, { value: services }, h(UploadPage)))));
    check('UI/banner MOCK rõ ràng: "MOCK – Không upload Cloudinary, không ghi Firestore"', page.includes('MOCK – Không upload Cloudinary, không ghi Firestore'));
    check('UI/có vùng chọn ảnh + input file đúng loại, tối đa 10MB', page.includes('type="file"') && page.includes('image/jpeg,image/png,image/webp') && page.includes('Chọn ảnh') && /10 MB|10MB/.test(page.replace(/ /g, ' ')));
    check('UI/thanh kịch bản MOCK có đủ 8 mục', (page.match(/scenario-bar__link/g) || []).length >= 8 && page.includes('Confirm lỗi 1 lần') && page.includes('Upload lỗi 1 lần'));
    check('UI/trang mới mở chưa hiển thị Hoàn tất/lỗi', !page.includes('Hoàn tất') && !page.includes('role="alert"'));
    check('UI/nhãn MOCK trên tiêu đề', /Tải ảnh lên[\s\S]{0,40}mock-badge/.test(page));

    const render = (state) => strip(renderToString(h(UploadFlowStatus, { state, onRetry: noop, onCancel: noop, onReset: noop })));
    const base = { ...initialUploadState, phase: 'running', fileName: 'a.jpg', imageId: 'id-x' };
    let v = render({ ...base, stage: 'COMPRESSING' });
    check('UI/đang nén: hiển thị trạng thái nén, chưa có nút Hủy', v.includes('Đang nén') && !v.includes('Hủy'));
    v = render({ ...base, stage: 'UPLOADING', progress: { variant: 'medium', variantPercent: 40, overallPercent: 55 } });
    check('UI/đang upload: tiến độ giả lập có nhãn MOCK, nút Hủy', v.includes('<progress') && v.includes('value="55"') && v.includes('Tiến độ giả lập (MOCK)') && v.includes('mock-badge') && v.includes('Hủy'));
    check('UI/đang upload: hiện imageId', v.includes('id-x'));
    v = render({ ...base, stage: 'CONFIRMING' });
    check('UI/đang confirm: ghi rõ Backend giả lập (MOCK)', v.includes('xác nhận với Backend giả lập (MOCK)'));

    // Kết quả thật từ use case MOCK
    const { services: s2 } = mkServices(fakeProcessor());
    const outcome = (await run(s2, { file: jpeg() }));
    v = render({ ...initialUploadState, phase: 'done', result: outcome, imageId: outcome.imageId });
    check('UI/thành công: "Hoàn tất (MOCK)" + nhãn GIẢ LẬP + imageId', v.includes('Hoàn tất (MOCK)') && v.includes('GIẢ LẬP') && v.includes(outcome.imageId));
    check('UI/thành công: không khẳng định Cloudinary/Firestore thật', v.includes('không có ảnh nào được gửi lên Cloudinary') && v.includes('không có gì được ghi vào Firestore') && v.includes('không phải Backend thật'));
    check('UI/thành công: URL giả chỉ là chữ, KHÔNG có <a>, KHÔNG <img> tới Cloudinary', !/<a[\s>]/.test(v) && !/<img[^>]+res\.cloudinary\.com/.test(v) && v.includes('<code>https://res.cloudinary.com/mock-cloud-not-real'));
    check('UI/thành công: tiết kiệm cục bộ ghi rõ; savedPercent do Backend GIẢ tính từ processedSize (321000/2000000 -> 84%)', v.includes('tính cục bộ') && v.includes('84.0%') === false && v.includes('84%') && v.includes('MOCK tính từ originalSize và processedSize'));
    check('UI/thành công: có nút Tải ảnh khác', v.includes('Tải ảnh khác'));

    const err = (over) => ({ message: 'm', code: 'NETWORK', kind: null, stage: 'CONFIRMING', imageId: 'id-e', retryable: true, uploadedVariants: ['thumbnail', 'medium', 'webp'], ...over });
    v = render({ ...initialUploadState, phase: 'error', error: err({}) });
    check('UI/confirm lỗi: nút "Thử lại xác nhận (không upload lại)" + giải thích chưa DONE', v.includes('Thử lại xác nhận (không upload lại)') && v.includes('chưa được coi là hoàn tất') && v.includes('cùng imageId') && v.includes('role="alert"'));
    v = render({ ...initialUploadState, phase: 'error', error: err({ stage: 'UPLOADING', uploadedVariants: ['thumbnail'] }) });
    check('UI/upload lỗi: nút "Thử lại upload (MOCK)" + cảnh báo ảnh mồ côi giả lập', v.includes('Thử lại upload (MOCK)') && v.includes('ảnh mồ côi'));
    v = render({ ...initialUploadState, phase: 'error', error: err({ stage: 'VALIDATING', code: 'VALIDATION', retryable: false, uploadedVariants: [], imageId: null, message: 'Định dạng không được hỗ trợ' }) });
    check('UI/file sai: thông báo validation, KHÔNG có nút thử lại, có Chọn ảnh khác', v.includes('Định dạng không được hỗ trợ') && v.includes('File hoặc dữ liệu không hợp lệ') && !v.includes('Thử lại') && v.includes('Chọn ảnh khác'));
    v = render({ ...initialUploadState, phase: 'error', error: err({ code: 'CANCELLED', stage: 'UPLOADING', uploadedVariants: [] }) });
    check('UI/đã hủy: hiển thị "Đã hủy" + có thể thử lại', v.includes('Đã hủy') && v.includes('Thử lại upload'));
    v = render({ ...initialUploadState, phase: 'error', error: err({ code: 'UNAUTHENTICATED', retryable: false }) });
    check('UI/lỗi không retry được (401): không có nút Thử lại', !v.includes('Thử lại') && v.includes('Chưa xác thực'));
    check('UI/idle không hiển thị gì', render(initialUploadState) === '');
  }

  check('MẠNG/toàn bộ H4A: 0 lần gọi fetch/XMLHttpRequest', netCalls.length === 0, JSON.stringify(netCalls));
}
finally {
  await server.close();
}

// ===== Cấu hình .env giả: Backend/Cloudinary "thật" được đặt nhưng H4A vẫn chỉ MOCK =====
{
  const define = Object.fromEntries(Object.entries({
    VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'https://api.example.com',
    VITE_CLOUDINARY_CLOUD_NAME: 'real-looking-cloud', VITE_CLOUDINARY_UPLOAD_PRESET: 'real-looking-preset',
  }).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]));
  const s = await createServer({ root, envDir: process.env.EMPTY_ENV_DIR, appType: 'custom', logLevel: 'silent', server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] }, define });
  try {
    const { createUploadServices } = await s.ssrLoadModule('/src/app/createUploadServices.js');
    const id = counterId();
    const services = createUploadServices({ imageProcessor: fakeProcessor(), generateId: id, latencyMs: 0 });
    const r = await settle(services.uploadImage({ file: jpeg() }));
    check('cấu hình real trong .env/vẫn là mock, hiển thị nhắc nhở', services.mode === 'mock' && services.isMock && typeof services.notice === 'string' && /LUÔN dùng MOCK/.test(services.notice));
    check('cấu hình real trong .env/luồng vẫn DONE bằng MOCK, asset giả, 0 request mạng', r.value?.status === 'DONE' && r.value.confirm.isMock === true && r.value.assets.thumbnail.secureUrl.includes('mock-cloud-not-real') && netCalls.length === 0, `${r.error?.message}`);
  } finally { await s.close(); }
}

// ===== Quét mã nguồn: không có đường tới mạng thật =====
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
const importsOf = (code) => [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
const files = [
  'src/app/createUploadServices.js', 'src/infrastructure/mock/mockCloudinaryUploader.js', 'src/application/usecases/uploadImageHybrid.js',
  'src/presentation/pages/UploadPage.jsx', 'src/presentation/hooks/useUploadFlow.js', 'src/presentation/hooks/uploadFlowReducer.js',
  'src/presentation/hooks/useUploadServices.js', 'src/presentation/components/upload/UploadFlowStatus.jsx', 'src/presentation/contexts/UploadServicesContext.js',
];
const FORBIDDEN_IMPORT = /cloudinary\/cloudinaryUploader|cloudinary\/cloudinaryConfig|createCloudinaryServices|api\/backendClient|createBackendServices|createAuthServices|firebase|firestore/i;
for (const f of files) {
  const code = strip(read(f)); const n = path.basename(f);
  const bad = importsOf(code).filter((i) => FORBIDDEN_IMPORT.test(i));
  check(`mã nguồn ${n}/không import uploader thật, backendClient, Firebase`, bad.length === 0, bad.join());
  check(`mã nguồn ${n}/không XMLHttpRequest, fetch, api.cloudinary.com`, !/XMLHttpRequest|\bfetch\s*\(|api\.cloudinary\.com/.test(code));
  // H4B-5: useUploadServices.js được phép đọc import.meta.env CHỈ để diễn giải VITE_UPLOAD_MODE trong nhánh thiếu Provider (cùng mẫu useGalleryServices).
  // Mọi file khác vẫn cấm import.meta.env; file đó vẫn cấm token, biến Cloudinary/Firebase và storage.
  const envForbidden = n === 'useUploadServices.js' ? /getIdToken|VITE_CLOUDINARY|VITE_FIREBASE|localStorage|sessionStorage/ : /getIdToken|VITE_CLOUDINARY|VITE_FIREBASE|localStorage|sessionStorage|import\.meta\.env/;
  // Với useUploadServices.js, điều kiện thêm: chỉ ĐÚNG MỘT chỗ import.meta.env và là VITE_UPLOAD_MODE (qua UPLOAD_ENV.mode).
  const onlyUploadModeEnv = n !== 'useUploadServices.js' || ((code.match(/import\.meta\.env/g) || []).length === 1 && /import\.meta\.env\?\.\[UPLOAD_ENV\.mode\]/.test(code));
  check(`mã nguồn ${n}/không đọc/ghi token, env Cloudinary, storage`, !envForbidden.test(code) && onlyUploadModeEnv);
  check(`mã nguồn ${n}/không console.*`, !/console\./.test(code));
}
check('mã nguồn/imageId chỉ sinh qua generateId được tiêm (không randomUUID rải rác)', files.every((f) => !/randomUUID|Math\.random/.test(strip(read(f)))));
check('mã nguồn/createUploadServices import generateId có sẵn', importsOf(strip(read('src/app/createUploadServices.js'))).includes('../infrastructure/generateId'));
check('mã nguồn/main.jsx dùng createUploadServices (mock), không dùng createCloudinaryServices/createBackendServices', (() => { const c = strip(read('src/main.jsx')); return c.includes('createUploadServices') && !/createCloudinaryServices|createBackendServices/.test(c); })());
check('mã nguồn/trang cloudinary-check.html giữ nguyên, không tự upload', (() => { const c = strip(read('tests/manual/cloudinaryCheck.js')); return /\$\('upload'\)\.addEventListener\('click'/.test(c) && /\$\('confirm'\)\.checked/.test(c); })());
check('console không bị ghi token/Bearer/imageId nhạy cảm', consoleLines.every((l) => !l.includes('Bearer')));

out(`PASSED: ${passed}`);
out(`FAILED: ${failures.length}`);
failures.forEach((f) => out('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
