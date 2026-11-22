// Smoke test H1 — Node + Vite SSR. KHÔNG gọi mạng, KHÔNG dùng Google thật, KHÔNG ghi file vào dự án.
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/smoke.mjs .  (xem tests/README.md)
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const viteUrl = pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href;
const { createServer } = await import(viteUrl);

let passed = 0;
const failures = [];
function check(name, condition, detail = '') {
  if (condition) passed += 1;
  else failures.push(`${name}${detail ? ` — ${detail}` : ''}`);
}
async function rejects(promise) {
  try {
    await promise;
    return null;
  } catch (error) {
    return error;
  }
}

async function withServer(env, fn) {
  const define = Object.fromEntries(
    Object.entries(env).map(([k, v]) => [`import.meta.env.${k}`, JSON.stringify(v)]),
  );
  const server = await createServer({
    root,
    envDir: process.env.EMPTY_ENV_DIR,
    appType: 'custom',
    logLevel: 'silent',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
    define,
  });
  try {
    return await fn(server);
  } finally {
    await server.close();
  }
}

// ======================= 1) firebaseClient: chọn cấu hình =======================
const FAKE = {
  VITE_FIREBASE_API_KEY: 'fake-api-key-for-smoke-test',
  VITE_FIREBASE_AUTH_DOMAIN: 'fake-project.firebaseapp.com',
  VITE_FIREBASE_PROJECT_ID: 'fake-project',
};

await withServer({}, async (s) => {
  const c = await s.ssrLoadModule('/src/infrastructure/authAdapters.js');
  const st = c.firebaseClientState;
  check('client/không có env -> isFirebaseConfigured=false', st.isFirebaseConfigured === false);
  check('client/không có env -> hasAnyFirebaseConfig=false', st.hasAnyFirebaseConfig === false);
  check('client/không có env -> missing 3 biến bắt buộc', st.missingFirebaseConfig.length === 3);
  const { createAuthServices } = await s.ssrLoadModule('/src/app/createAuthServices.js');
  const svc = createAuthServices();
  check('root/không có env -> mode mock', svc.mode === 'mock' && svc.isMock === true && svc.configError === null);
});

await withServer({ VITE_FIREBASE_API_KEY: FAKE.VITE_FIREBASE_API_KEY }, async (s) => {
  const { createAuthServices } = await s.ssrLoadModule('/src/app/createAuthServices.js');
  const svc = createAuthServices();
  check('root/điền một phần -> misconfigured (KHÔNG MOCK)', svc.mode === 'misconfigured' && svc.isMock === false);
  check(
    'root/điền một phần -> liệt kê đúng tên biến thiếu',
    svc.configError?.missing?.join(',') === 'VITE_FIREBASE_AUTH_DOMAIN,VITE_FIREBASE_PROJECT_ID',
    JSON.stringify(svc.configError?.missing),
  );
  check(
    'root/điền một phần -> thông báo không chứa giá trị cấu hình',
    !svc.configError.message.includes(FAKE.VITE_FIREBASE_API_KEY),
  );
  const e1 = await rejects(svc.useCases.loginWithGoogle());
  check('misconfigured/login -> CONFIG', e1?.code === 'CONFIG', e1?.code);
  const e2 = await rejects(svc.useCases.getIdToken());
  check('misconfigured/getIdToken -> CONFIG', e2?.code === 'CONFIG', e2?.code);
  const seen = [];
  const stop = svc.useCases.observeAuthState(
    (u) => seen.push(['user', u]),
    (e) => seen.push(['error', e.code]),
  );
  await new Promise((r) => setTimeout(r, 10));
  stop();
  check(
    'misconfigured/observe -> onChange(null) rồi onError(CONFIG)',
    seen.length === 2 && seen[0][1] === null && seen[1][1] === 'CONFIG',
    JSON.stringify(seen),
  );
});

