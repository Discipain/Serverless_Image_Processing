// Smoke test H3A — Backend API client + MOCK + confirm use case. fetch GIẢ: KHÔNG gọi mạng, KHÔNG gọi Backend/Cloudinary/Firestore thật.
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/h3a-smoke.mjs .  (xem tests/README.md)
// Tùy chọn: SMOKE_REAL_CLOUD_NAME / SMOKE_REAL_UPLOAD_PRESET = giá trị Cloudinary thật của nhóm, chỉ để kiểm tra chúng KHÔNG nằm trong src.
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

// ---------- ghi lại console để kiểm tra không rò rỉ token ----------
const logged = [];
for (const m of ['log', 'info', 'warn', 'error', 'debug']) { console[m === 'log' ? 'log' : m] = ((orig) => (...a) => { if (!String(a[0]).startsWith('@@')) logged.push(a.map(String).join(' ')); void orig; })(console[m]); }
const out = (s) => process.stdout.write(s + '\n');

// ---------- fetch giả ----------
const TOKEN = 'FAKE-TOKEN-abc123';
function makeFetch(steps) {
  const calls = [];
  const f = async (url, init) => {
    const step = steps[calls.length] ?? steps.at(-1);
    calls.push({ url, init });
    return step(init);
  };
  f.calls = calls;
  return f;
}
const reply = (status, body) => async () => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const rejectNet = () => async () => { throw new TypeError('Failed to fetch'); };
const hang = () => (init) => new Promise((_, reject) => { init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))); });
const doneBody = (id) => ({
  imageId: id, status: 'DONE', ownerId: 'uid-1',
  variants: { thumbnail: 'https://res.cloudinary.com/c/a/thumb.webp', medium: 'https://res.cloudinary.com/c/a/medium.webp', webp: 'https://res.cloudinary.com/c/a/full.webp' },
  processingMs: 1840, savedPercent: 83.2,
});
const doneBodyWithIds = (id) => { const b = doneBody(id); b.variants = { ...b.variants, thumbnailId: 'abc/thumb', mediumId: 'abc/medium', webpId: 'abc/full' }; return b; };

const FIXTURE_ID = 'fixture-image-id-0001'; // DỮ LIỆU GIẢ cho kiểm thử, không phải chính sách cấp imageId
const url = (n) => `https://res.cloudinary.com/test-cloud/image/upload/v1/${n}.webp`;
const assets = { thumbnail: { secureUrl: url('t'), publicId: 'pt' }, medium: { secureUrl: url('m'), publicId: 'pm' }, webp: { secureUrl: url('w'), publicId: 'pw' } };
const file = { name: 'anh-bien.jpg', type: 'image/jpeg', size: 2457600 };
const processed = { width: 4000, height: 3000, processingMs: 1840, blobs: { thumbnail: { size: 10000 }, medium: { size: 100000 }, webp: { size: 302000 } } };
const args = (over = {}) => ({ imageId: FIXTURE_ID, file, processed, assets, ...over });

