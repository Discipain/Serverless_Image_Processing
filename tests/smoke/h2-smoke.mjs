// Smoke test H2 — Cloudinary uploader. XMLHttpRequest GIẢ LẬP: KHÔNG gọi mạng, KHÔNG upload thật.
// Dùng (từ thư mục gốc dự án): EMPTY_ENV_DIR=<thư mục rỗng> node tests/smoke/h2-smoke.mjs .  (xem tests/README.md)
// Tùy chọn: SMOKE_REAL_CLOUD_NAME / SMOKE_REAL_UPLOAD_PRESET = giá trị Cloudinary thật của nhóm, chỉ để kiểm tra chúng KHÔNG nằm trong src.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const root = path.resolve(process.argv[2]);
const { createServer } = await import(pathToFileURL(path.join(root, 'node_modules/vite/dist/node/index.js')).href);

let passed = 0;
const failures = [];
const check = (name, ok, detail = '') => (ok ? (passed += 1) : failures.push(`${name}${detail ? ` — ${detail}` : ''}`));
const settle = async (p) => {
  try { return { value: await p }; } catch (error) { return { error }; }
};
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

// ---------- XHR giả ----------
class FakeXhr {
  constructor(behavior) {
    this.behavior = behavior; this.upload = {}; this.headers = []; this.aborted = false;
    this.withCredentials = false; this.status = 0; this.responseText = '';
  }
  open(method, url, async) { this.method = method; this.url = url; this.async = async; }
  setRequestHeader(k, v) { this.headers.push([k, v]); }
  send(form) { this.form = form; queueMicrotask(() => this.behavior(this, form)); }
  abort() { this.aborted = true; this.onabort?.(); }
}
function makeFactory(behaviors) {
  const created = [];
  const factory = () => { const x = new FakeXhr(behaviors[created.length] ?? (() => {})); created.push(x); return x; };
  factory.created = created;
  return factory;
}
const asset = (id) => JSON.stringify({
  secure_url: `https://res.cloudinary.com/test-cloud/image/upload/v1/${id}.webp`,
  public_id: id, resource_type: 'image', format: 'webp', bytes: 123, width: 10, height: 20, asset_id: `asset-${id}`,
});
const ok = (id) => (x) => { x.status = 200; x.responseText = asset(id); x.onload(); };
const http = (status, body) => (x) => { x.status = status; x.responseText = body; x.onload(); };
const netErr = (x) => x.onerror();
const timeout = (x) => x.ontimeout();
const hang = () => {};
const webp = (n = 100) => new Blob([new Uint8Array(n)], { type: 'image/webp' });