// Đủ 3 biến bắt buộc, KHÔNG có storageBucket/appId: Auth vẫn phải chạy (không phụ thuộc Storage bucket).
await withServer(FAKE, async (s) => {
  const c = await s.ssrLoadModule('/src/infrastructure/authAdapters.js');
  const st = c.firebaseClientState;
  check('client/3 biến bắt buộc -> isFirebaseConfigured=true', st.isFirebaseConfigured === true, String(st.firebaseInitError?.message));
  check('client/3 biến bắt buộc, thiếu bucket -> auth khác null', st.auth !== null);
  const { createAuthServices } = await s.ssrLoadModule('/src/app/createAuthServices.js');
  const svc = createAuthServices();
  check('root/đủ biến bắt buộc -> mode firebase', svc.mode === 'firebase' && svc.isMock === false && svc.configError === null);
  // Listener Firebase thật (Node, không mạng): chưa đăng nhập -> onChange(null).
  const states = [];
  const stop = svc.useCases.observeAuthState((u) => states.push(u), () => {});
  await new Promise((r) => setTimeout(r, 300));
  stop();
  stop(); // gọi nhiều lần an toàn
  check('firebase/observe -> báo trạng thái chưa đăng nhập (null)', states.length >= 1 && states[0] === null, JSON.stringify(states));
  const e = await rejects(svc.useCases.getIdToken());
  check('firebase/getIdToken khi chưa đăng nhập -> UNAUTHENTICATED', e?.code === 'UNAUTHENTICATED', e?.code);
});

// ======================= 2) Dùng một server cho phần còn lại =======================
await withServer({}, async (s) => {
  const { createAuthServices, resolveAuthMode, AUTH_MODE } = await s.ssrLoadModule('/src/app/createAuthServices.js');
  const { createFirebaseAuthRepository, createMockAuthRepository } = await s.ssrLoadModule('/src/infrastructure/authAdapters.js');
  const { createObserveAuthState } = await s.ssrLoadModule('/src/application/usecases/auth.js');

  // --- resolveAuthMode: lỗi khởi tạo ---
  const initErr = resolveAuthMode({
    isFirebaseConfigured: false, hasAnyFirebaseConfig: true, missingFirebaseConfig: [], firebaseInitError: new Error('x'),
  });
  check('resolve/khởi tạo lỗi -> misconfigured', initErr.mode === AUTH_MODE.MISCONFIGURED && initErr.configError.message.length > 0);

  // --- MOCK ---
  const mockSvc = createAuthServices({
    client: { isFirebaseConfigured: false, hasAnyFirebaseConfig: false, missingFirebaseConfig: ['A'], firebaseInitError: null },
    createMockRepository: () => createMockAuthRepository({ latencyMs: 0, storage: null }),
  });
  const seen = [];
  mockSvc.useCases.observeAuthState((u) => seen.push(u?.uid ?? null));
  await new Promise((r) => setTimeout(r, 5));
  const user = await mockSvc.useCases.loginWithGoogle();
  check('mock/login trả uid MOCK', typeof user.uid === 'string' && user.uid.startsWith('mock-'), user.uid);
  check('mock/observe: null rồi uid', seen[0] === null && seen[seen.length - 1] === user.uid, JSON.stringify(seen));
  const tokenErr = await rejects(mockSvc.useCases.getIdToken());
  check(
    'mock/getIdToken -> UNAUTHENTICATED + details.mock, KHÔNG token giả',
    tokenErr?.code === 'UNAUTHENTICATED' && tokenErr.details?.mock === true && /MOCK/.test(tokenErr.message),
    tokenErr?.code,
  );
  await mockSvc.useCases.logout();

  // --- firebaseAuthRepository với SDK/auth giả: phân loại lỗi ---
  const mk = (sdk, currentUser = null) => createFirebaseAuthRepository({ auth: { currentUser }, sdk });
  const codes = {
    'auth/popup-closed-by-user': 'CANCELLED',
    'auth/popup-blocked': 'POPUP_BLOCKED',
    'auth/network-request-failed': 'NETWORK',
    'auth/unauthorized-domain': 'CONFIG',
    'auth/operation-not-allowed': 'CONFIG',
    'auth/invalid-api-key': 'CONFIG',
    'auth/internal-error': 'UNKNOWN',
  };
  for (const [sdkCode, expected] of Object.entries(codes)) {
    const repo = mk({ signInWithPopup: async () => { throw Object.assign(new Error('sdk'), { code: sdkCode }); } });
    const err = await rejects(repo.signInWithGoogle());
    check(`signIn ${sdkCode} -> ${expected}`, err?.code === expected, err?.code);
  }
  const okRepo = mk({ signInWithPopup: async () => ({ user: { uid: 'u1', displayName: 'A', email: 'a@x' } }) });
  const okUser = await okRepo.signInWithGoogle();
  check('signIn thành công -> {uid,displayName,email}', okUser.uid === 'u1' && okUser.email === 'a@x');

  // --- getIdToken ---
  const noUser = await rejects(mk({}).getIdToken());
  check('repo.getIdToken chưa đăng nhập -> UNAUTHENTICATED', noUser?.code === 'UNAUTHENTICATED');
  const calls = [];
  const withUser = mk({}, { getIdToken: async (force) => { calls.push(force); return 'TEST-TOKEN'; } });
  check('repo.getIdToken mặc định forceRefresh=false', (await withUser.getIdToken()) === 'TEST-TOKEN' && calls[0] === false);
  await withUser.getIdToken(true);
  check('repo.getIdToken(true) truyền forceRefresh', calls[1] === true);
  const netUser = mk({}, { getIdToken: async () => { throw Object.assign(new Error('n'), { code: 'auth/network-request-failed' }); } });
  const netErr = await rejects(netUser.getIdToken());
  check('repo.getIdToken lỗi mạng -> NETWORK', netErr?.code === 'NETWORK', netErr?.code);

  // --- use case getIdToken từ chối token rỗng ---
  const { createGetIdToken } = await s.ssrLoadModule('/src/application/usecases/auth.js');
  const emptyErr = await rejects(createGetIdToken({ authRepository: { getIdToken: async () => '' } })());
  check('usecase.getIdToken từ chối token rỗng', emptyErr?.code === 'UNAUTHENTICATED');
  const forced = [];
  await createGetIdToken({ authRepository: { getIdToken: async (f) => { forced.push(f); return 't'; } } })({ forceRefresh: true });
  check('usecase.getIdToken({forceRefresh:true}) chuyển tiếp', forced[0] === true);

  // --- listener: onError chuyển lên, hủy idempotent, không gọi sau khi hủy ---
  let emit;
  const fakeOnAuth = (_auth, next, error) => { emit = { next, error }; return () => {}; };
  const repo2 = mk({ onAuthStateChanged: fakeOnAuth });
  const got = [];
  const stop = createObserveAuthState({ authRepository: repo2 })(
    (u) => got.push(['user', u?.uid ?? null]),
    (e) => got.push(['error', e.code]),
  );
  emit.next({ uid: 'u9', displayName: null, email: null });
  emit.error(Object.assign(new Error('net'), { code: 'auth/network-request-failed' }));
  stop(); stop();
  emit.next({ uid: 'late' });
  emit.error(Object.assign(new Error('late'), { code: 'auth/internal-error' }));
  check(
    'listener: user + lỗi NETWORK chuyển lên; sau khi hủy không còn gọi',
    JSON.stringify(got) === JSON.stringify([['user', 'u9'], ['error', 'NETWORK']]),
    JSON.stringify(got),
  );
});

