// Smoke test INT-3C.1 — F1: thiếu GalleryServicesContext.Provider KHÔNG được âm thầm hiển thị MOCK khi cấu hình yêu cầu REAL.
// Mỗi kịch bản dùng một Vite SSR server với .env TẠM (thư mục ngoài repo) để VITE_GALLERY_MODE do Vite nạp thật như khi chạy ứng dụng.
// Mạng toàn cục bị CHẶN và đếm; không gọi Backend/Firebase/Cloudinary thật.
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/int3c1-provider-smoke.mjs .  (xem tests/README.md)
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => (ok ? (passed += 1) : failures.push(`${name}${detail ? ` — ${detail}` : ''}`));
const out = (s) => process.stdout.write(s + '\n');
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

let globalNetCalls = 0;
globalThis.fetch = async () => { globalNetCalls += 1; throw new Error('INT-3C.1 smoke: bị chặn gọi mạng thật'); };
globalThis.XMLHttpRequest = class { constructor() { globalNetCalls += 1; throw new Error('INT-3C.1 smoke: bị chặn XHR'); } };

const nativeImport = (spec) => import(pathToFileURL(path.join(root, 'node_modules', spec)).href);
const reactMod = await nativeImport('react/index.js'); const React = reactMod.default ?? reactMod;
const domServer = await nativeImport('react-dom/server.node.js'); const renderToString = (domServer.default ?? domServer).renderToString ?? domServer.renderToString;
const Router = await nativeImport('react-router/dist/production/index.js');
const h = React.createElement;
const strip = (html) => html.replace(/<!--.*?-->/g, '');

