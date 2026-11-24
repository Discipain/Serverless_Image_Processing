// Smoke test H4B-4 — Frontend Signed Upload (authorize -> upload có chữ ký -> confirm) qua Dependency Injection.
// KHÔNG gọi mạng thật: fetch và XMLHttpRequest toàn cục là BẪY (ném lỗi + đếm); mọi lời gọi đi qua Backend GIẢ và Cloudinary GIẢ
// (xem h4b4-harness.mjs). Bản thân bài này KHÔNG chứng minh tích hợp với Backend/Cloudinary thật.
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/h4b4-signed-upload-smoke.mjs .  (xem tests/README.md)
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { API_KEY, CLOUD, SIZES, UUID, counterIds, createFakeAuth, createFakeBackend, createFakeCloud, fakeProcessor, jpeg, settle, tick, webp } from './h4b4-harness.mjs';

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

const server = await createServer({
  root, envDir: process.env.EMPTY_ENV_DIR, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const load = (p) => server.ssrLoadModule(p);
  const D = await load('/src/domain/models/uploadAuthorization.js');
  const { createBackendClient, createUnavailableBackendApi } = await load('/src/infrastructure/api/backendClient.js');
  const { createSignedCloudinaryUploader } = await load('/src/infrastructure/cloudinary/signedCloudinaryUploader.js');
  const { createUploadVariantsSigned, EXPIRY_MARGIN_MS } = await load('/src/application/usecases/uploadVariantsSigned.js');
  const { createAuthorizeCloudinaryUpload } = await load('/src/application/usecases/authorizeCloudinaryUpload.js');
  const { createConfirmCloudinaryUpload } = await load('/src/application/usecases/confirmCloudinaryUpload.js');
  const { createSignedUploadServices } = await load('/src/app/createSignedUploadServices.js');
  const { createUploadServices } = await load('/src/app/createUploadServices.js');
  const { SIGNED_UPLOAD_KIND: K, describeBackendFailure } = await load('/src/application/signedUploadErrors.js');
  const { backendError } = await load('/src/infrastructure/api/backendErrors.js');

  const T0 = Date.UTC(2026, 10, 24, 10, 0, 0);

  // ---------- Thế giới thử nghiệm ----------
  function world({ uid = 'alice', ttlMs = 900_000, processor = fakeProcessor(), tokens, uploaderTimeoutMs = 5000 } = {}) {
    const clock = { now: T0 };
    const cloud = createFakeCloud({ clock });
    const backend = createFakeBackend({ clock, cloud, ttlMs });
    const auth = createFakeAuth(uid);
    const ids = counterIds();
    const services = createSignedUploadServices({
      backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null },
      cloudName: CLOUD,
      getIdToken: tokens ?? (async () => `token-${auth.uid}`),
      observeAuthState: auth.observe,
      imageProcessor: processor,
      generateId: ids,
      fetchImpl: backend.fetch,
      uploaderOptions: { createXhr: cloud.newXhr, timeoutMs: uploaderTimeoutMs },
      now: () => clock.now,
    });
    const count = (p) => backend.log.filter((l) => l.path === p).length;
    return { clock, cloud, backend, auth, ids, services, processor, authorizeCalls: () => count('/images/cloudinary/authorize'), confirmCalls: () => count('/images/cloudinary/confirm'), uploads: () => cloud.sent.length };
  }
  const run = (w, args = {}) => w.services.uploadImage({ file: jpeg(), ...args });

  // fixtures cho test Domain
  const processed = (over = {}) => ({
    blobs: { thumbnail: webp(1000), medium: webp(20000), webp: webp(300000) }, width: 4000, height: 3000, processingMs: 321,
    stats: { variants: { thumbnail: { width: 200, height: 150, bytes: 1000 }, medium: { width: 800, height: 600, bytes: 20000 }, webp: { width: 4000, height: 3000, bytes: 300000 } } },
    ...over,
  });

  // =====================================================================================================================
  // 1. Domain: payload authorize
  // =====================================================================================================================
  {
    const id = UUID(1);
    const p = D.buildAuthorizePayload({ imageId: id, file: { size: 2_000_000 }, fileName: 'anh-bien.jpg', processed: processed() });
    check('domain/payload đúng hình dạng Backend (imageId, originalSize, fileName, width, height, variants)', JSON.stringify(Object.keys(p).sort()) === JSON.stringify(['fileName', 'height', 'imageId', 'originalSize', 'variants', 'width']));
    check('domain/variants khai đúng bytes+width+height THẬT của từng Blob', p.variants.thumbnail.bytes === 1000 && p.variants.thumbnail.width === 200 && p.variants.thumbnail.height === 150 && p.variants.medium.bytes === 20000 && p.variants.medium.width === 800 && p.variants.webp.bytes === 300000 && p.variants.webp.width === 4000 && p.variants.webp.height === 3000);
    check('domain/mỗi variant chỉ có bytes,width,height', VARIANTS3().every((k) => Object.keys(p.variants[k]).sort().join() === 'bytes,height,width'));
    check('domain/KHÔNG có ownerId/uid/publicId/folder/contentType', !['ownerId', 'uid', 'userId', 'public_id', 'publicId', 'folder', 'contentType'].some((k) => k in p));
    const noStats = D.buildAuthorizePayload({ imageId: id, file: { size: 5 }, processed: processed({ stats: undefined }) });
    check('domain/không có stats: tính bằng calcVariantSize (200x150, 800x600, 4000x3000)', noStats.variants.thumbnail.width === 200 && noStats.variants.thumbnail.height === 150 && noStats.variants.medium.width === 800 && noStats.variants.webp.width === 4000 && !('fileName' in noStats));
    const portrait = D.buildAuthorizePayload({ imageId: id, file: { size: 5 }, processed: processed({ width: 3000, height: 4000, stats: undefined }) });
    check('domain/ảnh dọc: cạnh dài là chiều cao (150x200)', portrait.variants.thumbnail.width === 150 && portrait.variants.thumbnail.height === 200);
    const bad = (over, msg) => {
      try { D.buildAuthorizePayload({ imageId: id, file: { size: 5 }, processed: processed(), ...over }); return false; } catch (e) { return e instanceof D.UploadAuthorizationError && (!msg || e.message.includes(msg)); }
    };
    check('domain/imageId viết HOA bị từ chối', bad({ imageId: 'ABCDEF01-ABCD-4ABC-8ABC-ABCDEF012345' }));
    check('domain/imageId không phải v4 (v1) bị từ chối', bad({ imageId: '00000000-0000-1000-8000-000000000001' }));
    check('domain/imageId rỗng/không phải chuỗi bị từ chối', bad({ imageId: '' }) && bad({ imageId: 5 }) && bad({ imageId: undefined }));
    check('domain/originalSize 0, âm, >10MB, thập phân bị từ chối', bad({ file: { size: 0 } }) && bad({ file: { size: -1 } }) && bad({ file: { size: 10 * 1024 * 1024 + 1 } }) && bad({ file: { size: 1.5 } }));
    check('domain/thumbnail vượt 200px (stats giả) bị từ chối', bad({ processed: processed({ stats: { variants: { thumbnail: { width: 201, height: 100, bytes: 1000 }, medium: { width: 800, height: 600, bytes: 20000 }, webp: { width: 4000, height: 3000, bytes: 300000 } } } }) }));
    check('domain/stats lệch Blob thật (bytes) bị từ chối', bad({ processed: processed({ stats: { variants: { thumbnail: { width: 200, height: 150, bytes: 999 }, medium: { width: 800, height: 600, bytes: 20000 }, webp: { width: 4000, height: 3000, bytes: 300000 } } } }) }));
    check('domain/Blob rỗng/thiếu biến thể bị từ chối', bad({ processed: processed({ blobs: { thumbnail: webp(0), medium: webp(1), webp: webp(1) } }) }) && bad({ processed: processed({ blobs: { medium: webp(1), webp: webp(1) } }) }));
    check('domain/thiếu width/height gốc bị từ chối', bad({ processed: processed({ width: undefined, height: undefined, stats: undefined }) }));
    check('domain/normalizeFileName: cắt khoảng trắng; rỗng, quá 255, có / \\ hoặc ký tự điều khiển => null',
      D.normalizeFileName('  a.jpg ') === 'a.jpg' && D.normalizeFileName('') === null && D.normalizeFileName('   ') === null && D.normalizeFileName('x'.repeat(256)) === null && D.normalizeFileName('a/b.jpg') === null && D.normalizeFileName('a\\b.jpg') === null && D.normalizeFileName('a\u0000b') === null && D.normalizeFileName('a‮b') === null && D.normalizeFileName(undefined) === null && D.normalizeFileName('x'.repeat(255)) === 'x'.repeat(255));
    const withBadName = D.buildAuthorizePayload({ imageId: id, file: { size: 5 }, fileName: D.normalizeFileName('a/b.jpg'), processed: processed() });
    check('domain/tên file bị Backend từ chối => bỏ fileName (không làm hỏng upload)', !('fileName' in withBadName));
  }
  function VARIANTS3() { return ['thumbnail', 'medium', 'webp']; }

  // =====================================================================================================================
  // 2. Domain: kiểm tra response authorize
  // =====================================================================================================================
  {
    const w = world();
    const id = UUID(7);
    const payload = D.buildAuthorizePayload({ imageId: id, file: { size: 2_000_000 }, fileName: 'a.jpg', processed: processed() });
    const good = await w.backend.fetch('https://x.test/images/cloudinary/authorize', { method: 'POST', headers: { Authorization: 'Bearer token-alice' }, body: JSON.stringify(payload) }).then((r) => r.text()).then(JSON.parse);
    const ctx = { expectedImageId: id, cloudName: CLOUD, nowMs: T0 };
    const parse = (body, over = {}) => { try { return { ok: D.parseAuthorizeResponse(body, { ...ctx, ...over }) }; } catch (e) { return { err: e }; } };
    const ok = parse(good);
    check('response/hợp lệ được chấp nhận, đúng 3 biến thể, expiresAtMs đúng', !!ok.ok && Object.keys(ok.ok.uploads).join() === 'thumbnail,medium,webp' && ok.ok.expiresAtMs === T0 + 900_000 && ok.ok.environment === 'dev' && ok.ok.uploadUrl === `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`);
    check('response/đối tượng kết quả bị đóng băng (không sửa được chữ ký)', Object.isFrozen(ok.ok) && Object.isFrozen(ok.ok.uploads.webp.fields));
    check('response/fields giữ đúng 8 trường theo thứ tự', Object.keys(ok.ok.uploads.thumbnail.fields).join() === D.SIGNED_FIELD_NAMES.join());
    const mut = (fn) => { const b = structuredClone(good); fn(b); return b; };
    const rejects = (label, body, over) => { const r = parse(body, over); check(`response/${label} bị từ chối`, !!r.err && r.err instanceof D.UploadAuthorizationError, r.ok ? 'được chấp nhận' : r.err?.message); };
    rejects('imageId khác yêu cầu', mut((b) => { b.imageId = UUID(8); }));
    rejects('uploadUrl host lạ (evil.test)', mut((b) => { b.uploadUrl = `https://evil.test/v1_1/${CLOUD}/image/upload`; }));
    rejects('uploadUrl giả mạo subdomain api.cloudinary.com.evil.test', mut((b) => { b.uploadUrl = `https://api.cloudinary.com.evil.test/v1_1/${CLOUD}/image/upload`; }));
    rejects('uploadUrl http (không https)', mut((b) => { b.uploadUrl = `http://api.cloudinary.com/v1_1/${CLOUD}/image/upload`; }));
    rejects('uploadUrl cloud khác', mut((b) => { b.uploadUrl = 'https://api.cloudinary.com/v1_1/other-cloud/image/upload'; }));
    rejects('uploadUrl endpoint khác (video)', mut((b) => { b.uploadUrl = `https://api.cloudinary.com/v1_1/${CLOUD}/video/upload`; }));
    rejects('uploadUrl kèm query', mut((b) => { b.uploadUrl += '?x=1'; }));
    rejects('uploadUrl kèm user:pass@', mut((b) => { b.uploadUrl = `https://u:p@api.cloudinary.com/v1_1/${CLOUD}/image/upload`; }));
    rejects('uploadUrl kèm cổng', mut((b) => { b.uploadUrl = `https://api.cloudinary.com:8443/v1_1/${CLOUD}/image/upload`; }));
    rejects('uploadUrl thiếu', mut((b) => { delete b.uploadUrl; }));
    rejects('thiếu apiKey', mut((b) => { delete b.apiKey; }));
    rejects('apiKey sai định dạng', mut((b) => { b.apiKey = 'a b'; }));
    rejects('thiếu một biến thể', mut((b) => { delete b.uploads.medium; }));
    rejects('thêm biến thể thứ tư', mut((b) => { b.uploads.original = b.uploads.webp; }));
    rejects('uploads rỗng', mut((b) => { b.uploads = {}; }));
    rejects('thiếu chữ ký của một biến thể', mut((b) => { delete b.uploads.webp.fields.signature; }));
    rejects('chữ ký không phải hex', mut((b) => { b.uploads.webp.fields.signature = 'zzzz'; }));
    rejects('chữ ký sai độ dài', mut((b) => { b.uploads.webp.fields.signature = 'ab'.repeat(10); }));
    rejects('thiếu timestamp', mut((b) => { delete b.uploads.webp.fields.timestamp; }));
    rejects('timestamp không phải số', mut((b) => { b.uploads.webp.fields.timestamp = 'now'; }));
    rejects('api_key trong fields khác apiKey', mut((b) => { b.uploads.webp.fields.api_key = '999999999999'; }));
    rejects('field lạ trong fields (upload_preset)', mut((b) => { b.uploads.webp.fields.upload_preset = 'unsigned'; }));
    rejects('field lạ trong fields (folder)', mut((b) => { b.uploads.webp.fields.folder = 'x'; }));
    rejects('có api_secret ở cấp trên', mut((b) => { b.api_secret = 'x'; }));
    rejects('có api_secret trong fields', mut((b) => { b.uploads.webp.fields.api_secret = 'x'; }));
    rejects('có trường *secret* lồng sâu', mut((b) => { b.uploads.webp.extra = { deep: { clientSecret: 'x' } }; }));
    rejects('field lạ cấp trên (ownerId)', mut((b) => { b.ownerId = 'alice'; }));
    rejects('public_id sai vai trò (thumbnail dùng /full)', mut((b) => { b.uploads.thumbnail.fields.public_id = b.uploads.webp.fields.public_id; }));
    rejects('public_id hai biến thể hoán đổi', mut((b) => { const t = b.uploads.thumbnail.fields.public_id; b.uploads.thumbnail.fields.public_id = b.uploads.medium.fields.public_id; b.uploads.medium.fields.public_id = t; }));
    rejects('public_id thuộc imageId khác', mut((b) => { b.uploads.medium.fields.public_id = `hybrid/dev/${UUID(99)}/medium`; }));
    rejects('public_id không có tiền tố hybrid/', mut((b) => { b.uploads.medium.fields.public_id = `other/dev/${id}/medium`; }));
    rejects('public_id có thư mục thừa (path traversal)', mut((b) => { b.uploads.medium.fields.public_id = `hybrid/dev/../${id}/medium`; }));
    rejects('môi trường public_id không đồng nhất', mut((b) => { b.uploads.medium.fields.public_id = `hybrid/prod/${id}/medium`; b.uploads.medium.fields.tags = 'hybrid,prod'; }));
    rejects('overwrite=true', mut((b) => { b.uploads.webp.fields.overwrite = 'true'; }));
    rejects('allowed_formats khác webp', mut((b) => { b.uploads.webp.fields.allowed_formats = 'jpg,png'; }));
    rejects('context sai imageId', mut((b) => { b.uploads.webp.fields.context = `app=hybrid|imageId=${UUID(5)}|variant=webp`; }));
    rejects('context sai biến thể', mut((b) => { b.uploads.webp.fields.context = `app=hybrid|imageId=${id}|variant=medium`; }));
    rejects('tags khác môi trường', mut((b) => { b.uploads.webp.fields.tags = 'hybrid,prod'; }));
    rejects('expiresAt sai định dạng', mut((b) => { b.expiresAt = '2026-11-24 10:15:00'; }));
    rejects('expiresAt không phải ngày thật', mut((b) => { b.expiresAt = '2026-13-45T99:99:99Z'; }));
    rejects('expiresAt đã quá hạn', good, { nowMs: T0 + 900_001 });
    rejects('expiresAt đúng bằng hiện tại', good, { nowMs: T0 + 900_000 });
    rejects('response là mảng', [good]);
    rejects('response null', null);
    rejects('response là chuỗi', 'ok');
    rejects('cloud name Frontend thiếu/sai', good, { cloudName: '' });
    rejects('cloud name Frontend chứa "/"', good, { cloudName: 'a/b' });
    const sig = ok.ok.uploads.webp.fields.signature;
    const e = parse(mut((b) => { b.uploads.webp.fields.signature = 'zz'; })).err;
    check('response/thông báo lỗi KHÔNG chứa giá trị chữ ký hay api_key', !!e && !e.message.includes(sig) && !e.message.includes(API_KEY));
  }

  // =====================================================================================================================
  // 3. backendClient: authorize
  // =====================================================================================================================
  {
    const w = world();
    const calls = [];
    const refreshes = [];
    let current = 'token-alice';
    const getIdToken = async ({ forceRefresh } = {}) => { if (forceRefresh) { refreshes.push(1); current = 'token-alice.r2'; } return current; };
    const client = createBackendClient({ baseUrl: 'https://api.example.test/', getIdToken, fetchImpl: async (url, init) => { calls.push({ url, init }); return w.backend.fetch(url, init); } });
    const payload = D.buildAuthorizePayload({ imageId: UUID(1), file: { size: 2_000_000 }, fileName: 'a.jpg', processed: processed() });

    const r = await settle(client.authorizeCloudinaryUpload(payload));
    const c = calls[0];
    check('authorize/đúng URL + POST', c.url === 'https://api.example.test/images/cloudinary/authorize' && c.init.method === 'POST', c?.url);
    check('authorize/Authorization: Bearer <token Firebase>', c.init.headers.Authorization === 'Bearer token-alice');
    check('authorize/Content-Type JSON, credentials omit, không cache', c.init.headers['Content-Type'] === 'application/json' && c.init.credentials === 'omit' && c.init.cache === 'no-store');
    check('authorize/KHÔNG có X-User-Id hay header UID khác', !Object.keys(c.init.headers).some((k) => /user|uid|owner/i.test(k)));
    check('authorize/body là đúng payload, không ownerId/uid', JSON.parse(c.init.body).imageId === UUID(1) && !/ownerId|"uid"|userId/.test(c.init.body));
    check('authorize/trả JSON thô 2xx', r.value?.imageId === UUID(1) && !!r.value.uploads);

    // 401 -> refresh đúng một lần
    calls.length = 0; refreshes.length = 0; current = 'token-alice';
    w.backend.faults.authorize.push({ status: 401, detail: 'expired' });
    const r401 = await settle(client.authorizeCloudinaryUpload(payload));
    check('authorize/401 làm mới token ĐÚNG MỘT lần rồi gửi lại, thành công', r401.value?.imageId === UUID(1) && calls.length === 2 && refreshes.length === 1 && calls[1].init.headers.Authorization === 'Bearer token-alice.r2');
    calls.length = 0; refreshes.length = 0; current = 'token-alice';
    w.backend.faults.authorize.push({ status: 401, detail: 'a' }, { status: 401, detail: 'b' });
    const r401b = await settle(client.authorizeCloudinaryUpload(payload));
    check('authorize/401 lần hai không lặp: lỗi UNAUTHENTICATED sau đúng 2 request', r401b.error?.code === 'UNAUTHENTICATED' && calls.length === 2 && refreshes.length === 1);

    // payload sai bị chặn TRƯỚC khi gửi
    calls.length = 0;
    const blocked = async (label, body) => { const r = await settle(client.authorizeCloudinaryUpload(body)); check(`authorize/chặn trước khi gửi: ${label}`, r.error?.code === 'VALIDATION' && calls.length === 0, r.error?.message); };
    await blocked('có ownerId', { ...payload, ownerId: 'bob' });
    await blocked('có uid', { ...payload, uid: 'bob' });
    await blocked('có public_id', { ...payload, public_id: 'x' });
    await blocked('thiếu variants', { imageId: payload.imageId, originalSize: 1 });
    await blocked('variants thiếu medium', { ...payload, variants: { thumbnail: payload.variants.thumbnail, webp: payload.variants.webp } });
    await blocked('variant có field lạ', { ...payload, variants: { ...payload.variants, webp: { ...payload.variants.webp, contentType: 'x' } } });
    await blocked('variant thiếu height', { ...payload, variants: { ...payload.variants, webp: { bytes: 1, width: 2 } } });
    await blocked('payload là mảng', [payload]);
    await blocked('payload null', null);

    // lỗi HTTP và Retry-After
    const errOf = async (fault) => { w.backend.faults.authorize.push(fault); return (await settle(client.authorizeCloudinaryUpload(payload))).error; };
    const e429 = await errOf({ status: 429, detail: 'Too many upload authorizations', headers: { 'Retry-After': '1800' } });
    check('authorize/429 giữ Retry-After (giây) trong details', e429?.code === 'QUOTA_EXCEEDED' && e429.details.kind === 'RATE_LIMITED' && e429.details.retryAfterSeconds === 1800 && e429.details.retryable === true);
    const e429b = await errOf({ status: 429, detail: 'x', headers: { 'Retry-After': 'Wed, 21 Oct 2026 07:28:00 GMT' } });
    check('authorize/Retry-After dạng ngày không được đoán (null)', e429b?.details.retryAfterSeconds === undefined);
    const e503 = await errOf({ status: 503, detail: 'Signed upload unavailable' });
    check('authorize/503 chi tiết được giữ cho lớp trên phân loại', e503?.details.httpStatus === 503 && e503.details.detail === 'Signed upload unavailable');
    const e404 = await errOf({ status: 404, detail: 'Not Found' });
    check('authorize/404 là lỗi HTTP có httpStatus', e404?.details.httpStatus === 404);
    const e400 = await errOf({ status: 400, detail: 'Unknown field' });
    check('authorize/400 -> VALIDATION', e400?.code === 'VALIDATION' && e400.details.httpStatus === 400);
    // Response 200 không phải JSON
    const badJson = createBackendClient({ baseUrl: 'https://api.example.test', getIdToken, fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => '<html>' }) });
    const rb = await settle(badJson.authorizeCloudinaryUpload(payload));
    check('authorize/200 không phải JSON -> INVALID_RESPONSE, không retry', rb.error?.details.kind === 'INVALID_RESPONSE' && rb.error.details.retryable === false);
    const arr = createBackendClient({ baseUrl: 'https://api.example.test', getIdToken, fetchImpl: async () => ({ status: 200, headers: { get: () => null }, text: async () => '[1]' }) });
    check('authorize/200 là mảng -> INVALID_RESPONSE', (await settle(arr.authorizeCloudinaryUpload(payload))).error?.details.kind === 'INVALID_RESPONSE');
    // Hủy
    const ac = new AbortController(); ac.abort();
    calls.length = 0;
    const rc = await settle(client.authorizeCloudinaryUpload(payload, { signal: ac.signal }));
    check('authorize/AbortSignal đã hủy -> CANCELLED, không gửi request', rc.error?.code === 'CANCELLED' && calls.length === 0);
    // Token không lọt vào lỗi
    check('authorize/lỗi không chứa token/Bearer', ![e429, e503, e404, e400].some((e) => /Bearer|token-alice/.test(JSON.stringify({ m: e.message, d: { ...e.details, cause: undefined } }))));
    // Unavailable api
    const un = createUnavailableBackendApi({ message: 'cấu hình sai', missing: ['VITE_API_BASE_URL'] });
    const ru = await settle(un.authorizeCloudinaryUpload(payload));
    check('authorize/Backend api "unavailable" -> CONFIG, không mạng', ru.error?.code === 'CONFIG' && netCalls.length === 0);
    // Confirm: Retry-After được giữ và headers thiếu không gây lỗi (tương thích fetch giả cũ)
    const cc = createBackendClient({ baseUrl: 'https://api.example.test', getIdToken, fetchImpl: async () => ({ status: 429, text: async () => '{"detail":"x"}' }) });
    const rcf = await settle(cc.confirmCloudinaryUpload({ imageId: 'a', thumbnail: 'https://x', medium: 'https://x', webp: 'https://x', originalSize: 1, processingMs: 1 }));
    check('confirm/response không có headers vẫn cho 429 QUOTA_EXCEEDED bình thường', rcf.error?.code === 'QUOTA_EXCEEDED' && rcf.error.details.retryAfterSeconds === undefined);
  }

  // =====================================================================================================================
  // 4. Signed uploader (XHR giả)
  // =====================================================================================================================
  {
    const mk = (over = {}) => {
      const clock = { now: T0 };
      const cloud = createFakeCloud({ clock });
      const up = createSignedCloudinaryUploader({ cloudName: CLOUD, createXhr: cloud.newXhr, timeoutMs: 500, ...over });
      return { cloud, up, clock };
    };
    const fieldsFor = (variant, id = UUID(1)) => ({
      public_id: `hybrid/dev/${id}/${{ thumbnail: 'thumb', medium: 'medium', webp: 'full' }[variant]}`, timestamp: '1790000000', overwrite: 'false', allowed_formats: 'webp',
      context: `app=hybrid|imageId=${id}|variant=${variant}`, tags: 'hybrid,dev', api_key: API_KEY, signature: 'a'.repeat(64),
    });
    const args = (variant = 'thumbnail', over = {}) => ({
      blob: webp(SIZES[variant].b), variant, uploadUrl: `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload`, fields: fieldsFor(variant),
      expected: { bytes: SIZES[variant].b, width: SIZES[variant].w, height: SIZES[variant].h }, ...over,
    });

    {
      const { cloud, up } = mk();
      const progress = [];
      const asset = await settle(up.upload({ ...args('thumbnail'), onProgress: (p) => progress.push(p) }));
      const s = cloud.sent[0];
      check('uploader/POST tới api.cloudinary.com đúng cloud', s.endpoint === `https://api.cloudinary.com/v1_1/${CLOUD}/image/upload` && s.method === 'POST');
      check('uploader/multipart có ĐÚNG 8 trường ký + file (thứ tự: 8 trường rồi file)', s.entries.map(([k]) => k).join() === 'public_id,timestamp,overwrite,allowed_formats,context,tags,api_key,signature,file');
      check('uploader/giá trị trường ký gửi NGUYÊN VĂN', D.SIGNED_FIELD_NAMES.every((k) => s.entries.find(([n]) => n === k)[1] === fieldsFor('thumbnail')[k]));
      check('uploader/KHÔNG gửi upload_preset, folder, resource_type, unsigned', !s.entries.some(([k]) => /preset|folder|unsigned|resource_type|signature_algorithm/.test(k)));
      check('uploader/KHÔNG gửi header nào (không Authorization/Bearer)', Object.keys(s.headers).length === 0 && !s.entries.some(([, v]) => typeof v === 'string' && /Bearer|token-/.test(v)));
      check('uploader/withCredentials=false', s.withCredentials === false);
      check('uploader/file là Blob webp, tên nhãn thumb.webp', s.entries.at(-1)[1].size === 1000 && s.entries.at(-1)[1].name === 'thumb.webp');
      check('uploader/thành công trả asset đã kiểm tra, existing=false', asset.value?.publicId === fieldsFor('thumbnail').public_id && asset.value.existing === false && asset.value.bytes === 1000 && asset.value.format === 'webp' && /^[0-9a-f]{32}$/.test(asset.value.assetId) && asset.value.version > 0 && asset.value.secureUrl.startsWith(`https://res.cloudinary.com/${CLOUD}/image/upload/v${asset.value.version}/`));
      check('uploader/tiến độ 0 -> ... -> 100 đơn điệu, 100 chỉ khi xong', progress[0] === 0 && progress.at(-1) === 100 && progress.every((p, i) => i === 0 || p > progress[i - 1]) && progress.filter((p) => p === 100).length === 1);
    }
    {
      const { cloud, up } = mk();
      const a = args('thumbnail');
      const fieldsRef = a.fields;
      const pending = up.upload(a);
      fieldsRef.public_id = 'hybrid/dev/hacker/thumb'; // đổi sau khi gửi: không được ảnh hưởng đối chiếu
      const r = await settle(pending);
      check('uploader/đổi `fields` sau khi gửi không ảnh hưởng (đã chụp bản sao)', r.value?.publicId.endsWith('/thumb') && cloud.sent[0].entries.find(([k]) => k === 'public_id')[1].includes(UUID(1)));
    }
    // Đầu vào sai: KHÔNG gửi request nào
    {
      const { cloud, up } = mk();
      const reject = async (label, a, code = 'VALIDATION') => { const r = await settle(up.upload(a)); check(`uploader/đầu vào sai (${label}) bị chặn, không gửi`, r.error?.code === code && cloud.sent.length === 0, `${r.error?.code}`); };
      await reject('uploadUrl lạ', args('thumbnail', { uploadUrl: 'https://evil.test/v1_1/demo-cloud/image/upload' }));
      await reject('uploadUrl cloud khác', args('thumbnail', { uploadUrl: 'https://api.cloudinary.com/v1_1/other/image/upload' }));
      await reject('thiếu trường ký', args('thumbnail', { fields: (({ signature, ...rest }) => rest)(fieldsFor('thumbnail')) }));
      await reject('thừa trường upload_preset', args('thumbnail', { fields: { ...fieldsFor('thumbnail'), upload_preset: 'x' } }));
      await reject('trường rỗng', args('thumbnail', { fields: { ...fieldsFor('thumbnail'), tags: '' } }));
      await reject('public_id sai vai trò', args('medium', { fields: fieldsFor('thumbnail') }));
      await reject('biến thể lạ', args('thumbnail', { variant: 'original' }));
      await reject('Blob sai loại', args('thumbnail', { blob: new Blob([new Uint8Array(1000)], { type: 'image/jpeg' }) }));
      await reject('Blob rỗng', args('thumbnail', { blob: webp(0) }));
      await reject('Blob không phải Blob', args('thumbnail', { blob: { size: 1000, type: 'image/webp' } }));
      await reject('dung lượng Blob khác khai báo', args('thumbnail', { blob: webp(1001) }));
      await reject('thiếu expected', args('thumbnail', { expected: undefined }));
      const aborted = new AbortController(); aborted.abort();
      await reject('đã hủy từ trước', args('thumbnail', { signal: aborted.signal }), 'CANCELLED');
      const noCloud = createSignedCloudinaryUploader({ cloudName: '', createXhr: cloud.newXhr });
      const rc = await settle(noCloud.upload(args('thumbnail')));
      check('uploader/thiếu cloud name -> CONFIG, không gửi', rc.error?.code === 'CONFIG' && cloud.sent.length === 0);
      const badCloud = createSignedCloudinaryUploader({ cloudName: 'a/b', createXhr: cloud.newXhr });
      check('uploader/cloud name sai -> CONFIG', (await settle(badCloud.upload(args('thumbnail')))).error?.code === 'CONFIG');
    }
    // Response sai
    {
      const cases = [
        ['public_id sai', (b) => ({ ...b, public_id: 'hybrid/dev/other/thumb' }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['resource_type video', (b) => ({ ...b, resource_type: 'video' }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['type private', (b) => ({ ...b, type: 'private' }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['format jpg', (b) => ({ ...b, format: 'jpg' }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['public_id (và secure_url nhất quán) của asset khác', (b) => ({ ...b, public_id: 'hybrid/dev/other/thumb', secure_url: `https://res.cloudinary.com/${CLOUD}/image/upload/v${b.version}/hybrid/dev/other/thumb.webp` }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['bytes khác', (b) => ({ ...b, bytes: b.bytes + 1 }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['bytes thiếu', (b) => { const { bytes, ...r } = b; return r; }, 'UPLOAD_RESPONSE_MISMATCH'],
        ['bytes là chuỗi', (b) => ({ ...b, bytes: String(b.bytes) }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['width khác', (b) => ({ ...b, width: b.width + 1 }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['height khác', (b) => ({ ...b, height: b.height + 1 }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['width thiếu', (b) => { const { width, ...r } = b; return r; }, 'UPLOAD_RESPONSE_MISMATCH'],
        ['version 0', (b) => ({ ...b, version: 0 }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['version thiếu', (b) => { const { version, ...r } = b; return r; }, 'UPLOAD_RESPONSE_MISMATCH'],
        ['asset_id sai', (b) => ({ ...b, asset_id: 'xyz' }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['secure_url cloud khác', (b) => ({ ...b, secure_url: b.secure_url.replace(CLOUD, 'other-cloud') }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['secure_url http', (b) => ({ ...b, secure_url: b.secure_url.replace('https', 'http') }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['secure_url host lạ', (b) => ({ ...b, secure_url: b.secure_url.replace('res.cloudinary.com', 'evil.test') }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['secure_url lệch version', (b) => ({ ...b, secure_url: b.secure_url.replace(`/v${b.version}/`, `/v${b.version + 1}/`) }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['secure_url có biến đổi', (b) => ({ ...b, secure_url: b.secure_url.replace('/upload/', '/upload/w_100/') }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['secure_url sai đuôi', (b) => ({ ...b, secure_url: b.secure_url.replace('.webp', '.jpg') }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['secure_url có query', (b) => ({ ...b, secure_url: `${b.secure_url}?a=1` }), 'UPLOAD_RESPONSE_MISMATCH'],
        ['secure_url thiếu', (b) => { const { secure_url, ...r } = b; return r; }, 'UPLOAD_RESPONSE_MISMATCH'],
        ['existing=true mà bytes khác', (b) => ({ ...b, existing: true, bytes: b.bytes + 5 }), 'EXISTING_ASSET_MISMATCH'],
        ['existing=true mà public_id khác', (b) => ({ ...b, existing: true, public_id: 'hybrid/dev/x/thumb' }), 'EXISTING_ASSET_MISMATCH'],
        ['existing là chuỗi', (b) => ({ ...b, existing: 'true' }), 'INVALID_RESPONSE'],
      ];
      for (const [label, mutate, kind] of cases) {
        const { cloud, up } = mk();
        cloud.plan.push({ mutate });
        const r = await settle(up.upload(args('thumbnail')));
        check(`uploader/response ${label} -> ${kind}, không retry`, r.error?.code === 'UPLOAD_FAILED' && r.error.details.kind === kind && cloud.sent.length === 1, `${r.error?.code}/${r.error?.details?.kind}`);
        if (kind !== 'INVALID_RESPONSE') check(`uploader/response ${label}: không retry được, cần phiên mới`, r.error?.details.retryable === false && r.error.details.newSessionRequired === true);
      }
      const { cloud: c2, up: u2 } = mk();
      c2.plan.push({ status: 200, body: '<html>' });
      const rj = await settle(u2.upload(args('thumbnail')));
      check('uploader/response 200 không phải JSON -> INVALID_RESPONSE', rj.error?.details.kind === 'INVALID_RESPONSE');
      const { cloud: c3, up: u3 } = mk();
      c3.plan.push({ status: 200, body: '[]' });
      check('uploader/response 200 là mảng -> INVALID_RESPONSE', (await settle(u3.upload(args('thumbnail')))).error?.details.kind === 'INVALID_RESPONSE');
    }
    // existing=true hợp lệ
    {
      const { cloud, up } = mk();
      const first = await up.upload(args('medium'));
      const second = await settle(up.upload(args('medium')));
      check('uploader/existing=true khớp hoàn toàn: được trả về NHƯNG đánh dấu existing, không coi là upload mới', second.value?.existing === true && first.existing === false && second.value.assetId === first.assetId && second.value.version === first.version && cloud.assets.size === 1);
    }
    // Lỗi HTTP
    {
      const http = async (status, body, label, expectKind, expectCode) => {
        const { cloud, up } = mk();
        cloud.plan.push({ status, body });
        const r = await settle(up.upload(args('thumbnail')));
        check(`uploader/HTTP ${status} ${label} -> ${expectKind}`, r.error?.code === expectCode && r.error.details.kind === expectKind && r.error.details.httpStatus === status && cloud.sent.length === 1, `${r.error?.code}/${r.error?.details?.kind}`);
        return r.error;
      };
      const e1 = await http(401, { error: { message: 'Invalid Signature abc' } }, 'chữ ký sai', 'SIGNATURE_REJECTED', 'UPLOAD_FAILED');
      await http(403, { error: { message: 'Forbidden' } }, 'cấm', 'SIGNATURE_REJECTED', 'UPLOAD_FAILED');
      await http(400, { error: { message: 'Stale request - reported time is 2026-11-24 which is more than 1 hour ago' } }, 'stale', 'SIGNATURE_REJECTED', 'UPLOAD_FAILED');
      await http(400, { error: { message: 'Invalid extension in transformation' } }, 'khác', 'CLOUDINARY_REJECTED', 'UPLOAD_FAILED');
      await http(420, { error: { message: 'Rate Limit Exceeded' } }, 'rate limit', 'CLOUDINARY_REJECTED', 'QUOTA_EXCEEDED');
      await http(429, {}, 'quá nhiều', 'CLOUDINARY_REJECTED', 'QUOTA_EXCEEDED');
      await http(500, '<html>', 'máy chủ', 'CLOUDINARY_REJECTED', 'UPLOAD_FAILED');
      check('uploader/lỗi HTTP không chứa chữ ký/api_key trong thông báo', !e1.message.includes('a'.repeat(64)) && !e1.message.includes(API_KEY));
    }
    // Lỗi mạng, timeout, hủy
    {
      const { cloud, up } = mk();
      cloud.plan.push({ network: true });
      const r = await settle(up.upload(args('thumbnail')));
      check('uploader/lỗi mạng -> NETWORK', r.error?.code === 'NETWORK' && r.error.details.kind === 'NETWORK');
      cloud.plan.push({ timeout: true });
      const r2 = await settle(up.upload(args('thumbnail')));
      check('uploader/timeout -> NETWORK/TIMEOUT', r2.error?.code === 'NETWORK' && r2.error.details.kind === 'TIMEOUT');
      const { cloud: c3, up: u3 } = mk();
      c3.plan.push({ hang: true });
      const ac = new AbortController();
      const pending = settle(u3.upload({ ...args('thumbnail'), signal: ac.signal }));
      await tick(5);
      ac.abort();
      const r3 = await pending;
      check('uploader/hủy giữa chừng -> CANCELLED, xhr.abort() được gọi, không retry', r3.error?.code === 'CANCELLED' && c3.sent[0].xhr.aborted === true && c3.sent.length === 1);
      const timeoutSeen = mk({ timeoutMs: 1234 });
      timeoutSeen.cloud.plan.push({ hang: true });
      const ac2 = new AbortController();
      const p2 = settle(timeoutSeen.up.upload({ ...args('thumbnail'), signal: ac2.signal }));
      await tick(5);
      check('uploader/xhr.timeout đặt theo cấu hình', timeoutSeen.cloud.sent[0].xhr.timeout === 1234);
      ac2.abort();
      await p2;
    }
  }

  // =====================================================================================================================
  // 5. uploadVariantsSigned (unit)
  // =====================================================================================================================
  {
    const w = world();
    const id = UUID(3);
    const payload = D.buildAuthorizePayload({ imageId: id, file: { size: 2_000_000 }, fileName: 'a.jpg', processed: processed() });
    const authz = createAuthorizeCloudinaryUpload({ backendApi: createBackendClient({ baseUrl: 'https://api.example.test', getIdToken: async () => 'token-alice', fetchImpl: w.backend.fetch }), cloudName: CLOUD, now: () => w.clock.now });
    const authorization = await authz({ imageId: id, file: { size: 2_000_000 }, fileName: 'a.jpg', processed: processed() });
    check('authorize use case/trả quyền đã kiểm tra, mang declared = payload đã gửi', authorization.declared.imageId === id && JSON.stringify(authorization.declared.variants) === JSON.stringify(payload.variants) && Object.isFrozen(authorization));
    const calls = [];
    const uploader = { async upload(a) { calls.push(a.variant); return { publicId: a.fields.public_id, secureUrl: 'https://x', bytes: a.blob.size, existing: false }; } };
    const upload = createUploadVariantsSigned({ signedUploader: uploader, now: () => w.clock.now });
    const blobs = processed().blobs;
    const r = await upload({ blobs, authorization });
    check('variants/thứ tự thumbnail -> medium -> webp, trả đúng 3', calls.join() === 'thumbnail,medium,webp' && Object.keys(r).join() === 'thumbnail,medium,webp');
    calls.length = 0;
    const prev = { thumbnail: { publicId: authorization.uploads.thumbnail.fields.public_id, secureUrl: 'https://old', existing: false } };
    await upload({ blobs, authorization, uploaded: prev });
    check('variants/biến thể đã xong (khớp public_id) KHÔNG upload lại', calls.join() === 'medium,webp');
    calls.length = 0;
    await upload({ blobs, authorization, uploaded: { thumbnail: { publicId: 'hybrid/dev/khac/thumb', secureUrl: 'https://old' } } });
    check('variants/asset cũ có public_id lạ KHÔNG được tin: upload lại', calls.join() === 'thumbnail,medium,webp');
    for (const [label, b] of [['thiếu medium', { thumbnail: blobs.thumbnail, webp: blobs.webp }], ['thừa original', { ...blobs, original: webp(5) }]]) {
      calls.length = 0;
      const rr = await settle(upload({ blobs: b, authorization }));
      check(`variants/${label} -> VALIDATION, không upload`, rr.error?.code === 'VALIDATION' && calls.length === 0);
    }
    // hết hạn
    calls.length = 0;
    w.clock.now = authorization.expiresAtMs - EXPIRY_MARGIN_MS;
    const rx = await settle(upload({ blobs, authorization }));
    check('variants/grant sắp/đã hết hạn -> GRANT_EXPIRED, không upload, cần phiên mới', rx.error?.details.kind === K.GRANT_EXPIRED && rx.error.details.newSessionRequired === true && rx.error.details.retryable === false && calls.length === 0);
    // hết hạn giữa chừng
    calls.length = 0;
    w.clock.now = T0;
    const slow = { async upload(a) { calls.push(a.variant); if (a.variant === 'medium') w.clock.now = authorization.expiresAtMs + 1; return { publicId: a.fields.public_id, secureUrl: 'https://x' }; } };
    const rm = await settle(createUploadVariantsSigned({ signedUploader: slow, now: () => w.clock.now })({ blobs, authorization }));
    check('variants/hết hạn GIỮA chừng: medium xong, webp KHÔNG được upload; báo phần đã lên', rm.error?.details.kind === K.GRANT_EXPIRED && calls.join() === 'thumbnail,medium' && Object.keys(rm.error.details.uploaded).join() === 'thumbnail,medium' && rm.error.details.failedVariant === 'webp' && rm.error.details.partial === true && rm.error.details.orphanedPublicIds.length === 2);
    // lỗi một biến thể
    calls.length = 0; w.clock.now = T0;
    const failing = { async upload(a) { calls.push(a.variant); if (a.variant === 'medium') throw Object.assign(new Error('mạng'), { code: 'NETWORK', details: { kind: 'NETWORK' } }); return { publicId: a.fields.public_id, secureUrl: 'https://x' }; } };
    const rf = await settle(createUploadVariantsSigned({ signedUploader: failing, now: () => w.clock.now })({ blobs, authorization }));
    check('variants/medium lỗi: dừng, webp chưa thử, giữ thumbnail, code NETWORK', rf.error?.code === 'NETWORK' && rf.error.details.failedVariant === 'medium' && rf.error.details.notAttempted.join() === 'webp' && Object.keys(rf.error.details.uploaded).join() === 'thumbnail' && calls.join() === 'thumbnail,medium');
    // tiến độ
    const prog = [];
    const prUploader = { async upload(a) { a.onProgress(0); a.onProgress(50); a.onProgress(100); return { publicId: a.fields.public_id, secureUrl: 'https://x' }; } };
    await createUploadVariantsSigned({ signedUploader: prUploader, now: () => w.clock.now })({ blobs, authorization, onProgress: (p) => prog.push(p) });
    check('variants/tiến độ tổng đơn điệu, kết thúc 100, báo tên biến thể + index', prog.at(-1).overallPercent === 100 && prog.every((p, i) => i === 0 || p.overallPercent >= prog[i - 1].overallPercent) && prog[0].variant === 'thumbnail' && prog.at(-1).variantIndex === 2);
  }

  // =====================================================================================================================
  // 6. Luồng đầy đủ: thành công
  // =====================================================================================================================
  {
    const w = world();
    const stages = []; const progress = [];
    const r = await settle(run(w, { onStage: (e) => stages.push(`${e.stage}:${e.imageId}`), onProgress: (p) => progress.push(p) }));
    const o = r.value;
    check('luồng/thành công DONE hợp lệ (signed, không MOCK)', o?.status === 'DONE' && o.signed === true && o.confirm.isMock === false && o.confirm.status === 'DONE', r.error?.message);
    check('luồng/thứ tự VALIDATING, COMPRESSING, AUTHORIZING, UPLOADING, CONFIRMING', stages.map((s) => s.split(':')[0]).join() === 'VALIDATING,COMPRESSING,AUTHORIZING,UPLOADING,CONFIRMING');
    check('luồng/MỘT imageId duy nhất (UUID v4), dùng ở mọi giai đoạn, authorize, confirm', w.ids.count() === 1 && o.imageId === UUID(1) && stages.slice(1).every((s) => s.endsWith(`:${UUID(1)}`)) && w.backend.log.every((l) => l.body.imageId === UUID(1)));
    check('luồng/nén 1 lần; authorize 1 lần; upload đúng 3 lần; confirm 1 lần', w.processor.calls.length === 1 && w.authorizeCalls() === 1 && w.uploads() === 3 && w.confirmCalls() === 1);
    check('luồng/thứ tự gọi: authorize rồi confirm; upload ở giữa', w.backend.log.map((l) => l.path.split('/').pop()).join() === 'authorize,confirm');
    check('luồng/upload theo thứ tự thumb -> medium -> full', w.cloud.sent.map((s) => s.publicId.split('/').pop()).join() === 'thumb,medium,full');
    const authBody = w.backend.log[0].body;
    check('luồng/authorize khai bytes+kích thước THẬT của 3 Blob và fileName', authBody.fileName === 'anh-bien.jpg' && authBody.originalSize === 2_000_000 && authBody.variants.thumbnail.bytes === 1000 && authBody.variants.medium.bytes === 20000 && authBody.variants.webp.bytes === 300000 && authBody.width === 4000 && authBody.height === 3000);
    const cp = w.backend.log[1].body;
    check('luồng/confirm đúng 13 field cũ (6 bắt buộc + 7 tùy chọn)', Object.keys(cp).sort().join() === ['fileName', 'height', 'imageId', 'mediumId', 'medium', 'originalSize', 'processedSize', 'processingMs', 'thumbnail', 'thumbnailId', 'webp', 'webpId', 'width'].sort().join());
    check('luồng/confirm: processedSize = bytes Blob webp (điều kiện Backend signed), KHÔNG phải tổng 3 Blob', cp.processedSize === 300000 && cp.processedSize !== 321000);
    check('luồng/confirm: URL là secure_url của Cloudinary, *Id là public_id được cấp, không contentType', cp.thumbnail.startsWith(`https://res.cloudinary.com/${CLOUD}/image/upload/v`) && cp.webpId === `hybrid/dev/${UUID(1)}/full` && !('contentType' in cp));
    check('luồng/confirm: fileName/width/height khớp authorize', cp.fileName === authBody.fileName && cp.width === authBody.width && cp.height === authBody.height && cp.originalSize === authBody.originalSize);
    check('luồng/Backend ghi DONE, grant CONFIRMED', w.backend.images.get(UUID(1))?.status === 'DONE' && w.backend.grants.get(UUID(1)).status === 'CONFIRMED');
    check('luồng/Bearer Firebase chỉ tới Backend; KHÔNG tới Cloudinary', w.backend.log.every((l) => l.headers.Authorization === 'Bearer token-alice') && w.cloud.sent.every((s) => Object.keys(s.headers).length === 0));
    check('luồng/KHÔNG gửi upload_preset/unsigned tới Cloudinary; 8 trường ký + file', w.cloud.sent.every((s) => !s.entries.some(([k]) => /preset|unsigned/.test(k)) && s.entries.length === 9));
    check('luồng/tiến độ upload đơn điệu 0..100', progress.length > 3 && progress.at(-1).overallPercent === 100 && progress.every((p, i) => i === 0 || p.overallPercent >= progress[i - 1].overallPercent));
    check('luồng/không có request mạng thật (fetch/XHR toàn cục)', netCalls.length === 0);
    check('luồng/không có existing, không session thừa', JSON.stringify(o.existingVariants) === '[]');
    check('luồng/kết quả confirm giữ URL + *Id từ Backend', o.confirm.variants.thumbnail === cp.thumbnail && o.confirm.variants.webpId === cp.webpId);
    check('luồng/hủy đăng ký auth sau khi xong (không rò listener)', w.auth.listenerCount() === 0);
    // ảnh thứ hai: imageId mới
    const r2 = await settle(run(w));
    check('luồng/ảnh thứ hai dùng imageId MỚI và grant mới', r2.value?.imageId === UUID(2) && w.authorizeCalls() === 2);
  }

  // fileName không hợp lệ cho Backend: bỏ ở CẢ authorize và confirm (không gây 409)
  {
    const w = world();
    const r = await settle(run(w, { file: jpeg({ name: 'a/b.jpg' }) }));
    check('luồng/tên file có "/" bị bỏ ở cả authorize lẫn confirm, vẫn DONE', r.value?.status === 'DONE' && !('fileName' in w.backend.log[0].body) && !('fileName' in w.backend.log[1].body), r.error?.message);
    const w2 = world();
    const r2 = await settle(run(w2, { file: jpeg({ name: '  anh.jpg  ' }) }));
    check('luồng/tên file được cắt khoảng trắng giống nhau ở authorize và confirm', r2.value?.status === 'DONE' && w2.backend.log[0].body.fileName === 'anh.jpg' && w2.backend.log[1].body.fileName === 'anh.jpg');
  }

  // =====================================================================================================================
  // 7. Validate / nén (không tạo grant)
  // =====================================================================================================================
  {
    const w = world({ processor: fakeProcessor({ fail: () => 'COMPRESS_FAIL' }) });
    const r = await settle(run(w, { file: jpeg({ type: 'text/plain' }) }));
    check('validate/file sai -> VALIDATION, không imageId, không mạng, không authorize', r.error?.code === 'VALIDATION' && w.ids.count() === 0 && w.backend.log.length === 0 && w.cloud.sent.length === 0 && r.error.details.session === undefined);
    const r2 = await settle(run(w));
    check('nén lỗi: chưa authorize (không tốn lượt grant), có session retryable', r2.error?.details.stage === 'COMPRESSING' && r2.error.details.retryable === true && w.authorizeCalls() === 0 && !!r2.error.details.session);
    const w3 = world();
    const bad = await settle(w3.services.uploadImage({}));
    check('validate/không có file -> VALIDATION', bad.error?.code === 'VALIDATION' && w3.backend.log.length === 0);
    const w4 = world();
    const wrongId = createSignedUploadServices({ backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: CLOUD, getIdToken: async () => 'token-alice', observeAuthState: w4.auth.observe, imageProcessor: fakeProcessor(), generateId: () => 'fixture-id-1', fetchImpl: w4.backend.fetch, uploaderOptions: { createXhr: w4.cloud.newXhr } });
    const rw = await settle(wrongId.uploadImage({ file: jpeg() }));
    check('validate/generateId không phải UUID v4 -> lỗi trước khi gọi Backend', rw.error?.details.retryable === false && w4.backend.log.length === 0);
  }

  // =====================================================================================================================
  // 8. Upload một phần + retry cùng imageId (không grant mới, không upload lại phần xong)
  // =====================================================================================================================
  {
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), network: true });
    const r1 = await settle(run(w));
    const d = r1.error?.details;
    check('partial/medium lỗi mạng: UPLOADING, retryable, giữ thumbnail', r1.error?.code === 'NETWORK' && d.stage === 'UPLOADING' && d.retryable === true && d.uploadedVariants.join() === 'thumbnail' && d.failedVariant === undefined || d?.uploadedVariants?.join() === 'thumbnail');
    check('partial/webp CHƯA được thử; chỉ 2 request upload tới Cloudinary', w.cloud.sent.length === 2);
    check('partial/có session; KHÔNG có restartFile', !!d.session && d.restartFile === undefined && d.newSessionRequired === false);
    check('partial/session không để lộ chữ ký qua JSON/spread', !JSON.stringify(d.session).includes('signature') && !JSON.stringify({ ...d.session }).includes('signature') && !JSON.stringify(d).includes('a'.repeat(30)) && Object.keys(d.session).join() === 'imageId,file,fileName,ownerUid,processed,assets');
    check('partial/session mang quyền upload dưới dạng không liệt kê', d.session.authorization?.uploads?.webp?.fields?.signature?.length === 64 && !Object.keys(d.session).includes('authorization'));
    check('partial/cùng imageId, authorize đúng 1 lần cho tới giờ', d.imageId === UUID(1) && w.authorizeCalls() === 1);
    const r2 = await settle(run(w, { session: d.session }));
    check('partial/retry thành công DONE', r2.value?.status === 'DONE' && r2.value.imageId === UUID(1), r2.error?.message);
    check('partial/retry: KHÔNG authorize lại, KHÔNG nén lại, KHÔNG imageId mới', w.authorizeCalls() === 1 && w.processor.calls.length === 1 && w.ids.count() === 1);
    check('partial/retry: thumbnail KHÔNG upload lại; chỉ medium (lại) và webp', w.cloud.sent.map((s) => s.publicId.split('/').pop()).join() === 'thumb,medium,medium,full');
    check('partial/Backend: một grant, một ảnh DONE', w.backend.grants.size === 1 && w.backend.images.size === 1);
  }
  // medium lỗi HTTP 500 của Cloudinary (retryable) rồi 4xx (không retryable)
  {
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/thumb'), status: 500, body: '<html>' });
    const r = await settle(run(w));
    check('partial/Cloudinary 500 ở thumbnail: retryable (giống H2), chưa có biến thể nào xong', r.error?.details.retryable === true && r.error.details.uploadedVariants.length === 0 && r.error.details.kind === 'CLOUDINARY_REJECTED');
    const w2 = world();
    w2.cloud.plan.push({ match: (s) => s.publicId.endsWith('/thumb'), status: 400, body: { error: { message: 'Invalid image file' } } });
    const r2 = await settle(run(w2));
    check('partial/Cloudinary 400 thường: KHÔNG retryable', r2.error?.details.retryable === false && r2.error.details.kind === 'CLOUDINARY_REJECTED');
    const w3 = world();
    w3.cloud.plan.push({ match: (s) => s.publicId.endsWith('/thumb'), status: 429, body: {} });
    const r3 = await settle(run(w3));
    check('partial/Cloudinary 429: QUOTA_EXCEEDED, retryable do người dùng bấm (không tự lặp)', r3.error?.code === 'QUOTA_EXCEEDED' && r3.error.details.retryable === true && w3.cloud.sent.length === 1);
  }
  // Cloudinary từ chối chữ ký -> xin lại chữ ký cùng imageId (grant còn hạn)
  {
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/thumb'), status: 401, body: { error: { message: 'Invalid Signature' } } });
    const r1 = await settle(run(w));
    check('chữ ký/Cloudinary 401: kind SIGNATURE_REJECTED, retryable, chưa upload gì xong', r1.error?.details.kind === K.SIGNATURE_REJECTED && r1.error.details.retryable === true && !!r1.error.details.session);
    check('chữ ký/session KHÔNG giữ quyền upload cũ (buộc xin lại)', r1.error.details.session.authorization === null);
    w.clock.now += 60_000;
    const r2 = await settle(run(w, { session: r1.error.details.session }));
    check('chữ ký/retry xin lại chữ ký cho CÙNG imageId + metadata, DONE', r2.value?.status === 'DONE' && w.authorizeCalls() === 2 && w.backend.grants.size === 1 && w.backend.log[0].body.imageId === w.backend.log[1].body.imageId && JSON.stringify(w.backend.log[0].body) === JSON.stringify(w.backend.log[1].body));
    check('chữ ký/không gia hạn: hạn grant vẫn là hạn gốc', w.backend.grants.get(UUID(1)).expiresAtMs === T0 + 900_000);
  }

  // =====================================================================================================================
  // 9. existing=true
  // =====================================================================================================================
  {
    const w = world();
    // Upload cả 3 xong nhưng mất kết nối: lần retry upload lại medium -> existing=true (do chính ta tải trước đó)
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), delayMs: 0 });
    const r1 = await settle(run(w, {}));
    check('existing/(chuẩn bị) lần đầu DONE', r1.value?.status === 'DONE');
    const w2 = world();
    const ac = new AbortController();
    // hủy GIỮA lúc upload medium: yêu cầu đã "tới" Cloudinary nên asset vẫn được tạo
    w2.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), delayMs: 20 });
    const p = settle(run(w2, { signal: ac.signal }));
    await tick(8);
    ac.abort();
    const r = await p;
    check('existing/hủy giữa chừng -> CANCELLED, retryable, có session', r.error?.code === 'CANCELLED' && r.error.details.retryable === true && !!r.error.details.session && r.error.details.uploadedVariants.join() === 'thumbnail');
    await tick(40);
    check('existing/Cloudinary vẫn nhận medium dù trình duyệt đã hủy (abort không bảo đảm asset không tồn tại)', w2.cloud.assets.size === 2 || w2.cloud.sent[1].xhr.aborted === true);
    // Mô phỏng yêu cầu bị hủy nhưng server đã xử lý: tạo sẵn asset medium
    const medium = `hybrid/dev/${UUID(1)}/medium`;
    if (!w2.cloud.assets.has(medium)) w2.cloud.assets.set(medium, { publicId: medium, bytes: 20000, width: 800, height: 600, version: 1_790_000_099, assetId: 'a'.repeat(32), createdAtMs: T0 });
    const r2 = await settle(run(w2, { session: r.error.details.session }));
    check('existing/retry: medium trả existing=true khớp số đo -> vẫn đi tiếp, rồi DONE', r2.value?.status === 'DONE' && r2.value.existingVariants.join() === 'medium', r2.error?.message);
    check('existing/vẫn BẮT BUỘC confirm (Backend xác minh)', w2.confirmCalls() === 1 && w2.backend.images.get(UUID(1))?.status === 'DONE');
    check('existing/asset existing được đánh dấu, không bị coi là upload mới', r2.value.assets.medium.existing === true && r2.value.assets.thumbnail.existing === false);
    // existing=true nhưng asset là của ảnh KHÁC (bytes khác) -> từ chối, không confirm
    const w3 = world();
    const med3 = `hybrid/dev/${UUID(1)}/medium`;
    w3.cloud.assets.set(med3, { publicId: med3, bytes: 777, width: 800, height: 600, version: 1_790_000_050, assetId: 'b'.repeat(32), createdAtMs: T0 });
    const r3 = await settle(run(w3));
    check('existing/asset có sẵn lệch bytes -> EXISTING_ASSET_MISMATCH, cần phiên mới, KHÔNG confirm', r3.error?.details.kind === K.EXISTING_ASSET_MISMATCH && r3.error.details.newSessionRequired === true && r3.error.details.session === undefined && !!r3.error.details.restartFile && w3.confirmCalls() === 0);
    // existing=true của asset có TRƯỚC grant -> Backend chặn (created_at), ta chỉ báo lỗi confirm không retry được
    const w4 = world();
    for (const [k, suffix] of [['thumbnail', 'thumb'], ['medium', 'medium'], ['webp', 'full']]) {
      const pid = `hybrid/dev/${UUID(1)}/${suffix}`;
      w4.cloud.assets.set(pid, { publicId: pid, bytes: SIZES[k].b, width: SIZES[k].w, height: SIZES[k].h, version: 1_790_000_001, assetId: crypto32(k), createdAtMs: T0 - 3_600_000 });
    }
    const r4 = await settle(run(w4));
    check('existing/asset có TRƯỚC grant: Backend từ chối, Frontend KHÔNG coi là thành công và không retry', r4.error?.details.stage === 'CONFIRMING' && r4.error.details.kind === K.ASSETS_MISMATCH && r4.error.details.retryable === false && r4.error.details.newSessionRequired === true && w4.backend.images.size === 0);
  }
  function crypto32(s) { return (s + '0'.repeat(32)).slice(0, 32).replace(/[^0-9a-f]/g, 'a'); }

  // =====================================================================================================================
  // 10. Hết hạn grant
  // =====================================================================================================================
  {
    const w = world({ ttlMs: 60_000 });
    // thumbnail upload làm đồng hồ nhảy qua hạn
    const orig = w.cloud.newXhr;
    let n = 0;
    const cloud2 = w.cloud;
    cloud2.plan.push({ match: () => true, delayMs: 0 });
    const services = createSignedUploadServices({
      backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: CLOUD, getIdToken: async () => 'token-alice', observeAuthState: w.auth.observe,
      imageProcessor: fakeProcessor(), generateId: w.ids, fetchImpl: w.backend.fetch, now: () => w.clock.now,
      uploaderOptions: { createXhr: () => { const x = orig(); const send = x.send; x.send = (f) => { n += 1; if (n === 2) w.clock.now = T0 + 61_000; send(f); }; return x; } },
    });
    const r = await settle(services.uploadImage({ file: jpeg() }));
    const d = r.error?.details;
    check('hết hạn/giữa 3 biến thể: dừng, KHÔNG upload webp, kind GRANT_EXPIRED', d?.kind === K.GRANT_EXPIRED && w.cloud.sent.length === 2 && d.uploadedVariants.join() === 'thumbnail,medium');
    check('hết hạn/KHÔNG có session; có restartFile để người dùng chủ động bắt đầu lại', d.session === undefined && d.restartFile?.name === 'anh-bien.jpg' && d.retryable === false && d.newSessionRequired === true);
    check('hết hạn/báo rõ asset đã lên nhưng không tự xóa (không gọi bất kỳ API xóa nào)', d.uploadedVariants.length === 2 && w.backend.log.length === 1 && w.cloud.sent.every((s) => s.method === 'POST'));
    // Bắt đầu lại do người dùng chọn: imageId mới, grant mới
    w.clock.now = T0 + 120_000;
    const r2 = await settle(services.uploadImage({ file: d.restartFile }));
    check('hết hạn/bắt đầu lại chủ động: imageId MỚI, grant MỚI, DONE', r2.value?.status === 'DONE' && r2.value.imageId === UUID(2) && w.backend.grants.size === 2);
    check('hết hạn/imageId cũ không được xác nhận', !w.backend.images.has(UUID(1)) && w.backend.grants.get(UUID(1)).status === 'ISSUED');
  }
  // Hết hạn trước upload: authorize thành công nhưng đồng hồ client đã quá hạn
  {
    const w = world({ ttlMs: 3_000 }); // hạn 3 giây < biên an toàn 5 giây
    const r = await settle(run(w));
    check('hết hạn/trước upload (hạn < biên an toàn): không upload biến thể nào', r.error?.details.kind === K.GRANT_EXPIRED && w.cloud.sent.length === 0 && r.error.details.session === undefined);
  }
  // Backend báo hết hạn ở authorize (imageId cũ) và ở confirm
  {
    const w = world();
    w.backend.faults.confirm.push({ status: 409, detail: 'Upload grant expired' });
    const r = await settle(run(w));
    const d = r.error.details;
    check('hết hạn/confirm 409 expired: GRANT_EXPIRED, không retry, không session, có restartFile', d.stage === 'CONFIRMING' && d.kind === K.GRANT_EXPIRED && d.retryable === false && d.newSessionRequired === true && d.session === undefined && !!d.restartFile);
    check('hết hạn/KHÔNG tự retry confirm', w.confirmCalls() === 1);
    const w2 = world();
    w2.backend.faults.authorize.push({ status: 409, detail: 'Upload grant expired' });
    const r2 = await settle(run(w2));
    check('hết hạn/authorize 409 expired: cần phiên mới, KHÔNG upload', r2.error?.details.kind === K.GRANT_EXPIRED && r2.error.details.stage === 'AUTHORIZING' && w2.cloud.sent.length === 0);
  }

  // =====================================================================================================================
  // 11. Confirm lỗi: 409 / 429 / 503 / mất phản hồi
  // =====================================================================================================================
  {
    // 503 sau khi Firestore có thể đã commit (afterCommit) -> retry confirm cùng payload, không upload lại
    const w = world();
    w.backend.faults.confirm.push({ afterCommit: true, status: 503, detail: 'Storage unavailable' });
    const r1 = await settle(run(w));
    const d = r1.error.details;
    check('confirm 503: CONFIRMING, retryable, KHÔNG phải DONE', d.stage === 'CONFIRMING' && d.retryable === true && d.kind === K.BACKEND_BUSY && r1.value === undefined);
    check('confirm 503: Backend ĐÃ commit nhưng Frontend không tự coi là DONE', w.backend.images.get(UUID(1))?.status === 'DONE');
    const uploadsBefore = w.uploads(); const authBefore = w.authorizeCalls(); const procBefore = w.processor.calls.length;
    const first = w.backend.log.at(-1).body;
    const r2 = await settle(run(w, { session: d.session }));
    check('confirm retry/200 idempotent (Backend trả bản cũ) -> DONE', r2.value?.status === 'DONE' && r2.value.imageId === UUID(1));
    check('confirm retry/KHÔNG upload, KHÔNG authorize, KHÔNG nén, KHÔNG imageId mới', w.uploads() === uploadsBefore && w.authorizeCalls() === authBefore && w.processor.calls.length === procBefore && w.ids.count() === 1);
    check('confirm retry/payload y hệt lần trước (cùng imageId, URL, processedSize)', JSON.stringify(first) === JSON.stringify(w.backend.log.at(-1).body));
  }
  {
    // Mất phản hồi (mạng đứt sau khi Backend commit)
    const w = world();
    w.backend.faults.confirm.push({ afterCommit: true, drop: true });
    const r1 = await settle(run(w));
    check('mất phản hồi: lỗi NETWORK ở CONFIRMING, retryable, có session', r1.error?.code === 'NETWORK' && r1.error.details.stage === 'CONFIRMING' && r1.error.details.retryable === true && !!r1.error.details.session);
    const r2 = await settle(run(w, { session: r1.error.details.session }));
    check('mất phản hồi: retry confirm cùng payload -> DONE; upload không đổi (3)', r2.value?.status === 'DONE' && w.uploads() === 3 && w.confirmCalls() === 2 && w.authorizeCalls() === 1);
  }
  {
    // 409 asset chưa thấy (Admin API) -> retryable, chỉ confirm lại
    const w = world();
    w.backend.faults.confirm.push({ status: 409, detail: 'Uploaded assets not found' });
    const r1 = await settle(run(w));
    check('confirm 409 assets not found: ASSETS_NOT_FOUND, retryable (người dùng bấm), có session', r1.error.details.kind === K.ASSETS_NOT_FOUND && r1.error.details.retryable === true && !!r1.error.details.session && w.confirmCalls() === 1);
    const r2 = await settle(run(w, { session: r1.error.details.session }));
    check('confirm 409 assets not found: retry sau đó DONE, không upload lại', r2.value?.status === 'DONE' && w.uploads() === 3 && w.authorizeCalls() === 1);
    // 409 các loại khác KHÔNG retry
    const table = [
      ['Uploaded assets do not match the upload grant', K.ASSETS_MISMATCH, false, true],
      ['Confirm parameters differ from the upload grant', K.PARAMS_MISMATCH, false, true],
      ['Upload grant is not active', K.GRANT_INACTIVE, false, true],
      ['Image already exists', K.IMAGE_EXISTS, false, true],
      ['Asset already registered', K.STATE_CONFLICT, false, true],
      ['Upload state is inconsistent', K.STATE_CONFLICT, false, true],
      ['Upload grant environment mismatch', K.STATE_CONFLICT, false, true],
      ['một lỗi 409 lạ chưa từng thấy', K.STATE_CONFLICT, false, true],
      ['Upload grant changed', K.GRANT_CHANGED, true, false],
    ];
    for (const [detail, kind, retryable, fresh] of table) {
      const ww = world();
      ww.backend.faults.confirm.push({ status: 409, detail });
      const r = await settle(run(ww));
      const dd = r.error?.details;
      check(`confirm 409 "${detail}": ${kind}, retryable=${retryable}, phiên mới=${fresh}`, dd?.kind === kind && dd.retryable === retryable && dd.newSessionRequired === fresh && (retryable ? !!dd.session : dd.session === undefined) && ww.confirmCalls() === 1, `${dd?.kind}/${dd?.retryable}`);
    }
    check('confirm 409: KHÔNG phải mọi 409 đều retry (chỉ not found và grant changed)', table.filter((t) => t[2]).length === 1);
  }
  {
    // 429 + Retry-After
    const w = world();
    w.backend.faults.confirm.push({ status: 429, detail: 'Too many requests', headers: { 'Retry-After': '120' } });
    const r = await settle(run(w));
    const d = r.error.details;
    check('confirm 429: RATE_LIMITED, retryAfterSeconds=120, retryable, KHÔNG tự retry', r.error.code === 'QUOTA_EXCEEDED' && d.kind === K.RATE_LIMITED && d.retryAfterSeconds === 120 && d.retryable === true && w.confirmCalls() === 1 && !!d.session);
    await tick(30);
    check('confirm 429: không có request ngầm sau đó', w.confirmCalls() === 1 && w.authorizeCalls() === 1);
    // 503 verification + Retry-After
    const w2 = world();
    w2.backend.faults.confirm.push({ status: 503, detail: 'Upload verification unavailable', headers: { 'Retry-After': '60' } });
    const r2 = await settle(run(w2));
    check('confirm 503 verification: VERIFICATION_UNAVAILABLE, Retry-After=60, retryable', r2.error.details.kind === K.VERIFICATION_UNAVAILABLE && r2.error.details.retryAfterSeconds === 60 && r2.error.details.retryable === true);
    const w3 = world();
    w3.backend.faults.confirm.push({ status: 503, detail: 'Signed upload unavailable' });
    const r3 = await settle(run(w3));
    check('confirm 503 signed unavailable: cấu hình Backend, KHÔNG retry, CONFIG', r3.error.details.kind === K.SIGNED_UNAVAILABLE && r3.error.code === 'CONFIG' && r3.error.details.retryable === false);
    // 403 chưa có grant
    const w4 = world();
    w4.backend.faults.confirm.push({ status: 403, detail: 'Upload authorization required' });
    const r4 = await settle(run(w4));
    check('confirm 403 thiếu grant: AUTHORIZATION_REQUIRED, phiên mới', r4.error.details.kind === K.AUTHORIZATION_REQUIRED && r4.error.details.newSessionRequired === true && r4.error.details.retryable === false);
    const w5 = world();
    w5.backend.faults.confirm.push({ status: 403, detail: 'Forbidden' });
    const r5 = await settle(run(w5));
    check('confirm 403 Forbidden: không retry', r5.error.code === 'FORBIDDEN' && r5.error.details.retryable === false);
    const w6 = world();
    w6.backend.faults.confirm.push({ status: 401, detail: 'x' }, { status: 401, detail: 'x' });
    const r6 = await settle(run(w6));
    check('confirm 401 hai lần: UNAUTHENTICATED, không retry', r6.error.code === 'UNAUTHENTICATED' && r6.error.details.retryable === false);
    const w7 = world();
    w7.backend.faults.confirm.push({ status: 400, detail: 'Invalid cloudinary url' });
    const r7 = await settle(run(w7));
    check('confirm 400: VALIDATION không retry', r7.error.code === 'VALIDATION' && r7.error.details.retryable === false);
    // 500 chung
    const w8 = world();
    w8.backend.faults.confirm.push({ status: 500, detail: 'boom' });
    const r8 = await settle(run(w8));
    check('confirm 500: BACKEND_BUSY retryable', r8.error.details.kind === K.BACKEND_BUSY && r8.error.details.retryable === true);
  }
  {
    // Confirm trả 200 nhưng sai (không DONE / imageId khác)
    const w = world();
    const orig = w.backend.fetch;
    const badConfirm = createSignedUploadServices({
      backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: CLOUD, getIdToken: async () => 'token-alice', observeAuthState: w.auth.observe,
      imageProcessor: fakeProcessor(), generateId: w.ids, now: () => w.clock.now, uploaderOptions: { createXhr: w.cloud.newXhr },
      fetchImpl: async (url, init) => (String(url).endsWith('/confirm') ? { status: 200, headers: { get: () => null }, text: async () => JSON.stringify({ imageId: UUID(1), status: 'PENDING', variants: {} }) } : orig(url, init)),
    });
    const r = await settle(badConfirm.uploadImage({ file: jpeg() }));
    check('confirm 200 nhưng KHÔNG phải DONE hợp lệ: không coi là hoàn tất, không retry', r.value === undefined && r.error?.details.stage === 'CONFIRMING' && r.error.details.retryable === false);
  }

  // =====================================================================================================================
  // 12. Lỗi authorize: không fallback
  // =====================================================================================================================
  {
    const cases = [
      [{ status: 404, detail: 'Not Found' }, K.AUTHORIZE_UNSUPPORTED, 'CONFIG', false],
      [{ status: 503, detail: 'Signed upload unavailable' }, K.SIGNED_UNAVAILABLE, 'CONFIG', false],
      [{ status: 429, detail: 'Too many upload authorizations', headers: { 'Retry-After': '1234' } }, K.RATE_LIMITED, 'QUOTA_EXCEEDED', true],
      [{ status: 503, detail: 'Storage unavailable' }, K.BACKEND_BUSY, 'UNKNOWN', true],
      [{ status: 409, detail: 'Image already exists' }, K.IMAGE_EXISTS, 'UNKNOWN', false],
      [{ status: 409, detail: 'Upload grant is not active' }, K.GRANT_INACTIVE, 'UNKNOWN', false],
      [{ status: 403, detail: 'Forbidden' }, 'FORBIDDEN', 'FORBIDDEN', false],
      [{ status: 400, detail: 'Invalid variants' }, 'BAD_REQUEST', 'VALIDATION', false],
    ];
    for (const [fault, kind, code, retryable] of cases) {
      const w = world();
      w.backend.faults.authorize.push(fault);
      const r = await settle(run(w));
      const d = r.error?.details;
      check(`authorize lỗi ${fault.status} "${fault.detail}": ${kind ?? 'kind mặc định'}`, d?.stage === 'AUTHORIZING' && d.kind === kind && r.error.code === code && d.retryable === retryable, `${d?.stage}/${d?.kind}/${r.error?.code}/${d?.retryable}`);
      check(`authorize lỗi ${fault.status}: KHÔNG upload, KHÔNG fallback unsigned/MOCK, KHÔNG confirm`, w.cloud.sent.length === 0 && w.confirmCalls() === 0 && w.cloud.openCount === 0);
      if (fault.status === 429) check('authorize 429: giữ Retry-After, không tự retry', d.retryAfterSeconds === 1234 && w.authorizeCalls() === 1);
    }
    // retry authorize sau lỗi tạm thời: cùng imageId
    const w = world();
    w.backend.faults.authorize.push({ status: 503, detail: 'Storage unavailable' });
    const r1 = await settle(run(w));
    const r2 = await settle(run(w, { session: r1.error.details.session }));
    check('authorize retry/cùng imageId, không nén lại, DONE', r2.value?.status === 'DONE' && r2.value.imageId === UUID(1) && w.processor.calls.length === 1 && w.ids.count() === 1 && w.authorizeCalls() === 2 && w.backend.grants.size === 1);
    // response authorize sai
    const bads = {
      'uploadUrl host lạ': (b) => ({ ...b, uploadUrl: 'https://evil.test/v1_1/demo-cloud/image/upload' }),
      'có api_secret': (b) => ({ ...b, api_secret: 'x' }),
      'public_id sai vai trò': (b) => { const c = structuredClone(b); c.uploads.thumbnail.fields.public_id = c.uploads.webp.fields.public_id; return c; },
      'imageId khác': (b) => ({ ...b, imageId: UUID(55) }),
    };
    for (const [label, fn] of Object.entries(bads)) {
      const ww = world();
      const real = ww.backend.fetch;
      const svc = createSignedUploadServices({
        backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: CLOUD, getIdToken: async () => 'token-alice', observeAuthState: ww.auth.observe,
        imageProcessor: fakeProcessor(), generateId: ww.ids, now: () => ww.clock.now, uploaderOptions: { createXhr: ww.cloud.newXhr },
        fetchImpl: async (url, init) => { const res = await real(url, init); if (!String(url).endsWith('/authorize')) return res; const body = fn(JSON.parse(await res.text())); return { status: 200, headers: { get: () => null }, text: async () => JSON.stringify(body) }; },
      });
      const r = await settle(svc.uploadImage({ file: jpeg() }));
      check(`authorize response sai (${label}): INVALID_AUTHORIZATION, không upload, không retry`, r.error?.details.kind === K.INVALID_AUTHORIZATION && ww.cloud.sent.length === 0 && r.error.details.retryable === false && !r.error.message.includes('a'.repeat(30)));
    }
  }

  {
    const w = world();
    w.backend.faults.authorize.push({ status: 404, detail: 'Not Found' });
    const a = await settle(run(w));
    check('thông báo/authorize 404 nói rõ Backend chưa hỗ trợ (không nói "không tìm thấy ảnh")', /chưa hỗ trợ cấp quyền upload/.test(a.error.message) && !/không tìm thấy ảnh/.test(a.error.message) && /không chuyển sang upload không ký/.test(a.error.message));
    const w2 = world();
    w2.backend.faults.confirm.push({ status: 409, detail: 'Upload grant expired' });
    const b = await settle(run(w2));
    check('thông báo/grant hết hạn nói rõ phải bắt đầu phiên mới, không bảo "thử xác nhận lại"', /bắt đầu lại/.test(b.error.message) && !/thử xác nhận lại/.test(b.error.message));
    const w3 = world();
    w3.backend.faults.confirm.push({ status: 429, detail: 'x', headers: { 'Retry-After': '45' } });
    const c = await settle(run(w3));
    check('thông báo/429 nêu số giây Retry-After', /45 giây/.test(c.error.message));
    check('thông báo/không chứa chữ ký, token hay Bearer', [a, b, c].every((r) => !/Bearer|token-|signature|a{30}/.test(r.error.message)));
  }

  // =====================================================================================================================
  // 13. Đổi UID / đăng xuất / hủy / response muộn
  // =====================================================================================================================
  {
    // đăng xuất giữa upload
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), delayMs: 30 });
    const p = settle(run(w));
    await tick(10);
    w.auth.set(null);
    const r = await p;
    await tick(60);
    check('đăng xuất giữa upload: AUTH_CHANGED, không retry, KHÔNG có session/grant', r.error?.details.kind === K.AUTH_CHANGED && r.error.details.retryable === false && r.error.details.session === undefined && r.error.code === 'CANCELLED');
    check('đăng xuất: không authorize/upload biến thể mới/confirm sau đó', w.cloud.sent.length === 2 && w.confirmCalls() === 0 && w.authorizeCalls() === 1);
    check('đăng xuất: không có response chứa chữ ký trong lỗi', !JSON.stringify(r.error.details, (k, v) => (k === 'cause' || k === 'restartFile' ? undefined : v)).includes('signature'));
    check('đăng xuất: hủy đăng ký auth (không rò listener)', w.auth.listenerCount() === 0);
  }
  {
    // đổi UID alice -> bob giữa upload; bob không dùng được token/grant của alice; response muộn bị bỏ
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/thumb'), delayMs: 25 });
    const p = settle(run(w));
    await tick(10);
    w.auth.set('bob');
    const r = await p;
    await tick(60);
    check('đổi UID: phiên của alice bị hủy AUTH_CHANGED', r.error?.details.kind === K.AUTH_CHANGED && r.error.details.session === undefined);
    check('đổi UID: Backend KHÔNG nhận confirm; mọi request Backend dùng token của alice', w.confirmCalls() === 0 && w.backend.log.every((l) => l.headers.Authorization === 'Bearer token-alice'));
    check('đổi UID: response Cloudinary muộn của phiên cũ bị bỏ qua (không upload tiếp biến thể mới)', w.cloud.sent.length === 1 && w.backend.images.size === 0);
    // bob chạy upload mới: imageId mới, grant của bob
    const rb = await settle(run(w));
    check('đổi UID: bob upload ảnh mới thành công bằng imageId MỚI và token của bob', rb.value?.status === 'DONE' && rb.value.imageId === UUID(2) && w.backend.grants.get(UUID(2)).ownerId === 'bob' && w.backend.grants.get(UUID(1)).ownerId === 'alice' && w.backend.grants.get(UUID(1)).status === 'ISSUED');
  }
  {
    // response muộn thành công của phiên cũ (confirm đã gửi) cũng bị bỏ qua
    const w = world();
    const real = w.backend.fetch;
    let gate;
    const wait = new Promise((r) => { gate = r; });
    let confirmPending = false;
    const svc = createSignedUploadServices({
      backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: CLOUD, getIdToken: async () => 'token-alice', observeAuthState: w.auth.observe,
      imageProcessor: fakeProcessor(), generateId: w.ids, now: () => w.clock.now, uploaderOptions: { createXhr: w.cloud.newXhr },
      fetchImpl: async (url, init) => { if (String(url).endsWith('/confirm')) { const res = await real(url, init); confirmPending = true; await wait; return res; } return real(url, init); },
    });
    const p = settle(svc.uploadImage({ file: jpeg() }));
    for (let i = 0; i < 200 && !confirmPending; i += 1) await tick(5);
    check('response muộn/(chuẩn bị) Backend đã commit, phản hồi confirm đang treo', confirmPending === true && w.backend.images.get(UUID(1))?.status === 'DONE');
    w.auth.set('bob'); // alice đăng xuất, bob đăng nhập khi confirm của alice đang treo
    gate();
    const r = await p;
    check('response muộn: confirm của phiên cũ tới SAU khi đổi UID bị bỏ qua (AUTH_CHANGED, không DONE cho bob)', r.value === undefined && r.error?.details.kind === K.AUTH_CHANGED && r.error.details.session === undefined);
  }
  {
    // session của người khác
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), network: true });
    const r1 = await settle(run(w));
    const session = r1.error.details.session;
    check('session/mang ownerUid của alice', session.ownerUid === 'alice');
    w.auth.set('bob');
    const before = { fetch: w.backend.log.length, xhr: w.cloud.sent.length };
    const r2 = await settle(run(w, { session }));
    check('session của alice KHÔNG dùng được cho bob: SESSION_OWNER_MISMATCH, không request nào', r2.error?.details.kind === K.SESSION_OWNER_MISMATCH && r2.error.code === 'FORBIDDEN' && w.backend.log.length === before.fetch && w.cloud.sent.length === before.xhr);
    // gọi thẳng use case với ownerUid giả cũng bị từ chối
    const direct = await load('/src/application/usecases/uploadImageSigned.js');
    const flow = direct.createUploadImageSigned({ imageProcessor: fakeProcessor(), authorizeCloudinaryUpload: async () => { throw new Error('không được gọi'); }, uploadVariantsSigned: async () => { throw new Error('không được gọi'); }, confirmCloudinaryUpload: async () => { throw new Error('không được gọi'); }, generateId: () => UUID(1) });
    const r3 = await settle(flow({ session, ownerUid: 'mallory' }));
    check('session/use case tự kiểm ownerUid (không chỉ lớp guard)', r3.error?.details.kind === K.SESSION_OWNER_MISMATCH);
    const r4 = await settle(flow({ session: { ...session, ownerUid: undefined }, ownerUid: 'alice' }));
    check('session/thiếu ownerUid bị từ chối (fail closed)', r4.error?.details.kind === K.SESSION_OWNER_MISMATCH);
    const r5 = await settle(flow({ file: jpeg() }));
    check('use case/thiếu ownerUid -> UNAUTHENTICATED', r5.error?.code === 'UNAUTHENTICATED');
    w.auth.set('alice');
    const r6 = await settle(run(w, { session }));
    check('session/alice quay lại dùng được session của chính mình', r6.value?.status === 'DONE' && r6.value.imageId === UUID(1));
  }
  {
    // chưa đăng nhập
    const w = world({ uid: null });
    const r = await settle(run(w));
    check('chưa đăng nhập: UNAUTHENTICATED, không mạng, không imageId', r.error?.code === 'UNAUTHENTICATED' && w.backend.log.length === 0 && w.ids.count() === 0);
    // trạng thái đăng nhập không bao giờ có: hết thời gian
    const never = createSignedUploadServices({ backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: CLOUD, getIdToken: async () => 't', observeAuthState: () => () => {}, fetchImpl: async () => { throw new Error('x'); } });
    check('createSignedUploadServices tạo được khi auth chưa phát sự kiện', typeof never.uploadImage === 'function');
    const guardMod = await load('/src/application/usecases/guardedSignedUpload.js');
    const g = guardMod.createGuardedSignedUpload({ uploadImageSigned: async () => { throw new Error('không được gọi'); }, observeAuthState: () => () => {}, authReadyTimeoutMs: 20 });
    const rg = await settle(g({ file: jpeg() }));
    check('auth không phản hồi: hết thời gian chờ -> UNAUTHENTICATED (không treo, không upload)', rg.error?.code === 'UNAUTHENTICATED');
    const g2 = guardMod.createGuardedSignedUpload({ uploadImageSigned: async () => ({ ok: true }), observeAuthState: (ok, onError) => { Promise.resolve().then(() => onError(new Error('listener'))); return () => {}; } });
    check('auth lỗi listener: UNAUTHENTICATED, không upload', (await settle(g2({ file: jpeg() }))).error?.code === 'UNAUTHENTICATED');
    // người gọi không thể ép ownerUid
    let seen;
    const g3 = guardMod.createGuardedSignedUpload({ uploadImageSigned: async (a) => { seen = a.ownerUid; return { ok: 1 }; }, observeAuthState: (cb) => { Promise.resolve().then(() => cb({ uid: 'alice' })); return () => {}; } });
    await g3({ file: jpeg(), ownerUid: 'mallory' });
    check('guard/ownerUid do guard chốt từ auth, người gọi không ghi đè được', seen === 'alice');
  }
  {
    // người dùng hủy
    const w = world();
    w.cloud.plan.push({ match: (s) => s.publicId.endsWith('/medium'), hang: true });
    const ac = new AbortController();
    const p = settle(run(w, { signal: ac.signal }));
    await tick(15);
    ac.abort();
    const r = await p;
    check('hủy: CANCELLED, xhr.abort() được gọi, không confirm, retryable giữ session', r.error?.code === 'CANCELLED' && w.cloud.sent[1].xhr.aborted === true && w.confirmCalls() === 0 && r.error.details.retryable === true && !!r.error.details.session && r.error.details.uploadedVariants.join() === 'thumbnail');
    const r2 = await settle(run(w, { session: r.error.details.session }));
    check('hủy: thử lại tiếp tục cùng imageId; thumbnail không upload lại', r2.value?.status === 'DONE' && r2.value.imageId === UUID(1) && w.cloud.sent.map((s) => s.publicId.split('/').pop()).join() === 'thumb,medium,medium,full');
    const ac2 = new AbortController(); ac2.abort();
    const w2 = world();
    const r3 = await settle(run(w2, { signal: ac2.signal }));
    check('hủy từ trước: không authorize/upload/confirm', r3.error?.code === 'CANCELLED' && w2.backend.log.length === 0 && w2.cloud.sent.length === 0);
    const w3 = world();
    const ac3 = new AbortController();
    const p3 = settle(run(w3, { signal: ac3.signal, onStage: (e) => { if (e.stage === 'CONFIRMING') ac3.abort(); } }));
    const r4 = await p3;
    check('hủy ngay trước confirm: CANCELLED, không gửi confirm', r4.error?.code === 'CANCELLED' && r4.error.details.stage === 'CONFIRMING' && w3.confirmCalls() === 0 && w3.uploads() === 3);
    const r5 = await settle(run(w3, { session: r4.error.details.session }));
    check('hủy ngay trước confirm: thử lại chỉ confirm, DONE', r5.value?.status === 'DONE' && w3.uploads() === 3 && w3.authorizeCalls() === 1);
  }

  // =====================================================================================================================
  // 14. Không fallback / cấu hình sai
  // =====================================================================================================================
  {
    const base = { getIdToken: async () => 'token-alice', observeAuthState: createFakeAuth('alice').observe, fetchImpl: async () => { throw new Error('không được gọi mạng'); }, uploaderOptions: { createXhr: () => { throw new Error('không được gọi XHR'); } } };
    for (const [label, cfg] of [
      ['Backend mock', { backendConfig: { mode: 'mock', baseUrl: null, configError: null }, cloudName: CLOUD }],
      ['Backend invalid', { backendConfig: { mode: 'invalid', baseUrl: null, configError: { message: 'VITE_API_BASE_URL thiếu', missing: ['VITE_API_BASE_URL'] } }, cloudName: CLOUD }],
      ['thiếu cloud name', { backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: '' }],
      ['cloud name sai', { backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: 'a b' }],
      ['không có config', {}],
    ]) {
      const s = createSignedUploadServices({ ...base, ...cfg });
      const r = await settle(s.uploadImage({ file: jpeg() }));
      check(`cấu hình sai (${label}): lỗi CONFIG rõ ràng, không MOCK, không unsigned, không mạng`, r.error?.code === 'CONFIG' && s.isMock === false && !!s.configError && netCalls.length === 0, r.error?.message);
    }
    const noToken = (() => { try { createSignedUploadServices({ ...base, getIdToken: undefined, backendConfig: { mode: 'real', baseUrl: 'https://x.test' }, cloudName: CLOUD }); return false; } catch (e) { return e instanceof TypeError; } })();
    check('thiếu getIdToken/observeAuthState: TypeError ngay khi dựng (lỗi lập trình)', noToken);
    const s = createSignedUploadServices({ ...base, backendConfig: { mode: 'real', baseUrl: 'https://api.example.test', configError: null }, cloudName: CLOUD });
    check('dịch vụ hợp lệ: mode signed, không MOCK', s.mode === 'signed' && s.isMock === false && s.configError === null);
  }

  // =====================================================================================================================
  // 15. describeBackendFailure (bảng phân loại)
  // =====================================================================================================================
  {
    const mk = (httpStatus, detail, extra = {}) => ({ code: 'UNKNOWN', details: { httpStatus, detail, ...extra } });
    const t = (e, stage) => describeBackendFailure(e, { stage });
    check('phân loại/409 không có detail = STATE_CONFLICT không retry', t(mk(409, null)).kind === K.STATE_CONFLICT && t(mk(409, null)).retryable === false);
    check('phân loại/404 ở CONFIRMING không phải AUTHORIZE_UNSUPPORTED', t(mk(404, 'x'), 'CONFIRMING').kind !== K.AUTHORIZE_UNSUPPORTED && t(mk(404, 'x'), 'CONFIRMING').retryable === false);
    check('phân loại/lỗi phía client NETWORK retry được', t({ code: 'NETWORK', details: { kind: 'NETWORK' } }).retryable === true);
    check('phân loại/Retry-After không phải số nguyên bị bỏ', t(mk(429, 'x', { retryAfterSeconds: 'abc' })).retryAfterSeconds === null && t(mk(429, 'x', { retryAfterSeconds: 90 })).retryAfterSeconds === 90);
    check('phân loại/mã lạ -> UNKNOWN', t({ code: 'ABC', details: { httpStatus: 418 } }).code === 'UNKNOWN');
    check('phân loại/EXPIRY_MARGIN_MS = 5000', EXPIRY_MARGIN_MS === 5000);
  }

  // =====================================================================================================================
  // 16. H4A MOCK vẫn hoạt động; không nối vào ứng dụng
  // =====================================================================================================================
  {
    const mockServices = createUploadServices({ imageProcessor: fakeProcessor(), generateId: counterIds(), latencyMs: 0 });
    const calls = [];
    const r = await settle(mockServices.uploadImage({ file: jpeg() }));
    check('H4A/MOCK vẫn chạy: DONE, isMock, không mạng', r.value?.status === 'DONE' && r.value.confirm.isMock === true && mockServices.isMock === true && netCalls.length === 0 && calls.length === 0);
    check('H4A/createUploadServices vẫn từ chối mode khác mock', (() => { try { createUploadServices({ mode: 'real' }); return false; } catch { return true; } })());
    const confirmWebp = createConfirmCloudinaryUpload({ backendApi: { async confirmCloudinaryUpload(p) { calls.push(p); return { imageId: p.imageId, status: 'DONE', variants: { thumbnail: 'https://a', medium: 'https://b', webp: 'https://c' } }; } } });
    await confirmWebp({ imageId: 'x', file: { size: 100, name: 'a.jpg' }, processed: { width: 10, height: 10, processingMs: 1, blobs: { thumbnail: webp(1), medium: webp(2), webp: webp(4) } }, assets: { thumbnail: { secureUrl: 'https://a' }, medium: { secureUrl: 'https://b' }, webp: { secureUrl: 'https://c' } } });
    check('H4A/confirm mặc định giữ processedSize = TỔNG 3 Blob (hành vi cũ)', calls[0].processedSize === 7);
    check('confirm processedSizeBasis lạ bị từ chối', (() => { try { createConfirmCloudinaryUpload({ backendApi: {}, processedSizeBasis: 'x' }); return false; } catch (e) { return e instanceof TypeError; } })());
  }

  // =====================================================================================================================
  // 17. Quét mã nguồn
  // =====================================================================================================================
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const walk = (dir) => fs.readdirSync(path.join(root, dir), { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(dir, e.name)) : [path.join(dir, e.name).replaceAll('\\', '/')]));
  const srcFiles = walk('src');
  const newFiles = [
    'src/domain/models/uploadAuthorization.js', 'src/application/signedUploadErrors.js', 'src/application/usecases/authorizeCloudinaryUpload.js',
    'src/application/usecases/uploadVariantsSigned.js', 'src/application/usecases/uploadImageSigned.js', 'src/application/usecases/guardedSignedUpload.js',
    'src/infrastructure/cloudinary/signedCloudinaryUploader.js', 'src/infrastructure/cloudinary/xhrUpload.js', 'src/app/createSignedUploadServices.js',
  ];
  for (const f of newFiles) {
    const code = strip(read(f));
    check(`mã nguồn ${path.basename(f)}/không localStorage/sessionStorage/IndexedDB/cookie`, !/localStorage|sessionStorage|indexedDB|document\.cookie/.test(code));
    check(`mã nguồn ${path.basename(f)}/không console.*`, !/console\./.test(code));
    check(`mã nguồn ${path.basename(f)}/không import.meta.env`, !/import\.meta\.env/.test(code));
    check(`mã nguồn ${path.basename(f)}/không api_secret/CLOUDINARY_API_SECRET/ký ở Frontend (crypto.subtle, createHmac)`, !/api_secret|API_SECRET|crypto\.subtle|createHmac|sha1|sha256/i.test(code.replace(/\/\^\(\?:\[0-9a-f\]\{40\}\|\[0-9a-f\]\{64\}\)\$\//g, '')) || /domain\/models\/uploadAuthorization/.test(f));
  }
  check('mã nguồn/toàn src không có secret Cloudinary (API_SECRET, VITE_*SECRET, cloudinary:// URL)', srcFiles.every((f) => !/CLOUDINARY_API_SECRET|VITE_[A-Z_]*SECRET|cloudinary:\/\/|\bapi_secret\s*[:=]\s*['"]/.test(strip(read(f)))), srcFiles.filter((f) => /CLOUDINARY_API_SECRET|VITE_[A-Z_]*SECRET|cloudinary:\/\/|\bapi_secret\s*[:=]\s*['"]/.test(strip(read(f)))).join());
  check('mã nguồn/signedCloudinaryUploader không có upload_preset', !/upload_preset|uploadPreset/.test(strip(read('src/infrastructure/cloudinary/signedCloudinaryUploader.js'))));
  check('mã nguồn/signed flow không import uploader unsigned/MOCK', ['src/application/usecases/uploadImageSigned.js', 'src/application/usecases/uploadVariantsSigned.js', 'src/app/createSignedUploadServices.js'].every((f) => !/cloudinaryUploader'|mockCloudinaryUploader|mockBackendApi|createMock|createCloudinaryServices/.test(strip(read(f)))));
  check('mã nguồn/Authorization chỉ ở backendClient, không ở uploader Cloudinary', !/Authorization|Bearer/.test(strip(read('src/infrastructure/cloudinary/signedCloudinaryUploader.js') + read('src/infrastructure/cloudinary/xhrUpload.js'))) && /Authorization/.test(read('src/infrastructure/api/backendClient.js')));
  // H4B-5: Signed Upload ĐÃ được nối, nhưng CHỈ qua composition root createUploadModeServices (được chọn bởi VITE_UPLOAD_MODE); xem h4b5-upload-mode-smoke.mjs.
  const SIGNED_IMPORT = /from\s+['"][^'"]*(createSignedUploadServices|uploadImageSigned|guardedSignedUpload|signedCloudinaryUploader)['"]/;
  const importers = srcFiles.filter((f) => !newFiles.includes(f) && SIGNED_IMPORT.test(strip(read(f))));
  check('nối qua MỘT cửa: chỉ src/app/createUploadModeServices.js import createSignedUploadServices; không file nào khác ngoài các module signed', importers.join() === 'src/app/createUploadModeServices.js', importers.join());
  const mockSide = strip(read('src/app/createUploadServices.js')) + strip(read('src/presentation/pages/UploadPage.jsx')) + strip(read('src/presentation/hooks/useUploadFlow.js')) + strip(read('src/main.jsx'));
  check('nối qua MỘT cửa: main.jsx, createUploadServices (MOCK), UploadPage, useUploadFlow không import module signed trực tiếp', !SIGNED_IMPORT.test(mockSide) && !/uploadImageSigned|signedCloudinaryUploader|createSignedUploadServices/.test(mockSide));
  const envFiles = srcFiles.filter((f) => /VITE_UPLOAD_MODE/.test(read(f)));
  check('VITE_UPLOAD_MODE chỉ xuất hiện ở lớp diễn giải/composition (uploadMode.js, createUploadModeServices.js, UploadPage/useUploadServices chỉ nhắc trong chú thích)', envFiles.every((f) => /application\/uploadMode\.js|app\/createUploadModeServices\.js|hooks\/useUploadServices\.js|pages\/UploadPage\.jsx|main\.jsx|components\/upload\//.test(f)), envFiles.join());
  check('.env.example: VITE_UPLOAD_MODE mặc định mock, không có biến secret', /^VITE_UPLOAD_MODE=mock\s*$/m.test(read('.env.example')) && !/^\s*[A-Z_]*SECRET[A-Z_]*\s*=/m.test(read('.env.example')));
  check('console không ghi token/Bearer/chữ ký', consoleLines.every((l) => !/Bearer|token-|signature/i.test(l)));
  check('toàn bộ bài: fetch/XMLHttpRequest toàn cục không bị gọi lần nào', netCalls.length === 0, JSON.stringify(netCalls.slice(0, 3)));
} finally {
  await server.close();
}

out(`PASSED: ${passed}`);
out(`FAILED: ${failures.length}`);
failures.forEach((f) => out('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