const server = await createServer({
  root, envDir: process.env.EMPTY_ENV_DIR, appType: 'custom', logLevel: 'silent',
  server: { middlewareMode: true, hmr: false, watch: null }, optimizeDeps: { noDiscovery: true, include: [] },
});
try {
  const { createCloudinaryUploader, UPLOAD_ERROR_KIND } = await server.ssrLoadModule('/src/infrastructure/cloudinary/cloudinaryUploader.js');
  const { readCloudinaryConfig } = await server.ssrLoadModule('/src/infrastructure/cloudinary/cloudinaryConfig.js');
  const { createUploadVariantsToCloudinary } = await server.ssrLoadModule('/src/application/usecases/uploadVariantsToCloudinary.js');
  const { createCloudinaryServices } = await server.ssrLoadModule('/src/app/createCloudinaryServices.js');

  const mk = (behaviors, opts = {}) => {
    const f = makeFactory(behaviors);
    return { f, up: createCloudinaryUploader({ cloudName: 'test-cloud', uploadPreset: 'test-preset', createXhr: f, timeoutMs: 5000, ...opts }) };
  };

  // ===== Cấu hình =====
  check('config/đọc thiếu cả hai', readCloudinaryConfig({}).missing.join() === 'VITE_CLOUDINARY_CLOUD_NAME,VITE_CLOUDINARY_UPLOAD_PRESET');
  const rc = readCloudinaryConfig({ VITE_CLOUDINARY_CLOUD_NAME: '  c1 ', VITE_CLOUDINARY_UPLOAD_PRESET: ' p1 ' });
  check('config/đọc đủ + cắt khoảng trắng', rc.missing.length === 0 && rc.cloudName === 'c1' && rc.uploadPreset === 'p1');

  for (const [label, opts, expectMissing] of [
    ['thiếu cloud name', { uploadPreset: 'p' }, 'VITE_CLOUDINARY_CLOUD_NAME'],
    ['thiếu upload preset', { cloudName: 'c' }, 'VITE_CLOUDINARY_UPLOAD_PRESET'],
    ['cloud name rỗng/khoảng trắng', { cloudName: '   ', uploadPreset: 'p' }, 'VITE_CLOUDINARY_CLOUD_NAME'],
  ]) {
    const f = makeFactory([]);
    const r = await settle(createCloudinaryUploader({ ...opts, createXhr: f }).upload({ blob: webp() }));
    check(`config/${label} -> CONFIG`, r.error?.code === 'CONFIG' && r.error.details.kind === UPLOAD_ERROR_KIND.CONFIG && r.error.details.missing.includes(expectMissing), r.error?.code);
    check(`config/${label} -> không tạo request`, f.created.length === 0);
  }
  {
    const f = makeFactory([]);
    const r = await settle(createCloudinaryUploader({ cloudName: 'a/b?x', uploadPreset: 'p', createXhr: f }).upload({ blob: webp() }));
    check('config/cloud name chứa ký tự lạ -> CONFIG, không request', r.error?.code === 'CONFIG' && f.created.length === 0);
  }

  // ===== Blob không hợp lệ (không gửi request) =====
  {
    const { up, f } = mk([]);
    const cases = {
      'chuỗi (không phải Blob)': { blob: 'abc' },
      'undefined': {},
      'Blob rỗng': { blob: new Blob([], { type: 'image/webp' }) },
      'Blob PNG': { blob: new Blob([new Uint8Array(5)], { type: 'image/png' }) },
      'Blob không có type': { blob: new Blob([new Uint8Array(5)]) },
      'Blob > 10MB': { blob: new Blob([new Uint8Array(10 * 1024 * 1024 + 1)], { type: 'image/webp' }) },
      'biến thể "original"': { blob: webp(), variant: 'original' },
    };
    for (const [label, args] of Object.entries(cases)) {
      const r = await settle(up.upload(args));
      check(`blob/${label} -> VALIDATION`, r.error?.code === 'VALIDATION' && r.error.details.kind === UPLOAD_ERROR_KIND.INVALID_INPUT, r.error?.code);
    }
    check('blob/không hợp lệ -> không tạo request nào', f.created.length === 0);
  }

  // ===== Thành công + nội dung request (không secret) =====
  {
    const { up, f } = mk([ok('pub-1')]);
    const blob = webp(64);
    const r = await settle(up.upload({ blob, variant: 'thumbnail' }));
    const x = f.created[0];
    check('upload/thành công trả asset', r.value?.secureUrl.startsWith('https://') && r.value.publicId === 'pub-1' && r.value.resourceType === 'image'
      && r.value.format === 'webp' && r.value.bytes === 123 && r.value.width === 10 && r.value.height === 20 && r.value.assetId === 'asset-pub-1', JSON.stringify(r.value));
    check('upload/asset bị đóng băng', Object.isFrozen(r.value));
    check('request/POST đúng URL Cloudinary', x.method === 'POST' && x.url === 'https://api.cloudinary.com/v1_1/test-cloud/image/upload' && x.async === true, x.url);
    const entries = [...x.form.entries()];
    check('request/chỉ có đúng 2 trường: upload_preset, file', entries.map(([k]) => k).join() === 'upload_preset,file', entries.map(([k]) => k).join());
    check('request/preset đúng', entries[0][1] === 'test-preset');
    check('request/file là Blob WebP, tên thumb.webp (nhãn multipart)', entries[1][1] instanceof Blob && entries[1][1].type === 'image/webp' && entries[1][1].name === 'thumb.webp' && entries[1][1].size === 64);
    const forbidden = ['api_key', 'api_secret', 'signature', 'timestamp', 'folder', 'asset_folder', 'public_id', 'imageId', 'uid', 'token'];
    check('request/KHÔNG có api_key/secret/chữ ký/folder/public_id/imageId', forbidden.every((k) => !x.form.has(k)));
    check('request/không đặt header nào (không Authorization/token)', x.headers.length === 0);
    check('request/withCredentials=false, timeout đã đặt', x.withCredentials === false && x.timeout === 5000);
  }

  // ===== Tiến độ =====
  {
    const prog = [];
    const { up } = mk([(x) => {
      x.upload.onprogress({ lengthComputable: false, loaded: 10, total: 0 }); // bị bỏ qua
      x.upload.onprogress({ lengthComputable: true, loaded: 50, total: 100 });
      x.upload.onprogress({ lengthComputable: true, loaded: 30, total: 100 }); // giảm -> bị bỏ qua
      x.upload.onprogress({ lengthComputable: true, loaded: 100, total: 100 }); // 100% -> báo 99 (chưa xong)
      ok('p')(x);
    }]);
    await up.upload({ blob: webp(), onProgress: (p) => prog.push(p) });
    check('progress/0 -> 50 -> 99 -> 100, đơn điệu', JSON.stringify(prog) === '[0,50,99,100]', JSON.stringify(prog));
    const { up: up2 } = mk([(x) => { x.upload.onprogress({ lengthComputable: true, loaded: 1, total: 2 }); ok('q')(x); }]);
    const r = await settle(up2.upload({ blob: webp(), onProgress: () => { throw new Error('boom'); } }));
    check('progress/callback ném lỗi không làm hỏng upload', r.value?.publicId === 'q');
  }

  // ===== Response không hợp lệ =====
  const badResponses = {
    'thiếu secure_url': JSON.stringify({ public_id: 'a', resource_type: 'image' }),
    'secure_url không phải https': JSON.stringify({ secure_url: 'http://x/y.webp', public_id: 'a', resource_type: 'image' }),
    'thiếu public_id': JSON.stringify({ secure_url: 'https://x/y.webp', resource_type: 'image' }),
    'public_id rỗng': JSON.stringify({ secure_url: 'https://x/y.webp', public_id: '', resource_type: 'image' }),
    'resource_type không phải image': JSON.stringify({ secure_url: 'https://x/y', public_id: 'a', resource_type: 'raw' }),
    'không phải JSON': '<html>oops</html>',
    'mảng JSON': '[]',
    'rỗng': '',
  };
  for (const [label, body] of Object.entries(badResponses)) {
    const { up } = mk([http(200, body)]);
    const r = await settle(up.upload({ blob: webp() }));
    check(`response/${label} -> INVALID_RESPONSE`, r.error?.code === 'UPLOAD_FAILED' && r.error.details.kind === UPLOAD_ERROR_KIND.INVALID_RESPONSE, `${r.error?.code}/${r.error?.details?.kind}`);
  }
  {
    // Trường tùy chọn thiếu -> null (không bịa giá trị)
    const { up } = mk([http(200, JSON.stringify({ secure_url: 'https://x/y.webp', public_id: 'a', resource_type: 'image' }))]);
    const r = await settle(up.upload({ blob: webp() }));
    check('response/thiếu trường tùy chọn -> null', r.value?.bytes === null && r.value.width === null && r.value.format === null && r.value.assetId === null);
  }

  // ===== HTTP / mạng / timeout =====
  {
    const { up } = mk([http(400, JSON.stringify({ error: { message: 'Upload preset not found' } }))]);
    const r = await settle(up.upload({ blob: webp() }));
    check('http/400 -> UPLOAD_FAILED + CLOUDINARY_REJECTED + thông điệp', r.error?.code === 'UPLOAD_FAILED' && r.error.details.kind === 'CLOUDINARY_REJECTED' && r.error.details.httpStatus === 400 && r.error.message.includes('Upload preset not found'));
    const { up: u2 } = mk([http(420, '{}')]);
    check('http/420 -> QUOTA_EXCEEDED', (await settle(u2.upload({ blob: webp() }))).error?.code === 'QUOTA_EXCEEDED');
    const { up: u3 } = mk([http(500, 'Internal Server Error')]);
    const r3 = await settle(u3.upload({ blob: webp() }));
    check('http/500 không JSON -> UPLOAD_FAILED', r3.error?.code === 'UPLOAD_FAILED' && r3.error.details.remoteMessage === null);
    const { up: u4 } = mk([http(0, '')]);
    check('http/status 0 -> NETWORK', (await settle(u4.upload({ blob: webp() }))).error?.code === 'NETWORK');
  }
  {
    const { up, f } = mk([netErr]);
    const r = await settle(up.upload({ blob: webp() }));
    check('mạng/onerror -> NETWORK', r.error?.code === 'NETWORK' && r.error.details.kind === 'NETWORK');
    await tick(20);
    check('mạng/lỗi KHÔNG tự retry (đúng 1 request)', f.created.length === 1);
    const { up: u2, f: f2 } = mk([timeout]);
    const r2 = await settle(u2.upload({ blob: webp() }));
    check('timeout -> NETWORK + kind TIMEOUT', r2.error?.code === 'NETWORK' && r2.error.details.kind === 'TIMEOUT');
    check('timeout/KHÔNG tự retry', f2.created.length === 1);
    const { up: u3 } = mk([(x) => { x.onerror(); x.onload(); x.ontimeout(); }]);
    const r3 = await settle(u3.upload({ blob: webp() }));
    check('chỉ kết thúc một lần (sự kiện đến sau bị bỏ qua)', r3.error?.code === 'NETWORK');
  }

  // ===== Hủy =====
  {
    const ctl = new AbortController(); ctl.abort();
    const { up, f } = mk([ok('x')]);
    const r = await settle(up.upload({ blob: webp(), signal: ctl.signal }));
    check('hủy/trước khi bắt đầu -> CANCELLED, không request', r.error?.code === 'CANCELLED' && f.created.length === 0);
    const ctl2 = new AbortController();
    const { up: u2, f: f2 } = mk([hang]);
    const pr = u2.upload({ blob: webp(), signal: ctl2.signal });
    await tick(5);
    ctl2.abort();
    const r2 = await settle(pr);
    check('hủy/giữa chừng -> CANCELLED + xhr.abort() được gọi', r2.error?.code === 'CANCELLED' && r2.error.details.kind === 'CANCELLED' && f2.created[0].aborted === true);
    f2.created[0].status = 200; f2.created[0].responseText = asset('late'); f2.created[0].onload?.(); // phản hồi muộn bị bỏ qua
    await tick(20);
    check('hủy/KHÔNG tự upload lại (đúng 1 request)', f2.created.length === 1);
  }

  // ===== Use case: 3 biến thể =====
  {
    const order = [];
    const f = makeFactory([
      (x) => { order.push(['thumb', f.created.length]); x.upload.onprogress({ lengthComputable: true, loaded: 5, total: 10 }); ok('pub-thumb')(x); },
      (x) => { order.push(['medium', f.created.length]); ok('pub-medium')(x); },
      (x) => { order.push(['full', f.created.length]); ok('pub-full')(x); },
    ]);
    const up = createCloudinaryUploader({ cloudName: 'test-cloud', uploadPreset: 'p', createXhr: f });
    const upload3 = createUploadVariantsToCloudinary({ cloudinaryUploader: up });
    const prog = [];
    const r = await settle(upload3({ blobs: { thumbnail: webp(10), medium: webp(30), webp: webp(60) }, onProgress: (p) => prog.push(p) }));
    check('3 biến thể/thành công trả {thumbnail, medium, webp}', r.value && Object.keys(r.value).join() === 'thumbnail,medium,webp' && r.value.medium.publicId === 'pub-medium', JSON.stringify(r.error?.message));
    check('3 biến thể/đúng 3 request, tuần tự thumbnail -> medium -> webp',
      f.created.length === 3 && order.map(([n, c]) => `${n}:${c}`).join() === 'thumb:1,medium:2,full:3', JSON.stringify(order));
    const names = f.created.map((x) => x.form.get('file').name).join();
    check('3 biến thể/tên file multipart thumb.webp, medium.webp, full.webp', names === 'thumb.webp,medium.webp,full.webp', names);
    check('3 biến thể/KHÔNG upload ảnh gốc, không ảnh thứ tư', f.created.length === 3);
    const overall = prog.map((p) => p.overallPercent);
    check('3 biến thể/tiến độ tổng đơn điệu, kết thúc 100', overall.every((v, i) => i === 0 || v >= overall[i - 1]) && overall.at(-1) === 100, JSON.stringify(overall));
    check('3 biến thể/tiến độ có tên biến thể', ['thumbnail', 'medium', 'webp'].every((v) => prog.some((p) => p.variant === v)));
  }
  {
    // Chặn ảnh gốc / thiếu biến thể
    const f = makeFactory([]);
    const upload3 = createUploadVariantsToCloudinary({ cloudinaryUploader: createCloudinaryUploader({ cloudName: 'c', uploadPreset: 'p', createXhr: f }) });
    const withOriginal = await settle(upload3({ blobs: { original: webp(), thumbnail: webp(), medium: webp(), webp: webp() } }));
    check('use case/từ chối ảnh gốc (khóa thừa) -> VALIDATION, không request', withOriginal.error?.code === 'VALIDATION' && /thừa original/.test(withOriginal.error.message) && f.created.length === 0);
    const missing = await settle(upload3({ blobs: { thumbnail: webp(), medium: webp() } }));
    check('use case/thiếu biến thể -> VALIDATION', missing.error?.code === 'VALIDATION' && /thiếu webp/.test(missing.error.message) && f.created.length === 0);
    check('use case/không có blobs -> VALIDATION', (await settle(upload3())).error?.code === 'VALIDATION');
  }

  // ===== Một biến thể thất bại sau khi biến thể khác thành công =====
  {
    const f = makeFactory([ok('pub-thumb'), netErr, ok('never')]);
    const upload3 = createUploadVariantsToCloudinary({ cloudinaryUploader: createCloudinaryUploader({ cloudName: 'c', uploadPreset: 'p', createXhr: f }) });
    const r = await settle(upload3({ blobs: { thumbnail: webp(), medium: webp(), webp: webp() } }));
    const d = r.error?.details;
    check('một phần/lỗi giữ code gốc NETWORK, báo biến thể lỗi', r.error?.code === 'NETWORK' && d.failedVariant === 'medium' && d.kind === 'NETWORK');
    check('một phần/giữ thông tin ảnh đã upload', d.partial === true && Object.keys(d.uploaded).join() === 'thumbnail' && d.uploaded.thumbnail.publicId === 'pub-thumb' && d.orphanedPublicIds.join() === 'pub-thumb');
    check('một phần/biến thể sau không được thử (2 request)', d.notAttempted.join() === 'webp' && f.created.length === 2);
    check('một phần/thông báo nêu rõ ảnh đã upload KHÔNG bị tự xóa', /KHÔNG bị tự xóa/.test(r.error.message) && !/thành công/i.test(r.error.message));
    check('một phần/không phải kết quả thành công', r.value === undefined);
    // không có thao tác xóa/confirm nào: chỉ có đúng các request upload tới endpoint upload
    check('một phần/mọi request chỉ tới /image/upload (không destroy/confirm)', f.created.every((x) => x.url.endsWith('/image/upload') && x.method === 'POST'));

    const f1 = makeFactory([http(400, JSON.stringify({ error: { message: 'bad' } }))]);
    const r1 = await settle(createUploadVariantsToCloudinary({ cloudinaryUploader: createCloudinaryUploader({ cloudName: 'c', uploadPreset: 'p', createXhr: f1 }) })({ blobs: { thumbnail: webp(), medium: webp(), webp: webp() } }));
    check('lỗi ở biến thể đầu -> partial=false, không có ảnh mồ côi', r1.error?.details.partial === false && r1.error.details.orphanedPublicIds.length === 0 && f1.created.length === 1);

    const f3 = makeFactory([ok('t'), ok('m'), http(500, 'x')]);
    const r3 = await settle(createUploadVariantsToCloudinary({ cloudinaryUploader: createCloudinaryUploader({ cloudName: 'c', uploadPreset: 'p', createXhr: f3 }) })({ blobs: { thumbnail: webp(), medium: webp(), webp: webp() } }));
    check('lỗi ở biến thể cuối -> 2 ảnh mồ côi được liệt kê', r3.error?.details.orphanedPublicIds.join() === 't,m' && r3.error.details.failedVariant === 'webp');
  }

  // ===== Hủy trong use case =====
  {
    const ctl = new AbortController();
    const f = makeFactory([ok('a'), hang, ok('never')]);
    const upload3 = createUploadVariantsToCloudinary({ cloudinaryUploader: createCloudinaryUploader({ cloudName: 'c', uploadPreset: 'p', createXhr: f }) });
    const pr = settle(upload3({ blobs: { thumbnail: webp(), medium: webp(), webp: webp() }, signal: ctl.signal }));
    await tick(10);
    ctl.abort();
    const r = await pr;
    check('hủy giữa chừng use case -> CANCELLED, giữ ảnh đã upload, không thử tiếp', r.error?.code === 'CANCELLED' && r.error.details.uploaded.thumbnail?.publicId === 'a' && f.created.length === 2);

    const ctl2 = new AbortController();
    const f2 = makeFactory([(x) => { ok('a')(x); ctl2.abort(); }, ok('never')]);
    const up2 = createUploadVariantsToCloudinary({ cloudinaryUploader: createCloudinaryUploader({ cloudName: 'c', uploadPreset: 'p', createXhr: f2 }) });
    const r2 = await settle(up2({ blobs: { thumbnail: webp(), medium: webp(), webp: webp() }, signal: ctl2.signal }));
    check('hủy giữa hai lần upload -> không bắt đầu file kế tiếp', r2.error?.code === 'CANCELLED' && f2.created.length === 1);
  }

  // ===== Composition root =====
  {
    const svc = createCloudinaryServices({ config: { cloudName: '', uploadPreset: '', missing: ['VITE_CLOUDINARY_CLOUD_NAME', 'VITE_CLOUDINARY_UPLOAD_PRESET'] } });
    check('composition/thiếu cấu hình -> configured=false, không sập', svc.configured === false && svc.missing.length === 2);
    const r = await settle(svc.useCases.uploadVariantsToCloudinary({ blobs: { thumbnail: webp(), medium: webp(), webp: webp() } }));
    check('composition/thiếu cấu hình -> upload báo CONFIG rõ ràng', r.error?.code === 'CONFIG' && /VITE_CLOUDINARY_CLOUD_NAME/.test(r.error.message));
    const f = makeFactory([ok('1'), ok('2'), ok('3')]);
    const ok3 = createCloudinaryServices({ config: { cloudName: 'c', uploadPreset: 'p', missing: [] }, uploaderOptions: { createXhr: f } });
    const r3 = await settle(ok3.useCases.uploadVariantsToCloudinary({ blobs: { thumbnail: webp(), medium: webp(), webp: webp() } }));
    check('composition/đủ cấu hình -> upload 3 biến thể', ok3.configured && r3.value?.webp.publicId === '3');
  }
} finally {
  await server.close();
}