const server = await createServer({
  root, envDir: process.env.EMPTY_ENV_DIR, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const load = (p) => server.ssrLoadModule(p);
  const { buildConfirmPayload, CONFIRM_PAYLOAD_FIELDS, CONFIRM_REQUIRED_FIELDS, CONFIRM_OPTIONAL_FIELDS, ConfirmPayloadError } = await load('/src/domain/models/confirmPayload.js');
  const { readBackendConfig } = await load('/src/infrastructure/api/backendConfig.js');
  const { createBackendClient, createUnavailableBackendApi } = await load('/src/infrastructure/api/backendClient.js');
  const { createMockBackendApi, MOCK_BACKEND_SCENARIOS: SC } = await load('/src/infrastructure/mock/mockBackendApi.js');
  const { createConfirmCloudinaryUpload } = await load('/src/application/usecases/confirmCloudinaryUpload.js');
  const { createBackendServices } = await load('/src/app/createBackendServices.js');

  // ===== Hàm thuần dựng payload (CONTRACT 72ee441: 6 bắt buộc + 6 tùy chọn) =====
  const SIZES = { thumbnail: 10000, medium: 100000, webp: 302000 }; // kích thước 3 Blob giả lập; tổng 412000 (khớp ví dụ CONTRACT)
  const full = { imageId: FIXTURE_ID, originalSize: file.size, processingMs: 1840, assets, fileName: file.name, width: 4000, height: 3000, variantSizes: SIZES };
  const payload = buildConfirmPayload(full); // dùng cho các phần sau: đủ 12 field
  const minimal = buildConfirmPayload({ imageId: FIXTURE_ID, originalSize: file.size, processingMs: 1840, assets: { thumbnail: { secureUrl: url('t') }, medium: { secureUrl: url('m') }, webp: { secureUrl: url('w') } } });
  check('hằng số/6 bắt buộc đúng danh sách CONTRACT', CONFIRM_REQUIRED_FIELDS.join() === 'imageId,thumbnail,medium,webp,originalSize,processingMs');
  check('hằng số/7 tùy chọn: fileName,width,height,thumbnailId,mediumId,webpId,processedSize', CONFIRM_OPTIONAL_FIELDS.join() === 'fileName,width,height,thumbnailId,mediumId,webpId,processedSize');
  check('hằng số/tổng 13 field, có processedSize, không có contentType', CONFIRM_PAYLOAD_FIELDS.length === 13 && CONFIRM_PAYLOAD_FIELDS.includes('processedSize') && !CONFIRM_PAYLOAD_FIELDS.includes('contentType'));
  check('payload/chỉ 6 field bắt buộc khi không có field tùy chọn nào', Object.keys(minimal).join() === CONFIRM_REQUIRED_FIELDS.join(), Object.keys(minimal).join());
  check('payload/đủ 13 field hợp lệ (tối đa)', Object.keys(payload).sort().join() === [...CONFIRM_PAYLOAD_FIELDS].sort().join() && Object.keys(payload).length === 13, Object.keys(payload).join());
  check('payload/KHÔNG có contentType; processedSize CHỈ có khi truyền kích thước Blob', !('contentType' in payload) && !('contentType' in minimal) && payload.processedSize === 412000 && !('processedSize' in minimal));
  check('payload/processedSize = thumbnail.size + medium.size + webp.size', payload.processedSize === SIZES.thumbnail + SIZES.medium + SIZES.webp && Number.isInteger(payload.processedSize));
  check('payload/chỉ thay đổi kích thước Blob thì processedSize đổi theo (không phải hằng số)', buildConfirmPayload({ ...full, variantSizes: { thumbnail: 1, medium: 2, webp: 3 } }).processedSize === 6);
  check('payload/processedSize = 0 hợp lệ (số nguyên không âm)', buildConfirmPayload({ ...full, variantSizes: { thumbnail: 0, medium: 0, webp: 0 } }).processedSize === 0);
  check('payload/thiếu hẳn variantSizes -> bỏ processedSize, vẫn confirm được (CONTRACT cho phép)', !('processedSize' in buildConfirmPayload({ ...full, variantSizes: undefined })) && !('processedSize' in buildConfirmPayload({ ...full, variantSizes: { thumbnail: undefined, medium: null, webp: undefined } })));
  check('payload/processedSize KHÔNG lấy từ độ dài URL hay tên file (đổi URL không đổi giá trị)', buildConfirmPayload({ ...full, assets: { thumbnail: { secureUrl: url('mot-url-rat-dai-'.repeat(20)) }, medium: assets.medium, webp: assets.webp } }).processedSize === 412000);
  for (const [label, vs] of [['thiếu 1 biến thể', { thumbnail: 1, medium: 2 }], ['âm', { thumbnail: -1, medium: 2, webp: 3 }], ['không nguyên', { thumbnail: 1.5, medium: 2, webp: 3 }], ['NaN', { thumbnail: NaN, medium: 2, webp: 3 }], ['Infinity', { thumbnail: Infinity, medium: 2, webp: 3 }], ['chuỗi', { thumbnail: '1', medium: 2, webp: 3 }]]) {
    const r = await settle((async () => buildConfirmPayload({ ...full, variantSizes: vs }))());
    check(`payload/processedSize có mà sai: ${label} -> ConfirmPayloadError (không âm thầm bỏ)`, r.error instanceof ConfirmPayloadError && r.error.problems.some((p) => p.includes('processedSize')));
  }
  check('payload/3 publicId map PHẲNG đúng biến thể (thumbnailId, mediumId, webpId)', payload.thumbnailId === 'pt' && payload.mediumId === 'pm' && payload.webpId === 'pw' && !('variants' in payload));
  check('payload/URL lấy từ secureUrl, giá trị gốc không bị đổi', payload.thumbnail === url('t') && payload.medium === url('m') && payload.webp === url('w') && payload.originalSize === 2457600 && payload.processingMs === 1840);
  check('payload/fileName, width, height được gửi khi hợp lệ', payload.fileName === 'anh-bien.jpg' && payload.width === 4000 && payload.height === 3000);
  check('payload/KHÔNG tự tạo publicId (không có asset.publicId -> không có *Id)', !('thumbnailId' in minimal) && !('mediumId' in minimal) && !('webpId' in minimal));
  const mixed = buildConfirmPayload({ ...full, assets: { thumbnail: { secureUrl: url('t'), publicId: 'only-thumb' }, medium: { secureUrl: url('m') }, webp: { secureUrl: url('w'), publicId: '' } } });
  check('payload/chỉ gửi *Id nào có giá trị hợp lệ (rỗng/thiếu bị bỏ qua)', mixed.thumbnailId === 'only-thumb' && !('mediumId' in mixed) && !('webpId' in mixed));
  const skipped = buildConfirmPayload({ ...full, fileName: '', width: undefined, height: null });
  check('payload/field tùy chọn thiếu (rỗng/undefined/null) -> bỏ qua, không lỗi', !('fileName' in skipped) && !('width' in skipped) && !('height' in skipped) && skipped.imageId === FIXTURE_ID);
  check('payload/processingMs được làm tròn', buildConfirmPayload({ ...full, processingMs: 1840.6 }).processingMs === 1841);
  const base = { imageId: FIXTURE_ID, originalSize: 100, processingMs: 5, assets };
  const badRequired = [
    ['thiếu imageId', { imageId: '' }], ['thiếu originalSize', { originalSize: undefined }], ['originalSize > 10MB', { originalSize: 10 * 1024 * 1024 + 1 }],
    ['originalSize không nguyên', { originalSize: 10.5 }], ['thiếu processingMs', { processingMs: undefined }], ['processingMs âm', { processingMs: -1 }],
    ['URL không https', { assets: { ...assets, medium: { secureUrl: 'http://x/y' } } }], ['thiếu asset', { assets: { thumbnail: assets.thumbnail } }], ['thiếu assets', { assets: undefined }],
  ];
  for (const [label, over] of badRequired) {
    const r = await settle((async () => buildConfirmPayload({ ...base, ...over }))());
    check(`payload/bắt buộc: ${label} -> ConfirmPayloadError`, r.error instanceof ConfirmPayloadError && r.error.problems.length > 0);
  }
  const badOptional = [
    ['fileName không phải chuỗi', { fileName: 123 }], ['width là chuỗi', { width: '4000' }], ['height không nguyên', { height: 3.5 }], ['width <= 0', { width: 0 }],
    ['publicId không phải chuỗi', { assets: { ...assets, thumbnail: { secureUrl: url('t'), publicId: 42 } } }],
  ];
  for (const [label, over] of badOptional) {
    const r = await settle((async () => buildConfirmPayload({ ...base, ...over }))());
    check(`payload/tùy chọn có mà sai kiểu: ${label} -> ConfirmPayloadError (không âm thầm bỏ)`, r.error instanceof ConfirmPayloadError);
  }

  // ===== Cấu hình =====
  const cfg = (e) => readBackendConfig(e);
  check('config/không cấu hình -> mock (mặc định)', cfg({}).mode === 'mock' && cfg({}).baseUrl === null && cfg({}).configError === null);
  check('config/mock tường minh', cfg({ VITE_BACKEND_MODE: 'mock' }).mode === 'mock');
  check('config/mock bỏ qua URL (không bao giờ dùng để gọi mạng)', cfg({ VITE_BACKEND_MODE: 'mock', VITE_API_BASE_URL: 'https://api.example.com' }).baseUrl === null);
  const real = cfg({ VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: ' https://api.example.com/v1/ ' });
  check('config/real + URL hợp lệ (chuẩn hóa, bỏ "/" cuối)', real.mode === 'real' && real.baseUrl === 'https://api.example.com/v1' && real.configError === null, real.baseUrl);
  check('config/real + http://localhost được phép', cfg({ VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'http://localhost:8000' }).baseUrl === 'http://localhost:8000');
  const missing = cfg({ VITE_BACKEND_MODE: 'real' });
  check('config/real thiếu URL -> invalid + nêu tên biến, KHÔNG phải mock', missing.mode === 'invalid' && missing.configError.missing.join() === 'VITE_API_BASE_URL' && missing.mode !== 'mock');
  for (const [label, u] of [['không phải URL', 'abc'], ['ftp', 'ftp://x.com'], ['http không phải localhost', 'http://api.example.com'], ['có user:pass', 'https://u:p@x.com'], ['có query', 'https://x.com/?a=1']]) {
    const c = cfg({ VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: u });
    check(`config/real + URL ${label} -> invalid`, c.mode === 'invalid' && c.baseUrl === null && !c.configError.message.includes('u:p'));
  }
  check('config/giá trị mode lạ -> invalid', cfg({ VITE_BACKEND_MODE: 'prod' }).mode === 'invalid');

  // ===== Backend client: request =====
  const tokenCalls = [];
  const getIdToken = async (o) => { tokenCalls.push(o?.forceRefresh === true); return TOKEN; };
  {
    const f = makeFetch([reply(200, doneBody(FIXTURE_ID))]);
    const client = createBackendClient({ baseUrl: 'https://api.example.com/', getIdToken, fetchImpl: f });
    check('client/tạo client không gọi mạng và không lấy token', f.calls.length === 0 && tokenCalls.length === 0);
    const r = await settle(client.confirmCloudinaryUpload(payload));
    const { url: reqUrl, init } = f.calls[0];
    check('client/POST đúng URL (base + /images/cloudinary/confirm)', reqUrl === 'https://api.example.com/images/cloudinary/confirm' && init.method === 'POST', reqUrl);
    check('client/Authorization: Bearer <token>', init.headers.Authorization === `Bearer ${TOKEN}`);
    check('client/Content-Type application/json + Accept', init.headers['Content-Type'] === 'application/json' && init.headers.Accept === 'application/json');
    check('client/KHÔNG có X-User-Id (mọi cách viết)', Object.keys(init.headers).every((k) => k.toLowerCase() !== 'x-user-id'));
    check('client/credentials omit, mode cors, có signal', init.credentials === 'omit' && init.mode === 'cors' && init.signal instanceof AbortSignal);
    check('client/body JSON đúng payload 11 field, không đổi', JSON.stringify(JSON.parse(init.body)) === JSON.stringify(payload) && !init.body.includes(TOKEN));
    check('client/token KHÔNG nằm trong URL', !reqUrl.includes(TOKEN));
    const sent = JSON.parse(init.body);
    check('client/body gửi 13 field hợp lệ, có processedSize đúng tổng 3 Blob, KHÔNG có contentType', Object.keys(sent).length === 13 && sent.processedSize === 412000 && !('contentType' in sent));
    check('client/3 publicId gửi PHẲNG, không lồng trong variants', sent.thumbnailId === 'pt' && sent.mediumId === 'pm' && sent.webpId === 'pw' && !('variants' in sent));
    check('client/lấy token mới (forceRefresh=false) đúng 1 lần', tokenCalls.length === 1 && tokenCalls[0] === false);
    check('client/kết quả DONE chuẩn hóa, isMock=false, bị đóng băng',
      r.value?.status === 'DONE' && r.value.imageId === FIXTURE_ID && r.value.isMock === false && r.value.variants.webp.endsWith('full.webp') && r.value.savedPercent === 83.2 && Object.isFrozen(r.value));
    await client.confirmCloudinaryUpload(payload);
    check('client/mỗi request lấy token lại (không cache)', tokenCalls.length === 2);
  }

  // ===== Thiếu token =====
  {
    const f = makeFetch([reply(200, doneBody(FIXTURE_ID))]);
    const noLogin = createBackendClient({ baseUrl: 'https://api.example.com', getIdToken: async () => { throw Object.assign(new Error('Chưa đăng nhập'), { code: 'UNAUTHENTICATED' }); }, fetchImpl: f });
    const r = await settle(noLogin.confirmCloudinaryUpload(payload));
    check('token/chưa đăng nhập -> UNAUTHENTICATED/TOKEN_UNAVAILABLE, KHÔNG gửi request', r.error?.code === 'UNAUTHENTICATED' && r.error.details.kind === 'TOKEN_UNAVAILABLE' && f.calls.length === 0);
    const empty = createBackendClient({ baseUrl: 'https://api.example.com', getIdToken: async () => '', fetchImpl: f });
    const r2 = await settle(empty.confirmCloudinaryUpload(payload));
    check('token/token rỗng -> UNAUTHENTICATED, không gửi request', r2.error?.code === 'UNAUTHENTICATED' && f.calls.length === 0);
    const mockTok = createBackendClient({ baseUrl: 'https://api.example.com', getIdToken: async () => { throw Object.assign(new Error('MOCK: không có token thật'), { code: 'UNAUTHENTICATED' }); }, fetchImpl: f });
    check('token/đang ở MOCK auth -> không gửi gì tới Backend thật', (await settle(mockTok.confirmCloudinaryUpload(payload))).error?.code === 'UNAUTHENTICATED' && f.calls.length === 0);
    check('client/thiếu getIdToken hoặc baseUrl -> TypeError', (await settle((async () => createBackendClient({ baseUrl: 'https://a.com' }))())).error instanceof TypeError && (await settle((async () => createBackendClient({ getIdToken }))())).error instanceof TypeError);
  }

  // ===== 401: làm mới token tối đa MỘT lần =====
  {
    const seen = [];
    const gt = async (o) => { seen.push(o?.forceRefresh === true); return o?.forceRefresh ? 'TOK-2' : 'TOK-1'; };
    const f = makeFetch([reply(401, { detail: 'Missing token' }), reply(200, doneBody(FIXTURE_ID))]);
    const c = createBackendClient({ baseUrl: 'https://a.com', getIdToken: gt, fetchImpl: f });
    const r = await settle(c.confirmCloudinaryUpload(payload));
    check('401/làm mới token rồi gửi lại 1 lần -> thành công', r.value?.status === 'DONE' && f.calls.length === 2 && seen.join() === 'false,true');
    check('401/lần gửi lại dùng token mới', f.calls[0].init.headers.Authorization === 'Bearer TOK-1' && f.calls[1].init.headers.Authorization === 'Bearer TOK-2');
    const f2 = makeFetch([reply(401, { detail: 'Missing token' })]);
    const c2 = createBackendClient({ baseUrl: 'https://a.com', getIdToken: gt, fetchImpl: f2 });
    const r2 = await settle(c2.confirmCloudinaryUpload(payload));
    check('401/vẫn 401 sau khi làm mới -> UNAUTHENTICATED, ĐÚNG 2 request (không lặp)', r2.error?.code === 'UNAUTHENTICATED' && r2.error.details.httpStatus === 401 && f2.calls.length === 2);
    const f3 = makeFetch([reply(401, {})]);
    const c3 = createBackendClient({ baseUrl: 'https://a.com', getIdToken: async () => 'SAME', fetchImpl: f3 });
    check('401/token làm mới giống token cũ -> không gửi lại', (await settle(c3.confirmCloudinaryUpload(payload))).error?.code === 'UNAUTHENTICATED' && f3.calls.length === 1);
    const f4 = makeFetch([reply(401, {})]);
    const c4 = createBackendClient({ baseUrl: 'https://a.com', getIdToken: async (o) => { if (o?.forceRefresh) throw new Error('net'); return 'T'; }, fetchImpl: f4 });
    check('401/làm mới token thất bại -> báo 401, không gửi lại', (await settle(c4.confirmCloudinaryUpload(payload))).error?.code === 'UNAUTHENTICATED' && f4.calls.length === 1);
  }

  // ===== Mã lỗi HTTP =====
  const httpCases = [
    [400, { detail: 'Invalid cloudinary url' }, 'VALIDATION', 'BAD_REQUEST'], [401, { detail: 'Missing token' }, 'UNAUTHENTICATED', 'UNAUTHENTICATED'],
    [403, { detail: 'Forbidden' }, 'FORBIDDEN', 'FORBIDDEN'], [404, { detail: 'Image not found' }, 'NOT_FOUND', 'NOT_FOUND'],
    [413, { detail: 'File too large' }, 'VALIDATION', 'TOO_LARGE'], [422, { detail: [] }, 'VALIDATION', 'UNPROCESSABLE'],
    [429, { detail: 'Too many requests' }, 'QUOTA_EXCEEDED', 'RATE_LIMITED'], [500, { detail: 'Internal error' }, 'UNKNOWN', 'SERVER_ERROR'],
    [502, 'Bad Gateway', 'UNKNOWN', 'SERVER_ERROR'], [503, '', 'UNKNOWN', 'SERVER_ERROR'], [409, { detail: 'x' }, 'UNKNOWN', 'HTTP_ERROR'],
  ];
  for (const [status, body, code, kind] of httpCases) {
    const f = makeFetch([reply(status, body)]);
    const c = createBackendClient({ baseUrl: 'https://a.com', getIdToken: async (o) => (o?.forceRefresh ? 'REFRESHED' : 'T'), fetchImpl: f });
    const r = await settle(c.confirmCloudinaryUpload(payload));
    check(`http/${status} -> ${code}/${kind}`, r.error?.code === code && r.error.details.kind === kind && r.error.details.httpStatus === status, `${r.error?.code}/${r.error?.details?.kind}`);
    if (status !== 401) check(`http/${status} -> KHÔNG tự retry (1 request)`, f.calls.length === 1);
  }
  {
    const r = await settle(createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: makeFetch([reply(400, { detail: 'Invalid cloudinary url' })]) }).confirmCloudinaryUpload(payload));
    check('detail/chuỗi hiện trong thông báo và details.detail', r.error.message.includes('Invalid cloudinary url') && r.error.details.detail === 'Invalid cloudinary url');
    const arr = [{ type: 'missing', loc: ['body', 'imageId'], msg: 'Field required' }, { loc: ['body', 'width'], msg: 'Input should be a valid integer' }];
    const r2 = await settle(createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: makeFetch([reply(422, { detail: arr })]) }).confirmCloudinaryUpload(payload));
    check('detail/mảng FastAPI 422 -> "imageId: Field required; width: ..."', r2.error.details.detail === 'imageId: Field required; width: Input should be a valid integer', r2.error.details.detail);
    const r3 = await settle(createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: makeFetch([reply(500, '<html>oops</html>')]) }).confirmCloudinaryUpload(payload));
    check('detail/body lỗi không phải JSON -> detail=null, vẫn có lỗi 500', r3.error.details.detail === null && r3.error.details.httpStatus === 500);
    const r4 = await settle(createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: makeFetch([reply(400, { detail: 'x'.repeat(1000) })]) }).confirmCloudinaryUpload(payload));
    check('detail/bị cắt ngắn', r4.error.details.detail.length === 300);
    check('retryable/5xx và 429 = true, 400 = không', r3.error.details.retryable === true && r.error.details.retryable !== true);
  }

  // ===== Response 2xx không hợp lệ =====
  const badOk = {
    'JSON không hợp lệ': '<html>', 'mảng JSON': '[]', 'thiếu status DONE (PENDING)': { ...doneBody(FIXTURE_ID), status: 'PENDING' }, 'thiếu status': { ...doneBody(FIXTURE_ID), status: undefined },
    'imageId không khớp': doneBody('other-id'), 'thiếu variants': { ...doneBody(FIXTURE_ID), variants: null },
    'variants thiếu medium': { ...doneBody(FIXTURE_ID), variants: { thumbnail: 'https://a/t', webp: 'https://a/w' } }, 'URL biến thể http': { ...doneBody(FIXTURE_ID), variants: { thumbnail: 'http://a', medium: 'https://a', webp: 'https://a' } },
    'body rỗng': '',
  };
  for (const [label, body] of Object.entries(badOk)) {
    const r = await settle(createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: makeFetch([reply(200, body)]) }).confirmCloudinaryUpload(payload));
    check(`response/${label} -> INVALID_RESPONSE`, r.error?.code === 'UNKNOWN' && r.error.details.kind === 'INVALID_RESPONSE', `${r.error?.code}/${r.error?.details?.kind}`);
  }
  {
    const r = await settle(createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: makeFetch([reply(200, { ...doneBody(FIXTURE_ID), ownerId: undefined, savedPercent: 'x', processingMs: undefined })]) }).confirmCloudinaryUpload(payload));
    check('response/trường tùy chọn thiếu hoặc sai kiểu -> null', r.value?.ownerId === null && r.value.savedPercent === null && r.value.processingMs === null);
  }

  // ===== Response: *Id tùy chọn trong variants =====
  {
    const mk = (body) => createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: makeFetch([reply(200, body)]) });
    const withIds = await settle(mk(doneBodyWithIds(FIXTURE_ID)).confirmCloudinaryUpload(payload));
    check('response/đọc thumbnailId, mediumId, webpId trong variants', withIds.value?.variants.thumbnailId === 'abc/thumb' && withIds.value.variants.mediumId === 'abc/medium' && withIds.value.variants.webpId === 'abc/full');
    const noIds = await settle(mk(doneBody(FIXTURE_ID)).confirmCloudinaryUpload(payload));
    check('response/Backend không trả *Id -> KHÔNG bịa (không có khóa *Id)', noIds.value?.status === 'DONE' && Object.keys(noIds.value.variants).join() === 'thumbnail,medium,webp');
    const partial = await settle(mk({ ...doneBody(FIXTURE_ID), variants: { ...doneBody(FIXTURE_ID).variants, mediumId: 'abc/medium', thumbnailId: '', webpId: 7 } }).confirmCloudinaryUpload(payload));
    check('response/chỉ giữ *Id là chuỗi không rỗng', partial.value?.variants.mediumId === 'abc/medium' && !('thumbnailId' in partial.value.variants) && !('webpId' in partial.value.variants));
    check('response/*Id không thay đổi điều kiện DONE/imageId/3 URL', (await settle(mk({ ...doneBodyWithIds(FIXTURE_ID), imageId: 'x' }).confirmCloudinaryUpload(payload))).error?.details?.kind === 'INVALID_RESPONSE');
  }

  // ===== Client: chỉ gửi field đúng CONTRACT =====
  {
    const f = makeFetch([reply(200, doneBody(FIXTURE_ID))]);
    const c = createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: f });
    const ok6 = await settle(c.confirmCloudinaryUpload(minimal));
    check('client/chấp nhận request chỉ có 6 field bắt buộc', ok6.value?.status === 'DONE' && Object.keys(JSON.parse(f.calls[0].init.body)).length === 6);
    const ok13 = await settle(c.confirmCloudinaryUpload(payload));
    check('client/chấp nhận đủ 13 field (6 bắt buộc + 7 tùy chọn)', ok13.value?.status === 'DONE' && Object.keys(JSON.parse(f.calls[1].init.body)).length === 13);
    const before = f.calls.length;
    for (const extra of ['contentType', 'publicId', 'variants', 'processed_size']) {
      const r = await settle(c.confirmCloudinaryUpload({ ...payload, [extra]: 'x' }));
      check(`client/từ chối field ngoài CONTRACT "${extra}" TRƯỚC khi gửi`, r.error?.code === 'VALIDATION' && r.error.details.kind === 'BAD_REQUEST' && r.error.message.includes(extra));
    }
    for (const name of CONFIRM_REQUIRED_FIELDS) {
      const miss = { ...payload }; delete miss[name];
      const r = await settle(c.confirmCloudinaryUpload(miss));
      check(`client/thiếu field bắt buộc "${name}" -> từ chối TRƯỚC khi gửi`, r.error?.code === 'VALIDATION' && r.error.message.includes(name));
    }
    check('client/field bị từ chối không tạo request nào', f.calls.length === before);
    const noOptional = { ...payload }; for (const k of CONFIRM_OPTIONAL_FIELDS) delete noOptional[k];
    check('client/thiếu mọi field tùy chọn vẫn hợp lệ', (await settle(c.confirmCloudinaryUpload(noOptional))).value?.status === 'DONE' && f.calls.length === before + 1);
  }

  // ===== Mạng, timeout, hủy =====
  {
    const f = makeFetch([rejectNet()]);
    const c = createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: f });
    const r = await settle(c.confirmCloudinaryUpload(payload));
    check('mạng/fetch ném lỗi -> NETWORK, KHÔNG tự retry', r.error?.code === 'NETWORK' && r.error.details.kind === 'NETWORK' && r.error.details.retryable === true && f.calls.length === 1);
    const f2 = makeFetch([hang()]);
    const c2 = createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: f2, timeoutMs: 30 });
    const r2 = await settle(c2.confirmCloudinaryUpload(payload));
    check('timeout -> NETWORK/TIMEOUT và hủy fetch', r2.error?.code === 'NETWORK' && r2.error.details.kind === 'TIMEOUT' && f2.calls[0].init.signal.aborted === true && f2.calls.length === 1);
    const ctl = new AbortController(); ctl.abort();
    const f3 = makeFetch([reply(200, doneBody(FIXTURE_ID))]);
    const r3 = await settle(createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: f3 }).confirmCloudinaryUpload(payload, { signal: ctl.signal }));
    check('hủy/trước khi gửi -> CANCELLED, không request', r3.error?.code === 'CANCELLED' && f3.calls.length === 0);
    const ctl2 = new AbortController();
    const f4 = makeFetch([hang()]);
    const pr = settle(createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: f4, timeoutMs: 5000 }).confirmCloudinaryUpload(payload, { signal: ctl2.signal }));
    await tick(10); ctl2.abort();
    const r4 = await pr;
    check('hủy/giữa chừng -> CANCELLED, abort fetch, không retry', r4.error?.code === 'CANCELLED' && f4.calls[0].init.signal.aborted && f4.calls.length === 1);
  }

  // ===== Use case confirm =====
  {
    const f = makeFetch([reply(200, doneBody(FIXTURE_ID))]);
    const backendApi = createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: f });
    const confirm = createConfirmCloudinaryUpload({ backendApi });
    const r = await settle(confirm(args()));
    check('use case/thành công -> DONE chỉ từ kết quả Backend hợp lệ', r.value?.status === 'DONE' && r.value.imageId === FIXTURE_ID && r.value.isMock === false);
    check('use case/body gửi lên = payload dựng từ file+processed+assets', JSON.stringify(JSON.parse(f.calls[0].init.body)) === JSON.stringify(payload));

    const f2 = makeFetch([reply(200, doneBody(FIXTURE_ID))]);
    const confirm2 = createConfirmCloudinaryUpload({ backendApi: createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: f2 }) });
    for (const [label, over] of [['thiếu imageId', { imageId: undefined }], ['thiếu file', { file: undefined }], ['thiếu assets', { assets: undefined }], ['thiếu processed', { processed: undefined }]]) {
      const rr = await settle(confirm2(args(over)));
      check(`use case/${label} -> VALIDATION, không gọi Backend`, rr.error?.code === 'VALIDATION' && rr.error.details.kind === 'INVALID_PAYLOAD');
    }
    check('use case/payload sai không tạo request nào', f2.calls.length === 0);

    // Backend lỗi SAU upload: giữ asset để thử lại confirm
    const f3 = makeFetch([rejectNet(), reply(200, doneBody(FIXTURE_ID))]);
    const confirm3 = createConfirmCloudinaryUpload({ backendApi: createBackendClient({ baseUrl: 'https://a.com', getIdToken, fetchImpl: f3 }) });
    const rr = await settle(confirm3(args()));
    check('use case/confirm lỗi mạng -> giữ code NETWORK, retryable, KHÔNG phải DONE', rr.error?.code === 'NETWORK' && rr.error.details.retryable === true && rr.value === undefined);
    check('use case/lỗi mang theo assets (3 publicId) + payload để thử lại confirm', rr.error.details.assets.medium.publicId === 'pm' && rr.error.details.confirmPayload.imageId === FIXTURE_ID);
    check('use case/thông báo nói rõ không cần upload lại', /không cần upload lại/.test(rr.error.message));
    const retry = await settle(confirm3(args({ assets: rr.error.details.assets })));
    check('use case/thử lại CHỈ confirm bằng asset đã giữ -> DONE', retry.value?.status === 'DONE' && f3.calls.length === 2);
    const firstBody = JSON.parse(f3.calls[0].init.body); const retryBody = JSON.parse(f3.calls[1].init.body);
    check('use case/imageId KHÔNG đổi khi retry confirm (cùng imageId ở cả hai request)', firstBody.imageId === FIXTURE_ID && retryBody.imageId === FIXTURE_ID && rr.error.details.imageId === FIXTURE_ID);
    check('use case/retry gửi lại cùng payload, vẫn 3 *Id từ publicId H2', JSON.stringify(firstBody) === JSON.stringify(retryBody) && retryBody.thumbnailId === 'pt' && retryBody.webpId === 'pw');
    check('use case/request: processedSize = tổng 3 Blob thật của kết quả nén, KHÔNG có contentType (file.type vẫn còn ở đầu vào)', retryBody.processedSize === processed.blobs.thumbnail.size + processed.blobs.medium.size + processed.blobs.webp.size && retryBody.processedSize === 412000 && !('contentType' in retryBody) && file.type === 'image/jpeg');

    // Adapter trả kết quả không hợp lệ -> Application không tin
    for (const [label, res] of [['status PENDING', { imageId: FIXTURE_ID, status: 'PENDING' }], ['imageId lệch', { imageId: 'x', status: 'DONE', variants: {} }], ['null', null]]) {
      const rv = await settle(createConfirmCloudinaryUpload({ backendApi: { confirmCloudinaryUpload: async () => res } })(args()));
      check(`use case/adapter trả ${label} -> không DONE`, rv.error?.code === 'UNKNOWN' && rv.error.details.kind === 'INVALID_RESPONSE' && rv.value === undefined);
    }
    const rawErr = await settle(createConfirmCloudinaryUpload({ backendApi: { confirmCloudinaryUpload: async () => { throw new Error('lạ'); } } })(args()));
    check('use case/lỗi không có code -> UNKNOWN, vẫn giữ asset', rawErr.error?.code === 'UNKNOWN' && !!rawErr.error.details.assets);
  }

  // ===== Mock Backend =====
  {
    const fetchSpy = [];
    globalThis.fetch = (...a) => { fetchSpy.push(a); throw new Error('KHÔNG được gọi fetch trong MOCK'); };
    const mock = createMockBackendApi({ latencyMs: 0 });
    const r1 = await settle(mock.confirmCloudinaryUpload(payload));
    check('mock/thành công: DONE, isMock=true', r1.value?.status === 'DONE' && r1.value.isMock === true && r1.value.variants.thumbnail === payload.thumbnail);
    check('mock/có processedSize hợp lệ -> savedPercent = (1 - processedSize/originalSize) x 100 = 83.2 (ví dụ CONTRACT)', r1.value.savedPercent === 83.2, String(r1.value.savedPercent));
    check('mock/KHÔNG có processedSize -> KHÔNG bịa savedPercent (null)', (await settle(createMockBackendApi({ latencyMs: 0 }).confirmCloudinaryUpload(minimal))).value.savedPercent === null);
    check('mock/savedPercent tính đúng với số khác: 1000/4000 -> 75', (await settle(createMockBackendApi({ latencyMs: 0 }).confirmCloudinaryUpload({ ...payload, originalSize: 4000, processedSize: 1000 }))).value.savedPercent === 75);
    check('mock/processedSize = 0 -> savedPercent 100, processedSize > originalSize -> âm (không cắt)', (await settle(createMockBackendApi({ latencyMs: 0 }).confirmCloudinaryUpload({ ...payload, processedSize: 0 }))).value.savedPercent === 100 && (await settle(createMockBackendApi({ latencyMs: 0 }).confirmCloudinaryUpload({ ...payload, originalSize: 1000, processedSize: 1500 }))).value.savedPercent === -50);
    const sim = await settle(createMockBackendApi({ latencyMs: 0, savedPercent: 50 }).confirmCloudinaryUpload(minimal));
    check('mock/savedPercent mô phỏng chỉ dùng khi KHÔNG có processedSize; có processedSize thì giá trị tính toán thắng', sim.value?.savedPercent === 50 && sim.value.isMock === true && (await settle(createMockBackendApi({ latencyMs: 0, savedPercent: 50 }).confirmCloudinaryUpload(payload))).value.savedPercent === 83.2);
    check('mock/trả lại đúng 3 *Id mà request đã gửi (không bịa)', r1.value.variants.thumbnailId === 'pt' && r1.value.variants.mediumId === 'pm' && r1.value.variants.webpId === 'pw');
    const mnl = await settle(createMockBackendApi({ latencyMs: 0 }).confirmCloudinaryUpload(minimal));
    check('mock/chấp nhận request chỉ có 6 field bắt buộc; response không có *Id', mnl.value?.status === 'DONE' && !('thumbnailId' in mnl.value.variants));
    check('mock/chấp nhận đủ 13 field (có processedSize)', Object.keys(payload).length === 13 && r1.value.status === 'DONE');
    const no12 = { ...payload }; delete no12.processedSize;
    check('mock/KHÔNG bắt buộc processedSize: 12 field (thiếu processedSize) vẫn được chấp nhận', (await settle(createMockBackendApi({ latencyMs: 0 }).confirmCloudinaryUpload(no12))).value?.status === 'DONE');
    const r2 = await settle(mock.confirmCloudinaryUpload({ ...payload, thumbnail: url('khac') }));
    check('mock/confirm trùng imageId -> trả kết quả CŨ, không ghi đè (idempotent)', r2.value === r1.value && r2.value.variants.thumbnail === payload.thumbnail && mock.debug.storedCount() === 1 && mock.debug.attemptsFor(FIXTURE_ID) === 2);
    const r3 = await settle(mock.confirmCloudinaryUpload({ ...payload, imageId: 'fixture-2' }));
    check('mock/imageId khác -> bản ghi riêng', r3.value?.imageId === 'fixture-2' && mock.debug.storedCount() === 2);

    const violations = [
      ...CONFIRM_REQUIRED_FIELDS.map((name) => [`thiếu field bắt buộc ${name}`, (p) => { const c = { ...p }; delete c[name]; return c; }, `Missing field: ${name}`]),
      ['field lạ publicId bị từ chối', (p) => ({ ...p, publicId: 'x' }), 'Unknown field: publicId'],
      ['field contentType KHÔNG còn được nhận', (p) => ({ ...p, contentType: 'image/jpeg' }), 'Unknown field: contentType'],
      ['processedSize sai kiểu (chuỗi)', (p) => ({ ...p, processedSize: '412000' }), 'Invalid type: processedSize'],
      ['processedSize âm', (p) => ({ ...p, processedSize: -1 }), 'Invalid value: processedSize'],
      ['processedSize không nguyên', (p) => ({ ...p, processedSize: 10.5 }), 'Invalid value: processedSize'],
      ['processedSize NaN', (p) => ({ ...p, processedSize: NaN }), 'Invalid value: processedSize'],
      ['tùy chọn width sai kiểu', (p) => ({ ...p, width: '4000' }), 'Invalid type: width'],
      ['tùy chọn thumbnailId sai kiểu', (p) => ({ ...p, thumbnailId: 5 }), 'Invalid type: thumbnailId'],
      ['tùy chọn fileName sai kiểu', (p) => ({ ...p, fileName: 5 }), 'Invalid type: fileName'],
      ['tùy chọn height không nguyên dương', (p) => ({ ...p, height: 0 }), 'Invalid value: height'],
      ['sai kiểu originalSize', (p) => ({ ...p, originalSize: '5' }), 'Invalid type: originalSize'],
      ['> 10MB', (p) => ({ ...p, originalSize: 10 * 1024 * 1024 + 1 }), 'File too large'],
      ['URL host lạ', (p) => ({ ...p, medium: 'https://evil.example.com/x.webp' }), 'Invalid cloudinary url'],
      ['URL http', (p) => ({ ...p, webp: 'http://res.cloudinary.com/x.webp' }), 'Invalid cloudinary url'],
    ];
    for (const [label, mut, detail] of violations) {
      const rv = await settle(createMockBackendApi({ latencyMs: 0 }).confirmCloudinaryUpload(mut(payload)));
      check(`mock/${label} -> 400 "${detail}"`, rv.error?.code === 'VALIDATION' && rv.error.details.httpStatus === 400 && rv.error.details.detail === detail, `${rv.error?.details?.detail}`);
    }
    const strict = createMockBackendApi({ latencyMs: 0, cloudName: 'other-cloud' });
    check('mock/URL không thuộc cloud của nhóm -> 400', (await settle(strict.confirmCloudinaryUpload(payload))).error?.details?.detail === 'Invalid cloudinary url');
    const known = createMockBackendApi({ latencyMs: 0, knownImageIds: new Set(['abc']) });
    check('mock/imageId chưa từng tạo PENDING -> 404', (await settle(known.confirmCloudinaryUpload(payload))).error?.code === 'NOT_FOUND');

    const scen = [[SC.UNAUTHENTICATED, 'UNAUTHENTICATED', 401], [SC.FORBIDDEN, 'FORBIDDEN', 403], [SC.NOT_FOUND, 'NOT_FOUND', 404], [SC.RATE_LIMITED, 'QUOTA_EXCEEDED', 429], [SC.SERVER_ERROR, 'UNKNOWN', 500], [SC.NETWORK, 'NETWORK', undefined], [SC.TIMEOUT, 'NETWORK', undefined]];
    for (const [s, code, status] of scen) {
      const rv = await settle(createMockBackendApi({ latencyMs: 0, getScenario: () => s }).confirmCloudinaryUpload(payload));
      check(`mock/kịch bản ${s} -> ${code}${status ? ` (HTTP ${status})` : ''}`, rv.error?.code === code && rv.error.details.httpStatus === status, `${rv.error?.code}`);
    }
    const tm = await settle(createMockBackendApi({ latencyMs: 0, getScenario: () => SC.TIMEOUT }).confirmCloudinaryUpload(payload));
    check('mock/kịch bản timeout mang kind TIMEOUT', tm.error.details.kind === 'TIMEOUT');
    // Use case + mock: kịch bản invalid-response không bị coi là DONE
    const ucBad = await settle(createConfirmCloudinaryUpload({ backendApi: createMockBackendApi({ latencyMs: 0, getScenario: () => SC.INVALID_RESPONSE }) })(args()));
    check('mock+use case/kịch bản invalid-response -> không DONE', ucBad.error?.details?.kind === 'INVALID_RESPONSE');
    const ucOk = await settle(createConfirmCloudinaryUpload({ backendApi: createMockBackendApi({ latencyMs: 0 }) })(args()));
    check('mock+use case/payload do use case dựng được mock chấp nhận -> DONE (isMock=true)', ucOk.value?.status === 'DONE' && ucOk.value.isMock === true);
    // Hủy trong lúc chờ
    const ctl = new AbortController();
    const slow = createMockBackendApi({ latencyMs: 200 });
    const pr = settle(slow.confirmCloudinaryUpload(payload, { signal: ctl.signal }));
    await tick(10); ctl.abort();
    check('mock/hủy khi đang chờ -> CANCELLED', (await pr).error?.code === 'CANCELLED' && slow.debug.storedCount() === 0);
    check('mock/KHÔNG gọi fetch dưới mọi kịch bản', fetchSpy.length === 0);
    delete globalThis.fetch;
  }

  // ===== Composition root =====
  {
    const calls = [];
    globalThis.fetch = (...a) => { calls.push(a); throw new Error('không được gọi mạng'); };
    const tokenSpy = [];
    const mockSvc = createBackendServices({ config: readBackendConfig({}), getIdToken: async () => { tokenSpy.push(1); return TOKEN; }, mockOptions: { latencyMs: 0 } });
    check('composition/mặc định mode mock, isMock=true', mockSvc.mode === 'mock' && mockSvc.isMock === true && mockSvc.configError === null);
    const rm = await settle(mockSvc.useCases.confirmCloudinaryUpload(args()));
    check('composition/mock: confirm DONE, isMock=true', rm.value?.status === 'DONE' && rm.value.isMock === true);
    check('composition/mock: không fetch, không lấy ID token', calls.length === 0 && tokenSpy.length === 0);

    const realSvc = createBackendServices({ config: readBackendConfig({ VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'https://api.example.com' }), getIdToken: async () => { tokenSpy.push(1); return TOKEN; } });
    check('composition/real: tạo xong KHÔNG gọi mạng và KHÔNG lấy token', realSvc.mode === 'real' && realSvc.isMock === false && calls.length === 0 && tokenSpy.length === 0);
    const needTok = await settle((async () => createBackendServices({ config: readBackendConfig({ VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'https://api.example.com' }) }))());
    check('composition/real thiếu getIdToken -> TypeError (lỗi lập trình)', needTok.error instanceof TypeError);

    const inv = createBackendServices({ config: readBackendConfig({ VITE_BACKEND_MODE: 'real' }) });
    check('composition/real thiếu URL -> mode invalid, KHÔNG phải mock', inv.mode === 'invalid' && inv.isMock === false && inv.configError.missing.includes('VITE_API_BASE_URL'));
    const ri = await settle(inv.useCases.confirmCloudinaryUpload(args()));
    check('composition/invalid: confirm báo CONFIG rõ ràng, không DONE, không mạng', ri.error?.code === 'CONFIG' && ri.error.details.kind === 'CONFIG' && ri.value === undefined && calls.length === 0);
    const un = await settle(createUnavailableBackendApi({ message: 'm' }).confirmCloudinaryUpload());
    check('unavailable/luôn CONFIG', un.error?.code === 'CONFIG');
    delete globalThis.fetch;
  }
} finally {
  await server.close();
}

