// Smoke test INT-3A — Gallery API client (GET /images, GET /images/{id}). fetch GIẢ: KHÔNG gọi mạng, KHÔNG gọi Backend/Firebase/Cloudinary thật.
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/int3a-gallery-smoke.mjs .  (xem tests/README.md)
// "Backend giả" bên dưới mô phỏng NGỮ NGHĨA của Backend thật (be-clean 842d3f7): uid lấy từ token, chỉ trả ảnh của uid đó,
// cursor mờ, JSON có dạng tài liệu Firestore (kể cả field nội bộ mà Frontend không được đưa vào model).
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

// ---------- bẫy mạng toàn cục: mọi fetch/XHR thật đều bị chặn và đếm ----------
let globalNetCalls = 0;
globalThis.fetch = async () => { globalNetCalls += 1; throw new Error('INT-3A smoke: bị chặn gọi mạng thật'); };
globalThis.XMLHttpRequest = class { constructor() { globalNetCalls += 1; throw new Error('INT-3A smoke: bị chặn XHR'); } };

// ---------- ghi console để kiểm tra không rò rỉ token ----------
const logged = [];
for (const m of ['log', 'info', 'warn', 'error', 'debug']) console[m] = (...a) => { logged.push(a.map(String).join(' ')); };

// ---------- Backend giả ----------
const BASE = 'https://api.example.test';
const TOKENS = { 'TOKEN-A': 'uid-A', 'TOKEN-B': 'uid-B' };
const res = (status, body) => ({ status, text: async () => (typeof body === 'string' ? body : JSON.stringify(body)) });
const b64 = (s) => Buffer.from(s).toString('base64url');
const unb64 = (s) => Buffer.from(s, 'base64url').toString('utf8');
const urlOf = (id, n) => `https://res.cloudinary.com/demo-cloud/image/upload/v1/${id}_${n}.webp`;
const isoAt = (i, tz = '+00:00') => `${new Date(Date.UTC(2026, 2, 1) + i * 60_000).toISOString().slice(0, 19)}.${String(i % 1000).padStart(3, '0')}456${tz}`;

const cdoc = (id, owner, i, over = {}) => ({
  imageId: id, ownerId: owner, retryCount: 0, createdAt: isoAt(i), status: 'DONE', provider: 'cloudinary', fileName: `${id}.png`,
  original: { size: 2457600, width: 4000, height: 3000 },
  variants: { thumbnail: urlOf(id, 't'), medium: urlOf(id, 'm'), webp: urlOf(id, 'w') },
  publicIds: { thumbnail: `x/${id}_t` }, assetIds: { thumbnail: `x/${id}_t`, medium: `x/${id}_m`, webp: `x/${id}_w` },
  previewUrl: urlOf(id, 't'), processedSize: 412000, processingMs: 1840, savedPercent: 83.2, errorReason: null, updatedAt: isoAt(i), ...over,
});
const ddoc = (fid, owner, i, over = {}) => ({
  imageId: `drive_${fid}`, ownerId: owner, provider: 'google_drive', originalName: `${fid}.jpg`, mimeType: 'image/jpeg', sizeBytes: 1234,
  status: 'DONE', currentFolder: 'processed', storagePath: `processed/${owner}/${fid}.jpg`, driveFileId: fid, cloudinaryPublicId: null,
  previewUrl: `/images/preview/${fid}`, pipelineFolders: { upload: 'f1', processing: 'f2', processed: 'f3' },
  variants: { thumbnail: `/images/preview/${fid}`, medium: `/images/preview/${fid}`, webp: `/images/preview/${fid}` },
  processingMs: null, createdAt: isoAt(i, 'Z'), updatedAt: isoAt(i, 'Z'), ...over,
});