// ===== Quét mã nguồn =====
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');
const files = ['src/infrastructure/cloudinary/cloudinaryUploader.js', 'src/infrastructure/cloudinary/cloudinaryConfig.js',
  'src/application/usecases/uploadVariantsToCloudinary.js', 'src/app/createCloudinaryServices.js'];
const strip = (s) => s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');
for (const f of files) {
  const code = strip(read(f));
  check(`mã nguồn ${path.basename(f)}/không console.*`, !/console\./.test(code));
  check(`mã nguồn ${path.basename(f)}/không import firebase`, !/from ['"](firebase|@firebase)/.test(code));
  check(`mã nguồn ${path.basename(f)}/không secret/chữ ký/token`, !/api_secret|api_key|signature|Authorization|getIdToken|setRequestHeader|localStorage|sessionStorage/i.test(code));
}
const up = strip(read(files[0]));
check('mã nguồn uploader/chỉ append đúng 2 trường', (up.match(/\.append\(/g) || []).length === 2);
const allSrc = [];
(function walk(d) { for (const n of fs.readdirSync(d)) { const p = path.join(d, n); fs.statSync(p).isDirectory() ? walk(p) : /\.(js|jsx)$/.test(n) && allSrc.push(p); } })(path.join(root, 'src'));
// Giá trị Cloudinary thật KHÔNG hardcode trong test: lấy từ biến môi trường của người chạy (nếu có).
// Ngoài ra luôn kiểm tra theo cấu trúc: không URL Cloudinary nào trong mã (đã bỏ chú thích) mang cloud name viết thẳng.
const realValues = [process.env.SMOKE_REAL_CLOUD_NAME, process.env.SMOKE_REAL_UPLOAD_PRESET].map((v) => v?.trim()).filter(Boolean);
const literalCloudUrl = /cloudinary\.com\/(?!v1_1\/\$\{|\$\{)[A-Za-z0-9_-]+/;
check('không hardcode cloud name / preset thật trong src', allSrc.every((p) => {
  const raw = fs.readFileSync(p, 'utf8');
  return !realValues.some((v) => raw.includes(v)) && !literalCloudUrl.test(strip(raw));
}));

console.log(`PASSED: ${passed}`);
console.log(`FAILED: ${failures.length}`);
failures.forEach((f) => console.log('  ✗ ' + f));
if (!realValues.length) console.log('NOTE: chưa đặt SMOKE_REAL_CLOUD_NAME/SMOKE_REAL_UPLOAD_PRESET -> chỉ kiểm tra "không hardcode" theo cấu trúc URL, chưa so với giá trị thật.');
process.exit(failures.length ? 1 : 0);