/** Chạy `fn(server)` với Vite nạp .env tạm có đúng một dòng `envLine` (rỗng = không biến nào). */
async function withEnv(envLine, fn) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'int3c1-env-'));
  fs.writeFileSync(path.join(dir, '.env'), envLine ? `${envLine}\n` : '', 'utf8');
  const server = await createServer({
    root, envDir: dir, appType: 'custom', logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
  });
  try {
    await fn(server);
  } finally {
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const baseAuth = { user: null, initializing: false, isMock: false, mode: 'firebase', configError: null, authError: null, login: async () => {}, logout: async () => {}, getIdToken: async () => 'x' };
const realUser = { uid: 'uid-A', displayName: 'A', email: 'a@x.test' };
const mockUser = { uid: 'mock-uid-001', displayName: 'M', email: 'm@x.test' };
const MOCK_AUTH = { user: mockUser, isMock: true, mode: 'mock' };
const FIREBASE_AUTH = { user: realUser };

const WARN = 'thiếu GalleryServicesContext.Provider';
const isMockPage = (html) => html.includes('Thử trạng thái MOCK') && html.includes('class="mock-badge"');
const isConfigError = (html) => html.includes('Cấu hình Gallery REAL không hợp lệ') && html.includes('role="alert"');
const noMockLeak = (html) => !html.includes('Thử trạng thái MOCK') && !html.includes('mock-badge') && !html.includes('image-card') && !html.includes('Chưa có ảnh nào') && !html.includes('Đang tải danh sách ảnh') && !html.includes('real-badge');

try {
  const netBefore = globalNetCalls;

  // ============ 1. Hàm thuần dùng chung (application/galleryMode.js) ============
  await withEnv('', async (s) => {
    const L = (p) => s.ssrLoadModule(p);
    const gm = await L('/src/application/galleryMode.js');
    const { resolveGalleryConfig, createGalleryServices } = await L('/src/app/createGalleryServices.js');
    const table = [
      [undefined, 'mock'], [null, 'mock'], ['', 'mock'], ['   ', 'mock'], ['mock', 'mock'], ['MOCK', 'mock'], [' Mock ', 'mock'],
      ['real', 'real'], ['REAL', 'real'], [' Real ', 'real'],
      ['yes', 'invalid'], ['true', 'invalid'], ['reall', 'invalid'], ['mock,real', 'invalid'],
    ];
    for (const [raw, expected] of table) {
      check(`parse/${JSON.stringify(raw)} -> ${expected}`, gm.parseGalleryModeSetting(raw) === expected);
    }
    // MỘT cách diễn giải: composition root và nhánh thiếu Provider đồng ý với nhau trên mọi giá trị.
    const GOOD = { VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'http://localhost:8000' };
    const auth = { mode: 'firebase', useCases: { getIdToken: async () => 'T' } };
    for (const [raw, expected] of table) {
      const composed = createGalleryServices({ env: { ...GOOD, VITE_GALLERY_MODE: raw }, isDev: true, authServices: auth });
      const missing = gm.resolveMissingProviderServices(raw);
      const consistent =
        expected === 'mock' ? composed.mode === 'mock' && missing.mode === 'mock'
          : expected === 'real' ? composed.mode === 'real' && missing.mode === 'invalid'
            : composed.mode === 'invalid' && missing.mode === 'invalid';
      check(`nhất quán/composition root và thiếu-Provider cùng diễn giải ${JSON.stringify(raw)} (${expected})`, consistent, `${composed.mode}/${missing.mode}`);
    }
    check('nhất quán/giá trị lạ: thông báo lỗi dùng cùng câu INVALID_MODE_MESSAGE ở cả hai nơi', resolveGalleryConfig({ env: { VITE_GALLERY_MODE: 'yes' }, isDev: true }).configError.message.includes(gm.INVALID_MODE_MESSAGE) && gm.resolveMissingProviderServices('yes').configError.message.includes(gm.INVALID_MODE_MESSAGE));
    const m = gm.resolveMissingProviderServices('mock'); const r = gm.resolveMissingProviderServices('real'); const b = gm.resolveMissingProviderServices('yes');
    check('thiếu Provider/MOCK: mode mock, missingProvider, có notice nêu rõ MOCK + thiếu Provider + không gọi Backend, không listPage', m.mode === 'mock' && m.isMock === true && m.missingProvider === true && m.listPage === null && /MOCK/.test(m.notice) && /GalleryServicesContext\.Provider/.test(m.notice) && /không có request/i.test(m.notice));
    check('thiếu Provider/REAL: mode invalid, KHÔNG isMock, không listPage, lỗi nêu thiếu Provider và "KHÔNG dùng MOCK thay thế"', r.mode === 'invalid' && r.isMock === false && r.listPage === null && r.missingProvider === true && /GalleryServicesContext\.Provider/.test(r.configError.message) && /KHÔNG dùng MOCK/.test(r.configError.message) && r.configError.missing.includes('GalleryServicesContext.Provider'));
    check('thiếu Provider/giá trị lạ: mode invalid, nêu "không hợp lệ" và thiếu Provider, không MOCK, không listPage', b.mode === 'invalid' && b.listPage === null && /không hợp lệ/.test(b.configError.message) && /GalleryServicesContext\.Provider/.test(b.configError.message) && b.configError.missing.includes('VITE_GALLERY_MODE'));
    check('thiếu Provider/descriptor bất biến và ỔN ĐỊNH (cùng đối tượng giữa các lần gọi, tránh render lại)', Object.isFrozen(m) && Object.isFrozen(r) && Object.isFrozen(b) && Object.isFrozen(r.configError) && gm.resolveMissingProviderServices('MOCK') === m && gm.resolveMissingProviderServices('') === m && gm.resolveMissingProviderServices(' real ') === r);
    check('thiếu Provider/không tự tạo dịch vụ: không có fetchImpl/useCases/getIdToken trong descriptor', ![m, r, b].some((d) => 'useCases' in d || 'fetchImpl' in d || 'getIdToken' in d));
  });

  // ============ 2. Render giao diện khi THIẾU Provider, theo từng giá trị VITE_GALLERY_MODE ============
  const scenarios = [
    ['không đặt VITE_GALLERY_MODE', '', 'mock'],
    ['VITE_GALLERY_MODE rỗng', 'VITE_GALLERY_MODE=', 'mock'],
    ['VITE_GALLERY_MODE=mock', 'VITE_GALLERY_MODE=mock', 'mock'],
    ['VITE_GALLERY_MODE=MOCK', 'VITE_GALLERY_MODE=MOCK', 'mock'],
    ['VITE_GALLERY_MODE=real', 'VITE_GALLERY_MODE=real', 'real'],
    ['VITE_GALLERY_MODE=REAL', 'VITE_GALLERY_MODE=REAL', 'real'],
    ['VITE_GALLERY_MODE=yes (lạ)', 'VITE_GALLERY_MODE=yes', 'invalid'],
    ['VITE_GALLERY_MODE=reall (gõ sai)', 'VITE_GALLERY_MODE=reall', 'invalid'],
  ];
  for (const [label, line, kind] of scenarios) {
    await withEnv(line, async (s) => {
      const L = (p) => s.ssrLoadModule(p);
      const { AuthContext } = await L('/src/presentation/contexts/AuthContext.js');
      const { GalleryPage } = await L('/src/presentation/pages/GalleryPage.jsx');
      const render = (auth) => strip(renderToString(h(Router.MemoryRouter, { initialEntries: ['/gallery'] }, h(AuthContext.Provider, { value: { ...baseAuth, ...auth } }, h(GalleryPage)))));
      for (const [who, auth] of [['đăng nhập Firebase', FIREBASE_AUTH], ['đăng nhập MOCK', MOCK_AUTH]]) {
        const html = render(auth);
        if (kind === 'mock') {
          check(`thiếu Provider [${label}] (${who})/MOCK giữ tương thích H1: nhãn MOCK + thanh kịch bản`, isMockPage(html));
          check(`thiếu Provider [${label}] (${who})/có CẢNH BÁO nêu rõ dùng MOCK vì thiếu Provider`, html.includes('<p class="notice" role="status">') && html.includes('Gallery đang dùng dữ liệu MOCK vì ứng dụng thiếu GalleryServicesContext.Provider') && html.includes('Không có request nào tới Backend'));
          check(`thiếu Provider [${label}] (${who})/giữ nguyên ghi chú Firestore của H1 đúng điều kiện`, auth.isMock ? !html.includes('CHƯA kết nối Firestore') : html.includes('CHƯA kết nối Firestore'));
        } else {
          check(`thiếu Provider [${label}] (${who})/hiện LỖI CẤU HÌNH`, isConfigError(html));
          check(`thiếu Provider [${label}] (${who})/KHÔNG MOCK: không nhãn, không thanh kịch bản, không thẻ ảnh, không "Chưa có ảnh nào", không đang tải`, noMockLeak(html) && !html.includes('Gallery đang dùng dữ liệu MOCK'));
          check(`thiếu Provider [${label}] (${who})/lỗi nêu thiếu Provider`, html.includes('GalleryServicesContext.Provider'));
          if (kind === 'real') check(`thiếu Provider [${label}] (${who})/lỗi nói rõ KHÔNG dùng MOCK thay thế và hướng dẫn nối Provider`, html.includes('KHÔNG dùng MOCK thay thế') && html.includes('src/main.jsx'));
          if (kind === 'invalid') check(`thiếu Provider [${label}] (${who})/lỗi nêu giá trị không hợp lệ (chỉ nhận mock hoặc real)`, html.includes('không hợp lệ') && html.includes('mock') && html.includes('real'));
        }
      }
      // ===== D. CÓ Provider: hành vi giữ nguyên, bất kể VITE_GALLERY_MODE của env =====
      const { GalleryServicesContext, DEFAULT_GALLERY_SERVICES } = await L('/src/presentation/contexts/GalleryServicesContext.js');
      const withProvider = (value, auth) => strip(renderToString(h(Router.MemoryRouter, { initialEntries: ['/gallery'] }, h(AuthContext.Provider, { value: { ...baseAuth, ...auth } }, h(GalleryServicesContext.Provider, { value }, h(GalleryPage))))));
      const mockP = withProvider(DEFAULT_GALLERY_SERVICES, FIREBASE_AUTH);
      check(`có Provider MOCK [${label}]/vẫn MOCK bình thường, KHÔNG cảnh báo thiếu Provider (Provider thắng env)`, isMockPage(mockP) && !mockP.includes(WARN) && !mockP.includes('Gallery đang dùng dữ liệu MOCK vì'));
      const spyCalls = [];
      const realP = withProvider({ mode: 'real', isMock: false, configError: null, listPage: (a) => { spyCalls.push(a); return Promise.resolve({ items: [], nextCursor: null, hasMore: false }); } }, FIREBASE_AUTH);
      await tick(5);
      check(`có Provider REAL [${label}]/giao diện REAL (nhãn DỮ LIỆU THẬT, đang tải), không MOCK, không cảnh báo, render không gọi listPage`, realP.includes('real-badge') && realP.includes('Đang tải danh sách ảnh') && !realP.includes('MOCK') && !realP.includes(WARN) && spyCalls.length === 0);
      const invalidP = withProvider({ mode: 'invalid', isMock: false, configError: { message: 'Gallery REAL chưa dùng được: thiếu VITE_API_BASE_URL.', missing: [] }, listPage: null }, FIREBASE_AUTH);
      check(`có Provider invalid [${label}]/lỗi cấu hình của Provider như trước, không cảnh báo thiếu Provider`, isConfigError(invalidP) && invalidP.includes('thiếu VITE_API_BASE_URL') && !invalidP.includes('GalleryServicesContext.Provider'));
    });
  }

  // ============ 3. Có Provider REAL: luồng Gallery vẫn chạy đầu-cuối (không bị F1 ảnh hưởng) ============
  await withEnv('VITE_GALLERY_MODE=real', async (s) => {
    const L = (p) => s.ssrLoadModule(p);
    const { createGalleryServices } = await L('/src/app/createGalleryServices.js');
    const { createGalleryController } = await L('/src/presentation/hooks/galleryListController.js');
    const { RealGalleryView } = await L('/src/presentation/components/gallery/RealGalleryView.jsx');
    const mk = (i) => ({ imageId: `img-f1-${String(i).padStart(4, '0')}`, ownerId: 'uid-A', status: 'DONE', provider: 'cloudinary', fileName: `f1-${i}.png`, original: { size: 2457600 }, variants: { thumbnail: `https://res.cloudinary.com/demo/image/upload/v1/f1_${i}.webp`, medium: null, webp: null }, previewUrl: `https://res.cloudinary.com/demo/image/upload/v1/f1_${i}.webp`, savedPercent: 83.2, createdAt: '2026-03-01T10:00:00.123456+00:00' });
    const calls = [];
    const pages = { 0: { items: Array.from({ length: 20 }, (_, i) => mk(i)), nextCursor: 'cur_page2', hasMore: true }, cur_page2: { items: Array.from({ length: 5 }, (_, i) => mk(20 + i)), nextCursor: null, hasMore: false } };
    const fetchImpl = async (url, init) => {
      calls.push({ url: String(url), init });
      const cursor = new URL(url).searchParams.get('cursor') ?? 0;
      return { status: 200, text: async () => JSON.stringify(pages[cursor]) };
    };
    const svc = createGalleryServices({ env: { VITE_GALLERY_MODE: 'real', VITE_BACKEND_MODE: 'real', VITE_API_BASE_URL: 'http://localhost:8000' }, isDev: true, authServices: { mode: 'firebase', useCases: { getIdToken: async () => 'TOKEN-A' } }, fetchImpl });
    check('Provider REAL/khởi tạo không gọi mạng', calls.length === 0 && svc.mode === 'real');
    const c = createGalleryController({ ownerId: 'uid-A', listPage: svc.listPage });
    const unsub = c.subscribe(() => {});
    for (let i = 0; i < 200 && c.getSnapshot().status !== 'ready'; i += 1) await tick(1);
    await c.loadMore();
    const st = c.getSnapshot();
    check('Provider REAL/luồng Gallery vẫn chạy: 25 ảnh qua 2 trang, cursor đúng, hết trang', st.items.length === 25 && st.hasMore === false && calls.length === 2 && new URL(calls[1].url).searchParams.get('cursor') === 'cur_page2' && calls.every((x) => x.init.headers.Authorization === 'Bearer TOKEN-A' && !/owner|uid/i.test(x.url)));
    const html = strip(renderToString(h(Router.MemoryRouter, null, h(RealGalleryView, { list: st, onReload() {}, onLoadMore() {} }))));
    check('Provider REAL/giao diện hiển thị 25 thẻ, nhãn DỮ LIỆU THẬT, không MOCK, không cảnh báo thiếu Provider', (html.match(/class="image-card"/g) || []).length === 25 && html.includes('real-badge') && !html.includes('MOCK') && !html.includes(WARN));
    unsub();
  });

  // ============ 4. Mã nguồn: một nơi diễn giải, không đụng Upload H4A ============
  const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
  const sstrip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '').replace(/\{\/\*[\s\S]*?\*\/\}/g, '');
  const importsOf = (code) => [...code.matchAll(/from\s+['"]([^'"]+)['"]/g)].map((m) => m[1]);
  const svcCode = sstrip(read('src/app/createGalleryServices.js'));
  const hookCode = sstrip(read('src/presentation/hooks/useGalleryServices.js'));
  const modeCode = sstrip(read('src/application/galleryMode.js'));
  const pageCode = sstrip(read('src/presentation/pages/GalleryPage.jsx'));
  check('mã nguồn/createGalleryServices dùng parseGalleryModeSetting chung, không tự cắt/hạ chữ cấu hình nữa', importsOf(svcCode).includes('../application/galleryMode') && /parseGalleryModeSetting\(/.test(svcCode) && !/toLowerCase|\.trim\(\)/.test(svcCode));
  check('mã nguồn/useGalleryServices dùng resolveMissingProviderServices chung, không tự diễn giải chuỗi cấu hình', importsOf(hookCode).includes('../../application/galleryMode') && /resolveMissingProviderServices\(/.test(hookCode) && !/toLowerCase|\.trim\(\)|'real'|'mock'/.test(hookCode));
  check('mã nguồn/chỉ MỘT nơi trong Presentation đọc import.meta (useGalleryServices, nhánh thiếu Provider); GalleryPage không đọc cấu hình', /import\.meta\.env/.test(hookCode) && !/import\.meta|VITE_/.test(pageCode) && (() => { const hits = []; (function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); if (fs.statSync(p).isDirectory()) walk(p); else if (/\.(js|jsx)$/.test(n) && /import\.meta/.test(sstrip(fs.readFileSync(p, 'utf8')))) hits.push(path.relative(root, p).replace(/\\/g, '/')); } })(path.join(root, 'src/presentation')); return hits.join() === 'src/presentation/hooks/useGalleryServices.js'; })());
  check('mã nguồn/galleryMode.js thuần: không import React/Firebase/Infrastructure, không import.meta, không fetch', importsOf(modeCode).length === 0 && !/import\.meta|fetch|console\./.test(modeCode));
  check('mã nguồn/context mặc định là null (không còn MOCK cứng ngầm định), Provider tường minh vẫn hoạt động', /createContext\(null\)/.test(sstrip(read('src/presentation/contexts/GalleryServicesContext.js'))));
  check('mã nguồn/main.jsx vẫn bọc GalleryServicesContext.Provider qua createGalleryServices({ authServices })', /GalleryServicesContext\.Provider/.test(sstrip(read('src/main.jsx'))) && /createGalleryServices\(\{ authServices \}\)/.test(sstrip(read('src/main.jsx'))));
  const upload = sstrip(read('src/presentation/pages/UploadPage.jsx')) + sstrip(read('src/presentation/hooks/useUploadFlow.js')) + sstrip(read('src/app/createUploadServices.js'));
  check('Upload H4A không bị đụng: không tham chiếu galleryMode/useGalleryServices/createGalleryServices', !/galleryMode|useGalleryServices|createGalleryServices|GalleryServices/.test(upload));
  check('mạng thật/0 lần gọi fetch/XHR toàn cục trong toàn bộ test (thiếu Provider không gây request)', globalNetCalls === netBefore, String(globalNetCalls));
} finally {
  /* server được đóng trong withEnv */
}

out(`PASSED: ${passed}`);
out(`FAILED: ${failures.length}`);
failures.forEach((f) => out('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