// ===== Quét mã nguồn =====
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
const files = ['src/infrastructure/api/backendClient.js', 'src/infrastructure/api/backendConfig.js', 'src/infrastructure/api/backendErrors.js',
  'src/infrastructure/mock/mockBackendApi.js', 'src/application/usecases/confirmCloudinaryUpload.js', 'src/domain/models/confirmPayload.js', 'src/app/createBackendServices.js'];
for (const f of files) {
  const code = strip(read(f));
  const n = path.basename(f);
  check(`mã nguồn ${n}/không console.*`, !/console\./.test(code));
  check(`mã nguồn ${n}/không localStorage/sessionStorage/cookie`, !/localStorage|sessionStorage|document\.cookie/.test(code));
  check(`mã nguồn ${n}/không X-User-Id`, !/x-user-id/i.test(code));
  check(`mã nguồn ${n}/không import firebase/firestore`, !/from ['"][^'"]*(firebase|firestore)/i.test(code));
  check(`mã nguồn ${n}/không dùng Cloudinary uploader`, !/cloudinaryUploader|uploadVariantsToCloudinary|XMLHttpRequest|api\.cloudinary\.com/.test(code));
}
// H4B-4 (đã được duyệt): backendClient có THÊM đúng một endpoint — POST /images/cloudinary/authorize (Backend 30318ee). Không endpoint nào khác.
check('mã nguồn backendClient/chỉ có endpoint confirm và authorize của CONTRACT', (strip(read(files[0])).match(/\/images\/[a-z/]+/g) || []).join() === '/images/cloudinary/confirm,/images/cloudinary/authorize');
const all = [];
(function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : /\.(js|jsx)$/.test(n) && all.push(p); } })(path.join(root, 'src'));
// Giá trị Cloudinary thật KHÔNG hardcode trong test: lấy từ biến môi trường của người chạy (nếu có).
// Ngoài ra luôn kiểm tra theo cấu trúc: không URL Cloudinary nào trong mã (đã bỏ chú thích) mang cloud name viết thẳng.
const realValues = [process.env.SMOKE_REAL_CLOUD_NAME, process.env.SMOKE_REAL_UPLOAD_PRESET].map((v) => v?.trim()).filter(Boolean);
const literalCloudUrl = /cloudinary\.com\/(?!v1_1\/\$\{|\$\{)[A-Za-z0-9_-]+/;
check('không hardcode URL Backend/cloud thật trong src', all.every((p) => {
  const code = strip(fs.readFileSync(p, 'utf8'));
  return !realValues.some((v) => code.includes(v)) && !literalCloudUrl.test(code) && !/railway|onrender|herokuapp|localhost:8000/.test(code);
}));
check('không tạo imageId ở lớp Frontend mới (không uuid/randomUUID trong file H3A)', files.every((f) => !/randomUUID|uuid|generateId/i.test(strip(read(f)))));
check('mã nguồn H3A không còn chú thích "Backend cấp imageId" / "11 field" / "chưa chốt cấp imageId"', files.every((f) => !/Backend cấp|11 field|9 field|chưa chốt cấp|KHÔNG tự cấp imageId thật/.test(read(f))));
check('mã nguồn dựng payload không dùng contentType; processedSize tính từ kích thước Blob (sumProcessedSize), không từ URL', !/contentType/.test(strip(read('src/domain/models/confirmPayload.js'))) && /sumProcessedSize\(variantSizes\)/.test(strip(read('src/domain/models/confirmPayload.js'))) && !/contentType/.test(strip(read('src/application/usecases/confirmCloudinaryUpload.js'))) && /blobs\?\.thumbnail\?\.size/.test(strip(read('src/application/usecases/confirmCloudinaryUpload.js'))));
check('mã nguồn mock không nhận contentType; có xử lý processedSize', !/contentType/.test(strip(read('src/infrastructure/mock/mockBackendApi.js'))) && /\['processedSize', 'number'\]/.test(strip(read('src/infrastructure/mock/mockBackendApi.js'))));
check('console không bị ghi token trong lúc test', logged.every((l) => !l.includes(TOKEN) && !l.includes('Bearer')), logged.join(' | ').slice(0, 120));

out(`PASSED: ${passed}`);
out(`FAILED: ${failures.length}`);
failures.forEach((f) => out('  ✗ ' + f));
if (!realValues.length) out('NOTE: chưa đặt SMOKE_REAL_CLOUD_NAME/SMOKE_REAL_UPLOAD_PRESET -> chỉ kiểm tra "không hardcode" theo cấu trúc URL, chưa so với giá trị thật.');
process.exit(failures.length ? 1 : 0);