function makeBackend(docsByUid, { tokens = TOKENS } = {}) {
  const calls = [];
  const sorted = (uid) => [...(docsByUid[uid] ?? [])].sort((a, b) => (a.createdAt === b.createdAt ? (a.imageId < b.imageId ? 1 : -1) : a.createdAt < b.createdAt ? 1 : -1));
  const fetchImpl = async (url, init) => {
    calls.push({ url: String(url), init });
    const u = new URL(url);
    const auth = init.headers?.Authorization ?? '';
    const uid = tokens[auth.startsWith('Bearer ') ? auth.slice(7) : ''];
    if (!uid) return res(401, { detail: auth ? 'Invalid token' : 'Missing token' });
    if (init.method !== 'GET') return res(405, { detail: 'Method Not Allowed' });
    if (u.pathname === '/images') {
      const rawLimit = u.searchParams.get('limit');
      if (rawLimit !== null && (!/^[0-9]{1,18}$/.test(rawLimit) || Number(rawLimit) < 1)) return res(400, { detail: 'Invalid limit' });
      const limit = Math.min(rawLimit === null ? 20 : Number(rawLimit), 20);
      let list = sorted(uid);
      const cursor = u.searchParams.get('cursor');
      if (cursor) {
        let c;
        try { c = JSON.parse(unb64(cursor)); } catch { return res(400, { detail: 'Invalid cursor' }); }
        if (c?.o !== uid) return res(400, { detail: 'Invalid cursor' }); // cursor của người khác
        list = list.filter((d) => d.createdAt < c.t || (d.createdAt === c.t && d.imageId < c.i));
      }
      const page = list.slice(0, limit + 1);
      const hasMore = page.length > limit;
      const items = page.slice(0, limit);
      const last = items.at(-1);
      return res(200, { items, nextCursor: hasMore && last ? b64(JSON.stringify({ o: uid, t: last.createdAt, i: last.imageId })) : null, hasMore: hasMore && Boolean(last) });
    }
    const m = /^\/images\/([^/]+)$/.exec(u.pathname);
    if (m) {
      const id = decodeURIComponent(m[1]);
      const found = Object.values(docsByUid).flat().find((d) => d.imageId === id);
      if (!found) return res(404, { detail: `Không tìm thấy ảnh với imageId='${id}'` });
      if (found.ownerId !== uid) return res(403, { detail: 'Forbidden' });
      return res(200, found);
    }
    return res(404, { detail: 'Not Found' });
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}
const scripted = (steps) => { const calls = []; const f = async (url, init) => { calls.push({ url: String(url), init }); return steps[Math.min(calls.length - 1, steps.length - 1)](init); }; f.calls = calls; return f; };
const reply = (status, body) => async () => res(status, body);
const hang = () => (init) => new Promise((_, reject) => init.signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
const tokenSource = (...queue) => { const asked = []; const fn = async ({ forceRefresh } = {}) => { asked.push(Boolean(forceRefresh)); const v = queue[Math.min(asked.length - 1, queue.length - 1)]; if (v instanceof Error) throw v; return v; }; fn.asked = asked; return fn; };

const server = await createServer({
  root, envDir: process.env.EMPTY_ENV_DIR, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const load = (p) => server.ssrLoadModule(p);
  const callsBeforeImport = globalNetCalls;
  const { createBackendClient, createUnavailableBackendApi } = await load('/src/infrastructure/api/backendClient.js');
  const { readBackendConfig } = await load('/src/infrastructure/api/backendConfig.js');
  const mapper = await load('/src/infrastructure/api/galleryMapper.js');
  const { errorFromHttp } = await load('/src/infrastructure/api/backendErrors.js');
  const { createMockBackendApi, MOCK_BACKEND_SCENARIOS: SC } = await load('/src/infrastructure/mock/mockBackendApi.js');
  const { createBackendServices } = await load('/src/app/createBackendServices.js');
  const { createListGalleryImages } = await load('/src/application/usecases/listGalleryImages.js');
  const { createGetGalleryImage } = await load('/src/application/usecases/getGalleryImage.js');
  check('import/nạp mọi module Gallery không gọi mạng', globalNetCalls === callsBeforeImport);

  const client = (fetchImpl, getIdToken = async () => 'TOKEN-A', extra = {}) => createBackendClient({ baseUrl: BASE, getIdToken, fetchImpl, ...extra });
  const kindOf = (e) => e?.details?.kind;

  // ===== 1. Tham số gửi đi (kiểm tra TRƯỚC khi gọi mạng; không có ownerId/uid) =====
  check('path/không tham số -> /images', mapper.buildListPath({}) === '/images' && mapper.buildListPath() === '/images');
  check('path/limit + cursor', mapper.buildListPath({ limit: 5, cursor: 'abc_DEF-123' }) === '/images?limit=5&cursor=abc_DEF-123');
  check('path/cursor null hoặc rỗng = trang đầu', mapper.buildListPath({ limit: 20, cursor: null }) === '/images?limit=20' && mapper.buildListPath({ cursor: '' }) === '/images');
  check('path/không bao giờ chứa ownerId/uid', !/owner|uid/i.test(mapper.buildListPath({ limit: 3, cursor: 'x' })));
  {
    const f = makeBackend({});
    const c = client(f);
    for (const [label, args] of [['limit 0', { limit: 0 }], ['limit 21', { limit: 21 }], ['limit 1.5', { limit: 1.5 }], ['limit "5"', { limit: '5' }], ['limit NaN', { limit: NaN }], ['limit -1', { limit: -1 }],
      ['cursor có khoảng trắng', { cursor: 'a b' }], ['cursor có ?', { cursor: 'a?uid=B' }], ['cursor có &', { cursor: 'a&limit=999' }], ['cursor có /', { cursor: '../x' }], ['cursor Unicode', { cursor: 'é' }],
      ['cursor quá dài', { cursor: 'a'.repeat(1025) }], ['cursor là số', { cursor: 123 }]]) {
      const r = await settle(c.listImages(args));
      check(`tham số/${label} bị chặn TRƯỚC khi gọi mạng`, r.error?.code === 'VALIDATION' && kindOf(r.error) === 'BAD_REQUEST' && f.calls.length === 0, r.error?.message);
    }
    for (const [label, id] of [['rỗng', ''], ['../x', '../x'], ['a/b', 'a/b'], ['a?b', 'a?b'], ['a#b', 'a#b'], ['%2e%2e', '%2e%2e'], ['quá dài', 'x'.repeat(129)], ['không phải chuỗi', 42], ['có khoảng trắng', 'a b']]) {
      const r = await settle(c.getImage(id));
      check(`imageId/${label} bị chặn TRƯỚC khi gọi mạng`, r.error?.code === 'VALIDATION' && f.calls.length === 0, r.error?.message);
    }
    check('imageId/hợp lệ được mã hóa trong đường dẫn', mapper.buildImagePath('drive_1AbC-xyz') === '/images/drive_1AbC-xyz');
  }

  // ===== 2. Trang đầu, trang tiếp theo, cursor, hasMore =====
  const docsA = Array.from({ length: 45 }, (_, i) => cdoc(`img-A-${String(i).padStart(3, '0')}`, 'uid-A', i));
  const docsB = Array.from({ length: 7 }, (_, i) => cdoc(`img-B-${String(i).padStart(3, '0')}`, 'uid-B', 100 + i, { fileName: `bi-mat-cua-B-${i}.png` }));
  {
    const f = makeBackend({ 'uid-A': docsA, 'uid-B': docsB });
    const c = client(f);
    const p1 = await c.listImages({ limit: 20 });
    check('trang1/20 ảnh, hasMore=true, có nextCursor', p1.items.length === 20 && p1.hasMore === true && typeof p1.nextCursor === 'string' && p1.nextCursor.length > 0);
    check('trang1/request đầu KHÔNG có cursor', !new URL(f.calls[0].url).searchParams.has('cursor') && new URL(f.calls[0].url).searchParams.get('limit') === '20');
    const p2 = await c.listImages({ limit: 20, cursor: p1.nextCursor });
    check('trang2/cursor được gửi NGUYÊN VĂN nextCursor của trang trước', new URL(f.calls[1].url).searchParams.get('cursor') === p1.nextCursor);
    check('trang2/20 ảnh, hasMore=true', p2.items.length === 20 && p2.hasMore === true);
    const p3 = await c.listImages({ limit: 20, cursor: p2.nextCursor });
    check('trang3/5 ảnh còn lại, hasMore=false, nextCursor=null', p3.items.length === 5 && p3.hasMore === false && p3.nextCursor === null);
    const ids = [...p1.items, ...p2.items, ...p3.items].map((i) => i.imageId);
    check('3 trang/không lặp, không mất, đủ 45 ảnh', new Set(ids).size === 45 && docsA.every((d) => ids.includes(d.imageId)));
    const times = [...p1.items, ...p2.items, ...p3.items].map((i) => i.createdAt.getTime());
    check('3 trang/mới nhất trước (createdAt giảm dần, thứ tự từ Backend được giữ nguyên)', times.every((t, i) => i === 0 || times[i - 1] >= t));
    check('trang/kết quả là chuỗi bất biến (frozen) và isMock=false', Object.isFrozen(p1) && Object.isFrozen(p1.items) && Object.isFrozen(p1.items[0]) && p1.isMock === false && p1.items[0].isMock === false);
    const h = f.calls[0].init;
    check('request/GET, Bearer token, Accept JSON, không body, không Content-Type', h.method === 'GET' && h.headers.Authorization === 'Bearer TOKEN-A' && h.headers.Accept === 'application/json' && h.body === undefined && !('Content-Type' in h.headers));
    check('request/không X-User-Id, credentials omit, no-store, có AbortSignal', !Object.keys(h.headers).some((k) => /x-user-id/i.test(k)) && h.credentials === 'omit' && h.cache === 'no-store' && h.signal instanceof AbortSignal);
    check('request/URL không chứa token/ownerId/uid', f.calls.every((x) => !/TOKEN|owner|uid/i.test(x.url)));
    const nolimit = await client(makeBackend({ 'uid-A': docsA })).listImages();
    check('không truyền limit/cursor -> Backend dùng mặc định 20', nolimit.items.length === 20);
  }

  // ===== 3. Gallery rỗng =====
  {
    const c = client(makeBackend({ 'uid-A': [] }));
    const r = await c.listImages({ limit: 20 });
    check('rỗng/items=[], hasMore=false, nextCursor=null', Array.isArray(r.items) && r.items.length === 0 && r.hasMore === false && r.nextCursor === null);
    const none = await client(makeBackend({ 'uid-A': docsA }), async () => 'TOKEN-B').listImages();
    check('rỗng/user chưa có ảnh nào (B không có ảnh trong kho A) -> trang rỗng, không phải lỗi', none.items.length === 0 && none.hasMore === false);
  }

  // ===== 4. Ánh xạ schema Backend -> model Gallery =====
  {
    const iso = '2026-03-01T10:00:00.123456+00:00';
    const doc = cdoc('img-map-0001', 'uid-A', 0, { createdAt: iso, updatedAt: '2026-03-01T17:00:01.999999+07:00' });
    const m = (await client(scripted([reply(200, { items: [doc], nextCursor: null, hasMore: false })])).listImages({ limit: 5 })).items[0];
    const keys = Object.keys(m).sort().join();
    const expectedKeys = ['createdAt', 'createdAtEstimated', 'errorReason', 'height', 'imageId', 'isMock', 'name', 'originalSize', 'ownerId', 'previewUrl', 'processedSize', 'processingMs', 'provider', 'retryCount', 'savedPercent', 'status', 'updatedAt', 'variants', 'width'];
    check('ánh xạ DONE/chỉ giữ field UI cần (không có assetIds, publicIds, storagePath, driveFileId, pipelineFolders...)', keys === expectedKeys.sort().join(), keys);
    check('ánh xạ DONE/field cơ bản', m.imageId === 'img-map-0001' && m.status === 'DONE' && m.ownerId === 'uid-A' && m.provider === 'cloudinary' && m.name === 'img-map-0001.png');
    check('ánh xạ DONE/kích thước: original.size -> originalSize, width, height, processedSize, processingMs, savedPercent', m.originalSize === 2457600 && m.width === 4000 && m.height === 3000 && m.processedSize === 412000 && m.processingMs === 1840 && m.savedPercent === 83.2);
    check('ánh xạ DONE/3 URL https biến thể + previewUrl', m.variants.thumbnail === urlOf('img-map-0001', 't') && m.variants.medium === urlOf('img-map-0001', 'm') && m.variants.webp === urlOf('img-map-0001', 'w') && m.previewUrl === m.variants.thumbnail);
    check('ánh xạ thời gian/ISO +00:00 micro giây -> Date UTC (cắt về mili giây)', m.createdAt instanceof Date && m.createdAt.toISOString() === '2026-03-01T10:00:00.123Z');
    check('ánh xạ thời gian/offset +07:00 -> UTC đúng', m.updatedAt.toISOString() === '2026-03-01T10:00:01.999Z');
    check('ánh xạ/model không chứa chuỗi nội bộ (JSON hóa không lộ assetIds/publicIds)', !/assetIds|publicIds|x\/img-map/.test(JSON.stringify(m)));
    const mk = async (over) => (await client(scripted([reply(200, { items: [{ ...doc, ...over }], nextCursor: null, hasMore: false })])).listImages({ limit: 5 })).items[0];
    check('thời gian/thiếu múi giờ -> null (không đoán giờ địa phương)', (await mk({ createdAt: '2026-03-01T10:00:00' })).createdAt === null);
    check('thời gian/sai định dạng, số, null -> null', (await mk({ createdAt: 'hôm qua' })).createdAt === null && (await mk({ createdAt: 12345 })).createdAt === null && (await mk({ createdAt: null })).createdAt === null);
    check('thời gian/ngày không tồn tại -> null (không bị "cuộn" sang tháng sau)', (await mk({ createdAt: '2026-02-30T00:00:00Z' })).createdAt === null && (await mk({ createdAt: '2026-02-29T00:00:00Z' })).createdAt === null && (await mk({ createdAt: '2026-04-31T00:00:00Z' })).createdAt === null);
    check('thời gian/tháng 13, giờ 24, phút 60, giây 60, offset +24:00 -> null', (await Promise.all(['2026-13-01T00:00:00Z', '2026-01-01T24:00:00Z', '2026-01-01T00:60:00Z', '2026-01-01T00:00:60Z', '2026-01-01T00:00:00+24:00', '2026-01-01T00:00:00+05:60'].map((v) => mk({ createdAt: v })))).every((x) => x.createdAt === null));
    check('thời gian/năm nhuận 2028-02-29 hợp lệ', (await mk({ createdAt: '2028-02-29T23:59:59Z' })).createdAt?.toISOString() === '2028-02-29T23:59:59.000Z');
    check('URL/http, javascript:, data: bị loại (null), chỉ https được giữ', (await mk({ variants: { thumbnail: 'http://res.cloudinary.com/x.webp', medium: 'javascript:alert(1)', webp: 'data:image/png;base64,AAAA' }, previewUrl: 'http://x/y.webp' })).variants.thumbnail === null);
    const bad = await mk({ variants: { thumbnail: 'http://a/b', medium: 'javascript:alert(1)', webp: 'data:image/png;base64,AAAA' }, previewUrl: 'ftp://x' });
    check('URL/mọi biến thể không phải https -> null và previewUrl null', bad.variants.medium === null && bad.variants.webp === null && bad.previewUrl === null);
    check('URL/có user:pass@ bị loại', (await mk({ variants: { thumbnail: 'https://u:p@res.cloudinary.com/x.webp', medium: null, webp: null }, previewUrl: null })).variants.thumbnail === null);
    check('field tùy chọn sai kiểu -> null, không ném lỗi', (await mk({ original: 'x', processedSize: '412000', processingMs: -5, savedPercent: NaN, retryCount: 1.5, errorReason: 7 })).originalSize === null);
    check('tên/thiếu fileName -> dùng imageId', (await mk({ fileName: undefined })).name === 'img-map-0001');
    check('tên/chuỗi quá dài bị cắt 255', (await mk({ fileName: 'x'.repeat(1000) })).name.length === 255);
    for (const status of ['PENDING', 'PROCESSING', 'FAILED']) {
      const r = await mk({ status, variants: null, previewUrl: null, errorReason: status === 'FAILED' ? 'TIMEOUT' : null });
      check(`ánh xạ ${status}/variants null -> 3 khóa null, không lỗi`, r.status === status && r.variants.thumbnail === null && r.variants.medium === null && r.variants.webp === null && r.previewUrl === null);
      if (status === 'FAILED') check('ánh xạ FAILED/giữ errorReason', r.errorReason === 'TIMEOUT');
    }
    const dr = (await client(scripted([reply(200, { items: [ddoc('FILE1', 'uid-A', 3, { createdAtEstimated: true })], nextCursor: null, hasMore: false })])).listImages({ limit: 5 })).items[0];
    check('ánh xạ Drive/originalName, sizeBytes, provider', dr.name === 'FILE1.jpg' && dr.originalSize === 1234 && dr.provider === 'google_drive' && dr.imageId === 'drive_FILE1');
    check('ánh xạ Drive/đường dẫn tương đối "/images/preview/..." -> null (không dùng được trong <img>), không lộ driveFileId', dr.previewUrl === null && dr.variants.thumbnail === null && !/FILE1/.test(JSON.stringify({ ...dr, name: '', imageId: '' })));
    check('ánh xạ Drive/createdAtEstimated được giữ', dr.createdAtEstimated === true && dr.createdAt instanceof Date);
    check('ánh xạ/provider lạ -> null', (await mk({ provider: 'ftp' })).provider === null);
  }

  // ===== 5. GET /images/{id} =====
  {
    const f = makeBackend({ 'uid-A': docsA, 'uid-B': docsB });
    const c = client(f);
    const one = await c.getImage('img-A-007');
    check('chi tiết/đúng ảnh, GET /images/img-A-007', one.imageId === 'img-A-007' && one.status === 'DONE' && new URL(f.calls[0].url).pathname === '/images/img-A-007' && f.calls[0].init.method === 'GET');
    const d = await client(makeBackend({ 'uid-A': [ddoc('ZZ', 'uid-A', 1)] })).getImage('drive_ZZ');
    check('chi tiết/ảnh Drive id có dấu gạch dưới', d.imageId === 'drive_ZZ' && d.provider === 'google_drive');
    const r403 = await settle(c.getImage('img-B-000'));
    check('chi tiết/ảnh của B với token A -> 403 FORBIDDEN', r403.error?.code === 'FORBIDDEN' && kindOf(r403.error) === 'FORBIDDEN' && r403.error.details.httpStatus === 403);
    check('chi tiết/lỗi 403 KHÔNG lộ metadata của B (tên file, ownerId, URL)', !/bi-mat|uid-B|cloudinary/.test(r403.error.message + JSON.stringify(r403.error.details)));
    const r404 = await settle(c.getImage('khong-ton-tai'));
    check('chi tiết/không có -> 404 NOT_FOUND', r404.error?.code === 'NOT_FOUND' && kindOf(r404.error) === 'NOT_FOUND');
  }

  // ===== 6. User A không thấy metadata của User B =====
  {
    const f = makeBackend({ 'uid-A': docsA, 'uid-B': docsB });
    const asB = client(f, async () => 'TOKEN-B');
    const asA = client(f);
    const allA = []; let cur;
    do { const p = await asA.listImages({ limit: 20, cursor: cur }); allA.push(...p.items); cur = p.nextCursor ?? undefined; } while (cur);
    check('cô lập/A duyệt hết gallery: chỉ ảnh của A, không có ảnh/tên file của B', allA.length === 45 && allA.every((i) => i.ownerId === 'uid-A') && !JSON.stringify(allA).includes('bi-mat-cua-B'));
    const pb = await asB.listImages({ limit: 20 });
    check('cô lập/B chỉ thấy 7 ảnh của B', pb.items.length === 7 && pb.items.every((i) => i.ownerId === 'uid-B'));
    const pa1 = await asA.listImages({ limit: 20 });
    const rb = await settle(asB.listImages({ limit: 20, cursor: pa1.nextCursor }));
    check('cô lập/cursor của A đưa cho B -> 400 Invalid cursor (VALIDATION), không có dữ liệu', rb.error?.code === 'VALIDATION' && rb.error.details.detail === 'Invalid cursor' && rb.error.details.retryable !== true);
    check('cô lập/Frontend không gửi uid: mọi request của A mang Bearer TOKEN-A, của B mang TOKEN-B, không tham số định danh', f.calls.every((x) => !/uid|owner/i.test(x.url)));
    // Backend độc hại/lỗi trả ảnh của B cho A: use case có expectedOwnerId phải từ chối cả response.
    const evil = scripted([reply(200, { items: [docsA[0], docsB[0]], nextCursor: null, hasMore: false })]);
    const list = createListGalleryImages({ backendApi: client(evil) });
    const re = await settle(list({ limit: 20, expectedOwnerId: 'uid-A' }));
    check('phòng thủ/response lẫn ảnh của B -> bị từ chối toàn bộ (INVALID_RESPONSE), không trả một phần', re.error && kindOf(re.error) === 'INVALID_RESPONSE' && !re.value);
    const evil2 = scripted([reply(200, docsB[0])]);
    const rg = await settle(createGetGalleryImage({ backendApi: client(evil2) })({ imageId: docsB[0].imageId, expectedOwnerId: 'uid-A' }));
    check('phòng thủ/chi tiết trả ảnh của B cho A -> bị từ chối', rg.error && kindOf(rg.error) === 'INVALID_RESPONSE');
    const okOwn = await createListGalleryImages({ backendApi: client(makeBackend({ 'uid-A': docsA })) })({ limit: 20, expectedOwnerId: 'uid-A' });
    check('phòng thủ/ảnh đúng chủ -> qua', okOwn.items.length === 20);
    const noId = await settle(createListGalleryImages({ backendApi: client(makeBackend({ 'uid-A': docsA })) })({ limit: 20, expectedOwnerId: '' }));
    check('phòng thủ/expectedOwnerId rỗng -> UNAUTHENTICATED, không gọi gì ngoài kiểm tra', noId.error?.code === 'UNAUTHENTICATED');
  }

  // ===== 7. Token thiếu / sai / hết hạn; refresh tối đa một lần =====
  {
    const f1 = scripted([reply(200, { items: [], nextCursor: null, hasMore: false })]);
    for (const [label, src] of [['chuỗi rỗng', async () => ''], ['null', async () => null], ['ném lỗi (chưa đăng nhập)', async () => { throw Object.assign(new Error('chưa đăng nhập'), { code: 'UNAUTHENTICATED' }); }]]) {
      const r = await settle(client(f1, src).listImages({ limit: 5 }));
      check(`token thiếu/${label} -> TOKEN_UNAVAILABLE, không gọi mạng`, r.error?.code === 'UNAUTHENTICATED' && kindOf(r.error) === 'TOKEN_UNAVAILABLE' && f1.calls.length === 0);
    }
    const wrong = makeBackend({ 'uid-A': docsA });
    const src1 = tokenSource('TOKEN-SAI');
    const rw = await settle(client(wrong, src1).listImages({ limit: 5 }));
    check('token sai/401 -> UNAUTHENTICATED', rw.error?.code === 'UNAUTHENTICATED' && kindOf(rw.error) === 'UNAUTHENTICATED' && rw.error.details.httpStatus === 401);
    check('token sai/làm mới đúng MỘT lần, token mới trùng token cũ => KHÔNG gửi lại (chỉ 1 request)', wrong.calls.length === 1 && src1.asked.join() === 'false,true');
    const exp = makeBackend({ 'uid-A': docsA });
    const src2 = tokenSource('TOKEN-HET-HAN', 'TOKEN-A');
    const rr = await settle(client(exp, src2).listImages({ limit: 5 }));
    check('token hết hạn/401 -> làm mới -> gửi lại đúng 1 lần với token mới -> thành công', rr.value?.items.length === 5 && exp.calls.length === 2 && exp.calls[0].init.headers.Authorization === 'Bearer TOKEN-HET-HAN' && exp.calls[1].init.headers.Authorization === 'Bearer TOKEN-A' && src2.asked.join() === 'false,true');
    const exp2 = makeBackend({ 'uid-A': docsA });
    const src3 = tokenSource('TOKEN-HET-HAN', 'TOKEN-A');
    const rd = await settle(client(exp2, src3).getImage('img-A-001'));
    check('token hết hạn/chi tiết cũng làm mới 1 lần rồi thành công', rd.value?.imageId === 'img-A-001' && exp2.calls.length === 2);
    const still = makeBackend({ 'uid-A': docsA });
    const src4 = tokenSource('X1', 'X2', 'X3', 'X4');
    const rs = await settle(client(still, src4).listImages({ limit: 5 }));
    check('401 liên tục/tối đa 2 request (1 gốc + 1 sau làm mới), không vòng lặp', rs.error?.code === 'UNAUTHENTICATED' && still.calls.length === 2 && src4.asked.length === 2);
    const bad = makeBackend({ 'uid-A': docsA });
    const src5 = tokenSource('TOKEN-SAI', new Error('mất mạng khi làm mới'));
    const rx = await settle(client(bad, src5).listImages({ limit: 5 }));
    check('làm mới thất bại -> giữ nguyên lỗi 401, không gửi lại', rx.error?.code === 'UNAUTHENTICATED' && bad.calls.length === 1);
    const dump = JSON.stringify([rw.error?.message, rw.error?.details, rs.error?.message, rs.error?.details, rx.error?.message, rx.error?.details, bad.calls.map((c) => c.url)]);
    check('token KHÔNG nằm trong lỗi, details hay URL', !/TOKEN-/.test(dump.replace(/Bearer/g, '')) );
  }

  // ===== 8. Lỗi 400 / 403 / 404 / 503 / mạng / timeout / hủy =====
  {
    const L = (status, body) => client(scripted([reply(status, body)])).listImages({ limit: 5 });
    const g = (status, body) => client(scripted([reply(status, body)])).getImage('img-0001-abc');
    let e = (await settle(L(400, { detail: 'Invalid cursor' }))).error;
    check('lỗi 400/VALIDATION + BAD_REQUEST, giữ detail "Invalid cursor", không retry được', e?.code === 'VALIDATION' && kindOf(e) === 'BAD_REQUEST' && e.details.detail === 'Invalid cursor' && e.details.httpStatus === 400 && e.details.retryable !== true);
    check('lỗi 400/thông báo dành cho thư viện, không nhắc "xác nhận"', /yêu cầu tải ảnh/.test(e.message) && !/xác nhận/.test(e.message));
    e = (await settle(L(400, { detail: 'Invalid limit' }))).error;
    check('lỗi 400/Invalid limit', e?.details.detail === 'Invalid limit');
    e = (await settle(L(403, { detail: 'Forbidden' }))).error;
    check('lỗi 403/FORBIDDEN', e?.code === 'FORBIDDEN' && kindOf(e) === 'FORBIDDEN' && e.details.detail === 'Forbidden');
    e = (await settle(g(404, { detail: 'Image not found' }))).error;
    check('lỗi 404/NOT_FOUND', e?.code === 'NOT_FOUND' && kindOf(e) === 'NOT_FOUND');
    e = (await settle(L(503, { detail: 'Storage unavailable' }))).error;
    check('lỗi 503/SERVER_ERROR, retryable, giữ detail, KHÔNG thành trang rỗng', kindOf(e) === 'SERVER_ERROR' && e.details.retryable === true && e.details.httpStatus === 503 && e.details.detail === 'Storage unavailable');
    e = (await settle(L(503, { detail: 'Authentication service unavailable' }))).error;
    check('lỗi 503 do dịch vụ xác thực cũng là SERVER_ERROR retryable', kindOf(e) === 'SERVER_ERROR' && e.details.retryable === true);
    e = (await settle(L(500, '<html>Internal Server Error</html>'))).error;
    check('lỗi 500 thân HTML/không phải JSON -> vẫn là lỗi có cấu trúc, detail null', kindOf(e) === 'SERVER_ERROR' && e.details.detail === null);
    e = (await settle(L(429, { detail: 'Too many requests' }))).error;
    check('lỗi 429/QUOTA_EXCEEDED retryable', e?.code === 'QUOTA_EXCEEDED' && e.details.retryable === true);
    e = (await settle(L(422, { detail: [{ loc: ['query', 'limit'], msg: 'bad', type: 'x' }] }))).error;
    check('lỗi 422 (mảng detail của FastAPI) được rút gọn', e?.code === 'VALIDATION' && kindOf(e) === 'UNPROCESSABLE' && /limit: bad/.test(e.details.detail));
    for (const status of [400, 401, 403, 404, 503]) {
      const ee = (await settle(L(status, { detail: 'x'.repeat(1000) }))).error;
      check(`lỗi ${status}/detail bị cắt <= 300 ký tự`, (ee.details.detail ?? '').length <= 300);
    }
    const net = await settle(client(scripted([async () => { throw new TypeError('Failed to fetch'); }])).listImages({ limit: 5 }));
    check('lỗi mạng/NETWORK retryable, không lộ lỗi gốc trong thông báo', net.error?.code === 'NETWORK' && kindOf(net.error) === 'NETWORK' && net.error.details.retryable === true);
    const net2 = await settle(client(scripted([async () => { throw new TypeError('Failed to fetch'); }])).getImage('img-0001-abc'));
    check('lỗi mạng/chi tiết cũng NETWORK', net2.error?.code === 'NETWORK');
    const to = await settle(client(scripted([hang()]), async () => 'TOKEN-A', { timeoutMs: 30 }).listImages({ limit: 5 }));
    check('timeout/NETWORK + TIMEOUT retryable', to.error?.code === 'NETWORK' && kindOf(to.error) === 'TIMEOUT' && to.error.details.retryable === true);
    const ac = new AbortController();
    const fAbort = scripted([hang()]);
    const pending = settle(client(fAbort).listImages({ limit: 5 }, { signal: ac.signal }));
    setTimeout(() => ac.abort(), 20);
    const ab = await pending;
    check('hủy bằng AbortSignal -> CANCELLED', ab.error?.code === 'CANCELLED' && kindOf(ab.error) === 'CANCELLED');
    const pre = new AbortController(); pre.abort();
    const fPre = scripted([reply(200, {})]);
    const rp = await settle(client(fPre).listImages({ limit: 5 }, { signal: pre.signal }));
    check('đã hủy từ trước -> CANCELLED, không gọi mạng, không hỏi token', rp.error?.code === 'CANCELLED' && fPre.calls.length === 0);
  }

  // ===== 9. JSON Backend sai cấu trúc (fail-closed: INVALID_RESPONSE, không hiển thị một phần) =====
  {
    const good = cdoc('img-ok-00001', 'uid-A', 1);
    const page = (over) => ({ items: [good], nextCursor: null, hasMore: false, ...over });
    const cases = [
      ['không phải JSON', '<html>oops</html>'], ['JSON null', 'null'], ['gốc là mảng', [good]], ['gốc là số', '42'],
      ['thiếu items', { nextCursor: null, hasMore: false }], ['items là chuỗi', page({ items: 'x' })], ['items là đối tượng', page({ items: {} })],
      ['thiếu nextCursor', { items: [], hasMore: false }], ['nextCursor là số', page({ nextCursor: 5, hasMore: true })], ['nextCursor có ký tự lạ', page({ nextCursor: 'a b&c', hasMore: true })], ['nextCursor quá dài', page({ nextCursor: 'a'.repeat(1025), hasMore: true })],
      ['hasMore là chuỗi', page({ hasMore: 'false' })], ['thiếu hasMore', { items: [good], nextCursor: null }], ['hasMore=true nhưng nextCursor=null', page({ hasMore: true })], ['hasMore=false nhưng có nextCursor', page({ nextCursor: 'abc', hasMore: false })],
      ['vượt limit đã yêu cầu', page({ items: [good, cdoc('img-ok-00002', 'uid-A', 2), cdoc('img-ok-00003', 'uid-A', 3)] })],
      ['imageId trùng trong trang', page({ items: [good, good] })], ['phần tử thiếu imageId', page({ items: [{ ...good, imageId: undefined }] })], ['imageId chứa "/"', page({ items: [{ ...good, imageId: 'a/b' }] })],
      ['imageId không phải chuỗi', page({ items: [{ ...good, imageId: 7 }] })], ['status COMPLETED (sai CONTRACT)', page({ items: [{ ...good, status: 'COMPLETED' }] })], ['status thường (done)', page({ items: [{ ...good, status: 'done' }] })], ['thiếu status', page({ items: [{ ...good, status: undefined }] })],
      ['phần tử là null', page({ items: [null] })], ['phần tử là chuỗi', page({ items: ['x'] })], ['phần tử là mảng', page({ items: [[good]] })],
      ['1 phần tử xấu trong trang tốt', page({ items: [good, { imageId: 'img-bad-0001' }], nextCursor: null })],
    ];
    for (const [label, body] of cases) {
      const r = await settle(client(scripted([reply(200, body)])).listImages({ limit: 2 }));
      check(`JSON sai/danh sách: ${label} -> UNKNOWN/INVALID_RESPONSE, không trả dữ liệu`, r.error?.code === 'UNKNOWN' && kindOf(r.error) === 'INVALID_RESPONSE' && r.error.details.retryable === false && r.value === undefined, r.error ? `${r.error.code}/${kindOf(r.error)}` : 'đã trả kết quả');
    }
    const dcases = [['không phải JSON', 'x'], ['mảng', [good]], ['imageId khác id đã yêu cầu', { ...good, imageId: 'img-khac-0001' }], ['thiếu imageId', { ...good, imageId: undefined }], ['status lạ', { ...good, status: 'COMPLETED' }], ['null', 'null']];
    for (const [label, body] of dcases) {
      const r = await settle(client(scripted([reply(200, body)])).getImage('img-ok-00001'));
      check(`JSON sai/chi tiết: ${label} -> INVALID_RESPONSE`, kindOf(r.error) === 'INVALID_RESPONSE' && r.value === undefined);
    }
    const r204 = await settle(client(scripted([reply(204, '')])).listImages({ limit: 5 }));
    check('2xx không có thân (204) -> INVALID_RESPONSE', kindOf(r204.error) === 'INVALID_RESPONSE');
    const okTrim = await client(scripted([reply(200, page({ items: [good] }))])).listImages({ limit: 1 });
    check('đối chứng/trang đúng cấu trúc qua được', okTrim.items.length === 1);
  }

  // ===== 10. Use case + composition root =====
  {
    const f = makeBackend({ 'uid-A': docsA });
    const svc = createBackendServices({ config: { mode: 'real', baseUrl: BASE, configError: null }, getIdToken: async () => 'TOKEN-A', fetchImpl: f });
    check('services/real: không gọi mạng khi khởi tạo', f.calls.length === 0 && svc.mode === 'real');
    check('services/có useCases.listGalleryImages, getGalleryImage và confirmCloudinaryUpload', typeof svc.useCases.listGalleryImages === 'function' && typeof svc.useCases.getGalleryImage === 'function' && typeof svc.useCases.confirmCloudinaryUpload === 'function');
    await svc.useCases.listGalleryImages({ limit: 999 });
    await svc.useCases.listGalleryImages({ limit: 0 });
    await svc.useCases.listGalleryImages({});
    await svc.useCases.listGalleryImages({ limit: 7.9, cursor: null });
    const lim = f.calls.map((c) => new URL(c.url).searchParams.get('limit'));
    check('use case/ép limit về 1..20 (999->20, 0->1, mặc định 20, 7.9->7)', lim.join() === '20,1,20,7', lim.join());
    const rr = await settle(svc.useCases.getGalleryImage({}));
    check('use case/thiếu imageId -> VALIDATION, không gọi mạng thêm', rr.error?.code === 'VALIDATION' && f.calls.length === 4);
    const ok = await svc.useCases.getGalleryImage({ imageId: 'img-A-003', expectedOwnerId: 'uid-A' });
    check('use case/chi tiết đúng chủ', ok.imageId === 'img-A-003');
    const svcBad = createBackendServices({ config: readBackendConfig({ VITE_BACKEND_MODE: 'real' }), fetchImpl: f });
    const rb = await settle(svcBad.useCases.listGalleryImages({ limit: 5 }));
    check('services/invalid: lỗi CONFIG, KHÔNG gọi mạng, KHÔNG tự chuyển sang MOCK', svcBad.mode === 'invalid' && rb.error?.code === 'CONFIG' && f.calls.length === 5 && !rb.value, String(f.calls.length));
    const rg = await settle(svcBad.useCases.getGalleryImage({ imageId: 'abc12345' }));
    check('services/invalid: chi tiết cũng CONFIG', rg.error?.code === 'CONFIG');
    const un = createUnavailableBackendApi({ message: 'cấu hình sai', missing: ['X'] });
    check('unavailable API có listImages/getImage báo CONFIG', (await settle(un.listImages())).error?.code === 'CONFIG' && (await settle(un.getImage('abc12345'))).error?.code === 'CONFIG');
    check('services/real thiếu getIdToken vẫn ném khi khởi tạo (hành vi H3A giữ nguyên)', (await settle(Promise.resolve().then(() => createBackendServices({ config: { mode: 'real', baseUrl: BASE, configError: null } })))).error instanceof TypeError);
    // confirm dùng chung client: một request confirm vẫn đi đúng đường và dùng Bearer.
    const fc = scripted([reply(200, { imageId: 'fixture-image-id-0001', status: 'DONE', ownerId: 'uid-A', variants: { thumbnail: 'https://res.cloudinary.com/c/a/t.webp', medium: 'https://res.cloudinary.com/c/a/m.webp', webp: 'https://res.cloudinary.com/c/a/w.webp' }, processingMs: 1, savedPercent: null })]);
    const conf = await settle(client(fc).confirmCloudinaryUpload({ imageId: 'fixture-image-id-0001', thumbnail: 'https://res.cloudinary.com/c/a/t.webp', medium: 'https://res.cloudinary.com/c/a/m.webp', webp: 'https://res.cloudinary.com/c/a/w.webp', originalSize: 10, processingMs: 1 }));
    check('confirm/không bị ảnh hưởng: POST /images/cloudinary/confirm vẫn hoạt động trên cùng client', conf.value?.status === 'DONE' && fc.calls[0].init.method === 'POST' && new URL(fc.calls[0].url).pathname === '/images/cloudinary/confirm');
    check('confirm/thông báo 400 mặc định vẫn là "dữ liệu xác nhận"', /dữ liệu xác nhận/.test(errorFromHttp(400, 'x').message) && /dữ liệu yêu cầu tải ảnh/.test(errorFromHttp(400, 'x', { subject: 'yêu cầu tải ảnh' }).message));
  }

  // ===== 11. Mock backend (mặc định của ứng dụng) =====
  {
    const mine = Array.from({ length: 25 }, (_, i) => cdoc(`img-M-${String(i).padStart(3, '0')}`, 'mock-owner-uid', i));
    const others = [cdoc('img-X-0001', 'mock-uid-999', 999, { fileName: 'cua-nguoi-khac.png' })];
    const m0 = createMockBackendApi({ latencyMs: 0 });
    const e0 = await m0.listImages({ limit: 5 });
    check('mock/mặc định rỗng, isMock=true', e0.items.length === 0 && e0.isMock === true && e0.hasMore === false && e0.nextCursor === null);
    const m = createMockBackendApi({ latencyMs: 0, galleryItems: [...mine, ...others] });
    const a = await m.listImages({ limit: 20 });
    const b = await m.listImages({ limit: 20, cursor: a.nextCursor });
    check('mock/phân trang 20 + 5, hasMore/nextCursor đúng, isMock=true', a.items.length === 20 && a.hasMore && b.items.length === 5 && !b.hasMore && b.nextCursor === null && a.isMock && a.items.every((i) => i.isMock));
    check('mock/không bao giờ trả ảnh của chủ khác', ![...a.items, ...b.items].some((i) => i.imageId === 'img-X-0001'));
    check('mock/cursor lạ -> 400 Invalid cursor', (await settle(m.listImages({ cursor: 'khong-phai-cursor-mock' }))).error?.details.detail === 'Invalid cursor');
    check('mock/tham số sai bị chặn như adapter thật', (await settle(m.listImages({ limit: 99 }))).error?.code === 'VALIDATION');
    check('mock/chi tiết ảnh của mình', (await m.getImage('img-M-001')).imageId === 'img-M-001');
    check('mock/chi tiết ảnh của người khác -> 403 Forbidden, không lộ tên file', (await settle(m.getImage('img-X-0001'))).error?.code === 'FORBIDDEN' && !JSON.stringify((await settle(m.getImage('img-X-0001'))).error.details).includes('cua-nguoi-khac'));
    check('mock/chi tiết không có -> 404', (await settle(m.getImage('khong-co-0001'))).error?.code === 'NOT_FOUND');
    for (const [name, code] of [[SC.UNAUTHENTICATED, 'UNAUTHENTICATED'], [SC.FORBIDDEN, 'FORBIDDEN'], [SC.NOT_FOUND, 'NOT_FOUND'], [SC.RATE_LIMITED, 'QUOTA_EXCEEDED'], [SC.SERVER_ERROR, 'UNKNOWN'], [SC.NETWORK, 'NETWORK'], [SC.TIMEOUT, 'NETWORK']]) {
      const r = await settle(createMockBackendApi({ latencyMs: 0, galleryItems: mine, getScenario: () => name }).listImages({ limit: 5 }));
      check(`mock/kịch bản ${name} -> ${code}`, r.error?.code === code);
    }
    const inv = await settle(createMockBackendApi({ latencyMs: 0, galleryItems: mine, getScenario: () => SC.INVALID_RESPONSE }).listImages({ limit: 5 }));
    check('mock/kịch bản invalid-response -> INVALID_RESPONSE (cùng bộ ánh xạ với adapter thật)', kindOf(inv.error) === 'INVALID_RESPONSE');
    const msvc = createBackendServices({ mockOptions: { latencyMs: 0, galleryItems: mine } });
    const mp = await msvc.useCases.listGalleryImages({ limit: 20, expectedOwnerId: 'mock-owner-uid' });
    check('services/mock (mặc định không cấu hình): chạy được, isMock=true, không gọi mạng', msvc.mode === 'mock' && msvc.isMock === true && mp.items.length === 20 && mp.isMock === true);
    check('services/mock: cấu hình rỗng vẫn là MOCK (không tự chuyển REAL)', readBackendConfig({}).mode === 'mock' && readBackendConfig({ VITE_API_BASE_URL: 'https://x.test' }).mode === 'mock' && readBackendConfig({ VITE_BACKEND_MODE: '' , VITE_API_BASE_URL: 'https://x.test' }).mode === 'mock');
  }

  // ===== 12. Mã nguồn: bảo vệ chế độ MOCK, không đụng UI/upload, không lộ token =====
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
  const gfiles = ['src/infrastructure/api/galleryMapper.js', 'src/application/usecases/listGalleryImages.js', 'src/application/usecases/getGalleryImage.js'];
  for (const f of gfiles) {
    const code = strip(read(f)); const n = path.basename(f);
    check(`mã nguồn ${n}/không console.*, storage, cookie`, !/console\.|localStorage|sessionStorage|document\.cookie/.test(code));
    check(`mã nguồn ${n}/không X-User-Id, không Firebase/Firestore, không Cloudinary uploader, không fetch trực tiếp`, !/x-user-id/i.test(code) && !/from ['"][^'"]*(firebase|firestore)/i.test(code) && !/cloudinaryUploader|XMLHttpRequest|api\.cloudinary\.com|\bfetch\(/.test(code));
  }
  const clientCode = strip(read('src/infrastructure/api/backendClient.js'));
  check('mã nguồn backendClient/vẫn MỘT hệ thống fetch (một doFetch duy nhất, không fetch thứ hai)', (clientCode.match(/\bdoFetch\(/g) || []).length === 1 && !/globalThis\.fetch\(|\bfetch\(/.test(clientCode.replace(/globalThis\.fetch\(\.\.\.args\)/, '')));
  check('mã nguồn galleryMapper/query chỉ có đúng 2 tham số: limit và cursor (không ownerId/uid)', (strip(read('src/infrastructure/api/galleryMapper.js')).match(/query\.set\('[a-zA-Z]+'/g) || []).join() === "query.set('limit',query.set('cursor'");
  const galleryPage = read('src/presentation/pages/GalleryPage.jsx');
  const hook = read('src/presentation/hooks/useImageList.js');
  check('GalleryPage vẫn dùng MOCK: hook useImageList + mockImageService, không import Backend/Firebase', /useImageList/.test(galleryPage) && /mockImageService/.test(hook) && !/from ['"][^'"]*(backendClient|createBackendServices|galleryMapper|listGalleryImages|getGalleryImage|firebase|firestore)/i.test(strip(galleryPage) + strip(hook)));
  check('main.jsx không dùng createBackendServices (Gallery REAL chưa bật)', !/createBackendServices|listGalleryImages|backendClient/.test(strip(read('src/main.jsx'))));
  const upload = read('src/presentation/pages/UploadPage.jsx') + read('src/presentation/hooks/useUploadFlow.js');
  check('UploadPage/useUploadFlow không import Gallery client', !/galleryMapper|listGalleryImages|getGalleryImage|backendClient/.test(upload));
  check('mạng thật/0 lần gọi fetch/XHR toàn cục trong toàn bộ test', globalNetCalls === callsBeforeImport, String(globalNetCalls));
  check('console không bị ghi token hay header Authorization', logged.every((l) => !/TOKEN-|Bearer/.test(l)), logged.join(' | ').slice(0, 120));
} finally {
  await server.close();
}

out(`PASSED: ${passed}`);
out(`FAILED: ${failures.length}`);
failures.forEach((f) => out('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