// ======================= 3) Render giao diện (SSR, chỉ render ban đầu) =======================
await withServer({}, async (s) => {
  const nativeImport = (spec) => import(pathToFileURL(path.join(root, 'node_modules', spec)).href);
  const reactMod = await nativeImport('react/index.js');
  const React = reactMod.default ?? reactMod;
  const domServer = await nativeImport('react-dom/server.node.js');
  const renderToString = (domServer.default ?? domServer).renderToString ?? domServer.renderToString;
  const Router = await nativeImport('react-router/dist/production/index.js');
  const { AuthContext } = await s.ssrLoadModule('/src/presentation/contexts/AuthContext.js');
  const { AuthProvider } = await s.ssrLoadModule('/src/presentation/contexts/AuthProvider.jsx');
  const { LoginPage } = await s.ssrLoadModule('/src/presentation/pages/LoginPage.jsx');
  const { Header } = await s.ssrLoadModule('/src/presentation/components/layout/Header.jsx');
  const { ProtectedRoute } = await s.ssrLoadModule('/src/presentation/components/layout/ProtectedRoute.jsx');
  const { GalleryPage } = await s.ssrLoadModule('/src/presentation/pages/GalleryPage.jsx');
  const { createAuthServices } = await s.ssrLoadModule('/src/app/createAuthServices.js');
  const { CANCELLED } = { CANCELLED: 'CANCELLED' };

  const base = {
    user: null, initializing: false, isMock: false, mode: 'firebase', configError: null, authError: null,
    login: async () => {}, logout: async () => {}, getIdToken: async () => 'x',
  };
  const render = (ctx, element, url = '/login') =>
    renderToString(
      React.createElement(Router.MemoryRouter, { initialEntries: [url] },
        React.createElement(AuthContext.Provider, { value: { ...base, ...ctx } }, element)),
    );
  const strip = (html) => html.replace(/<!--.*?-->/g, '');

  let html = strip(render({ initializing: true }, React.createElement(LoginPage)));
  check('Login/initializing -> loading', html.includes('Đang kiểm tra đăng nhập'));

  html = strip(render({}, React.createElement(LoginPage)));
  check('Login/firebase -> nút Google, không MOCK', html.includes('Đăng nhập với Google') && !html.includes('(MOCK)'));

  html = strip(render({ isMock: true, mode: 'mock' }, React.createElement(LoginPage)));
  check('Login/mock -> nút MOCK + ghi rõ không có token thật', html.includes('Đăng nhập (MOCK)') && html.includes('không có Firebase ID token thật'));

  html = strip(render(
    { mode: 'misconfigured', configError: { message: 'Cấu hình Firebase chưa đầy đủ: thiếu VITE_FIREBASE_PROJECT_ID', missing: ['VITE_FIREBASE_PROJECT_ID'] } },
    React.createElement(LoginPage),
  ));
  check('Login/misconfigured -> báo lỗi cấu hình, KHÔNG tự MOCK, nút bị vô hiệu',
    html.includes('Lỗi cấu hình Firebase') && html.includes('KHÔNG tự chuyển sang MOCK') && /<button[^>]*disabled/.test(html) && !html.includes('(MOCK)'));

  html = strip(render({ authError: Object.assign(new Error('Lỗi kết nối mạng khi đăng nhập.'), { code: 'NETWORK' }) }, React.createElement(LoginPage)));
  check('Login/authError NETWORK -> hiện tiêu đề "Lỗi kết nối mạng"', html.includes('Lỗi kết nối mạng') && html.includes('role="alert"'));

  html = strip(render({ authError: Object.assign(new Error('Bạn đã đóng.'), { code: CANCELLED }) }, React.createElement(LoginPage)));
  check('Login/CANCELLED -> thông tin trung tính (role=status), không phải alert', html.includes('role="status"') && !html.includes('role="alert"'));

  const realUser = { uid: 'REAL-UID-123', displayName: 'Nguyễn A', email: 'a@example.com' };
  html = strip(render({ user: realUser }, React.createElement(Header)));
  check('Header/firebase -> UID, menu Tài khoản, nút Sao chép UID + ID token (bật)',
    html.includes('REAL-UID-123') && html.includes('Tài khoản') && html.includes('Sao chép UID') && html.includes('Sao chép ID token') && !html.includes('MOCK'));
  check('Header không in token', !html.includes('TEST-TOKEN'));

  html = strip(render({ user: { uid: 'mock-uid-001', displayName: 'M', email: 'm@x' }, isMock: true, mode: 'mock' }, React.createElement(Header)));
  check('Header/mock -> MOCK badge + ghi rõ không có token thật + nút token bị vô hiệu',
    html.includes('MOCK') && html.includes('không có Firebase ID token thật') && /Sao chép ID token<\/button>/.test(html) && /<button[^>]*disabled[^>]*>Sao chép ID token/.test(html));

  html = strip(render({ initializing: true }, React.createElement(ProtectedRoute), '/gallery'));
  check('ProtectedRoute/initializing -> loading, không chuyển hướng', html.includes('Đang kiểm tra đăng nhập'));

  html = strip(render({ user: realUser }, React.createElement(GalleryPage), '/gallery'));
  check('Gallery/Firebase thật -> có nhãn MOCK + ghi rõ chưa kết nối Firestore',
    html.includes('MOCK') && html.includes('CHƯA kết nối Firestore') && html.includes('Thử trạng thái MOCK'));
  html = strip(render({ user: { uid: 'mock-uid-001', displayName: 'M', email: 'm@x' }, isMock: true, mode: 'mock' }, React.createElement(GalleryPage), '/gallery'));
  check('Gallery/MOCK -> giữ thanh kịch bản MOCK, không có ghi chú Firestore', html.includes('Thử trạng thái MOCK') && !html.includes('CHƯA kết nối Firestore'));

  // AuthProvider thật: render ban đầu phải là initializing=true (chưa biết phiên) cho tới khi listener báo.
  const mockServices = createAuthServices();
  html = strip(renderToString(
    React.createElement(Router.MemoryRouter, { initialEntries: ['/gallery'] },
      React.createElement(AuthProvider, { services: mockServices }, React.createElement(ProtectedRoute))),
  ));
  check('AuthProvider thật/ban đầu -> initializing (loading)', html.includes('Đang kiểm tra đăng nhập'));
});

console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failures.length}`);
failures.forEach((f) => console.log('  ✗ ' + f));
process.exit(failures.length ? 1 : 0);
