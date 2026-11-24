// Công cụ dùng chung cho smoke test H4B-4 (Signed Upload): Backend GIẢ mô phỏng ngữ nghĩa của Backend 30318ee
// (authorize + confirm signed, grant, idempotency, Retry-After), Cloudinary GIẢ qua XMLHttpRequest giả, auth giả.
// Không có mạng thật. Mật khẩu/chữ ký ở đây đều là chuỗi giả.
import crypto from 'node:crypto';

export const CLOUD = 'demo-cloud';
export const API_KEY = '123456789012345';
export const UUID = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
export const webp = (n) => new Blob([new Uint8Array(n)], { type: 'image/webp' });
export const jpeg = (over = {}) => ({ name: 'anh-bien.jpg', type: 'image/jpeg', size: 2_000_000, ...over });
export const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));
export const settle = async (p) => {
  try {
    return { value: await p };
  } catch (error) {
    return { error };
  }
};

export const SIZES = { thumbnail: { w: 200, h: 150, b: 1000 }, medium: { w: 800, h: 600, b: 20000 }, webp: { w: 4000, h: 3000, b: 300000 } };
const SUFFIX = { thumbnail: 'thumb', medium: 'medium', webp: 'full' };
const VARIANTS = ['thumbnail', 'medium', 'webp'];

export function fakeProcessor({ fail, stats = true } = {}) {
  const calls = [];
  return {
    calls,
    async process(file) {
      calls.push(file.name);
      if (fail) {
        const f = fail(calls.length);
        if (f) throw Object.assign(new Error('nén lỗi'), { errorReason: f });
      }
      const result = {
        blobs: { thumbnail: webp(SIZES.thumbnail.b), medium: webp(SIZES.medium.b), webp: webp(SIZES.webp.b) },
        width: 4000,
        height: 3000,
        processingMs: 321,
      };
      if (stats) {
        result.stats = { variants: Object.fromEntries(VARIANTS.map((k) => [k, { width: SIZES[k].w, height: SIZES[k].h, bytes: SIZES[k].b }])) };
      }
      return result;
    },
  };
}

export function counterIds() {
  let n = 0;
  const f = () => UUID(++n);
  f.count = () => n;
  return f;
}

// ---------- auth giả ----------
export function createFakeAuth(uid) {
  const listeners = new Set();
  const auth = {
    uid,
    set(next) {
      auth.uid = next;
      for (const l of [...listeners]) l(next ? { uid: next } : null);
    },
    observe(onChange) {
      listeners.add(onChange);
      Promise.resolve().then(() => {
        if (listeners.has(onChange)) onChange(auth.uid ? { uid: auth.uid } : null);
      });
      return () => listeners.delete(onChange);
    },
    listenerCount: () => listeners.size,
  };
  return auth;
}

// ---------- Cloudinary giả (XMLHttpRequest) ----------
export function createFakeCloud({ cloudName = CLOUD, clock }) {
  const assets = new Map();
  const sent = []; // mỗi lần send: { endpoint, entries, headers, withCredentials, publicId, aborted }
  const plan = []; // hàng đợi lỗi/biến đổi: { match?, status?, body?, network?, timeout?, delayMs?, mutate?, drop? }
  let version = 1_790_000_000;
  let counter = 0;
  const cloud = { assets, sent, plan, openCount: 0 };

  const dimsFor = (publicId) => {
    const variant = VARIANTS.find((k) => publicId.endsWith(`/${SUFFIX[k]}`));
    return SIZES[variant];
  };
  const urlFor = (publicId, v) => `https://res.cloudinary.com/${cloudName}/image/upload/v${v}/${publicId}.webp`;

  cloud.newXhr = () => {
    cloud.openCount += 1;
    const xhr = {
      upload: {},
      withCredentials: false,
      timeout: 0,
      headers: {},
      status: 0,
      responseText: '',
      aborted: false,
      open(method, url) {
        xhr.method = method;
        xhr.url = url;
      },
      setRequestHeader(k, v) {
        xhr.headers[k] = v;
      },
      abort() {
        xhr.aborted = true;
        clearTimeout(xhr.timer);
        xhr.onabort?.();
      },
      send(form) {
        const entries = [...form.entries()];
        const publicId = entries.find(([k]) => k === 'public_id')?.[1];
        const file = entries.find(([k]) => k === 'file')?.[1];
        const record = { endpoint: xhr.url, method: xhr.method, entries, headers: xhr.headers, withCredentials: xhr.withCredentials, publicId, fileSize: file?.size, xhr, aborted: false };
        sent.push(record);
        const idx = plan.findIndex((p) => !p.match || p.match(record));
        const step = idx >= 0 ? plan.splice(idx, 1)[0] : {};
        xhr.timer = setTimeout(async () => {
          if (xhr.aborted) return;
          record.reached = true; // yêu cầu "tới" Cloudinary dù trình duyệt có thể đã hủy sau đó
          if (step.network) return xhr.onerror?.();
          if (step.timeout) return xhr.ontimeout?.();
          if (step.hang) return;
          xhr.upload.onprogress?.({ lengthComputable: true, loaded: file.size / 2, total: file.size });
          if (step.status) {
            xhr.status = step.status;
            xhr.responseText = typeof step.body === 'string' ? step.body : JSON.stringify(step.body ?? {});
            return xhr.onload?.();
          }
          const overwrite = entries.find(([k]) => k === 'overwrite')?.[1];
          let asset = assets.get(publicId);
          let existing = false;
          if (asset && overwrite === 'false') existing = true;
          else {
            const d = dimsFor(publicId);
            counter += 1;
            version += 1;
            asset = { publicId, bytes: file.size, width: d.w, height: d.h, version, assetId: crypto.createHash('md5').update(`${publicId}${counter}`).digest('hex'), createdAtMs: clock.now };
            assets.set(publicId, asset);
            await cloud.onStore?.(asset); // điểm móc cho test tích hợp: báo asset mới cho Admin API giả
          }
          let body = {
            public_id: asset.publicId,
            resource_type: 'image',
            type: 'upload',
            format: 'webp',
            bytes: asset.bytes,
            width: asset.width,
            height: asset.height,
            version: asset.version,
            asset_id: asset.assetId,
            secure_url: urlFor(asset.publicId, asset.version),
          };
          if (existing) body.existing = true;
          if (step.mutate) body = step.mutate(body);
          xhr.status = 200;
          xhr.responseText = JSON.stringify(body);
          xhr.onload?.();
        }, step.delayMs ?? 0);
      },
    };
    return xhr;
  };
  cloud.reset = () => {
    assets.clear();
    sent.length = 0;
    plan.length = 0;
  };
  return cloud;
}

// ---------- Backend giả (fetch) ----------
export function createFakeBackend({ clock, cloud, cloudName = CLOUD, env = 'dev', ttlMs = 900_000 }) {
  const grants = new Map();
  const images = new Map();
  const log = [];
  const faults = { authorize: [], confirm: [] };
  const backend = { grants, images, log, faults };

  const reply = (status, body, headers = {}) => ({
    status,
    headers: { get: (name) => headers[Object.keys(headers).find((k) => k.toLowerCase() === String(name).toLowerCase())] ?? null },
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  });
  const err = (status, detail, headers) => reply(status, { detail }, headers);
  const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, 'Z');
  const sameJson = (a, b) => JSON.stringify(a) === JSON.stringify(b);

  const publicIds = (imageId) => Object.fromEntries(VARIANTS.map((k) => [k, `hybrid/${env}/${imageId}/${SUFFIX[k]}`]));

  function authorize(uid, body) {
    const TOP = ['imageId', 'originalSize', 'variants', 'fileName', 'width', 'height'];
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => !TOP.includes(k))) return err(400, 'Unknown field');
    if (typeof body.imageId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(body.imageId)) return err(400, 'Invalid imageId');
    if (!Number.isInteger(body.originalSize) || body.originalSize < 1 || body.originalSize > 10 * 1024 * 1024) return err(400, 'Invalid originalSize');
    const v = body.variants;
    if (!v || Object.keys(v).length !== 3 || VARIANTS.some((k) => !v[k] || Object.keys(v[k]).sort().join() !== 'bytes,height,width')) return err(400, 'Invalid variants');
    const cap = { thumbnail: 200, medium: 800, webp: 65535 };
    for (const k of VARIANTS) if (Math.max(v[k].width, v[k].height) > cap[k]) return err(400, `Invalid variant ${k} size`);
    const declared = { fileName: body.fileName ?? null, originalSize: body.originalSize, width: body.width ?? null, height: body.height ?? null, variants: v };
    let grant = grants.get(body.imageId);
    if (grant) {
      if (grant.ownerId !== uid) return err(403, 'Forbidden');
      if (clock.now >= grant.expiresAtMs) return err(409, 'Upload grant expired');
      if (grant.status !== 'ISSUED') return err(409, 'Upload grant is not active');
      if (!sameJson(grant.declared, declared)) return err(409, 'Upload parameters differ from the existing grant');
    } else {
      grant = { imageId: body.imageId, ownerId: uid, status: 'ISSUED', declared, issuedAtMs: clock.now, expiresAtMs: clock.now + ttlMs, publicIds: publicIds(body.imageId) };
      grants.set(body.imageId, grant);
    }
    const ts = String(Math.floor(clock.now / 1000));
    const uploads = {};
    for (const k of VARIANTS) {
      const fields = {
        public_id: grant.publicIds[k],
        timestamp: ts,
        overwrite: 'false',
        allowed_formats: 'webp',
        context: `app=hybrid|imageId=${grant.imageId}|variant=${k}`,
        tags: `hybrid,${env}`,
        api_key: API_KEY,
      };
      fields.signature = crypto.createHash('sha256').update(JSON.stringify(fields) + 'fake-secret-not-real').digest('hex');
      uploads[k] = { fields };
    }
    return reply(200, { imageId: grant.imageId, expiresAt: iso(grant.expiresAtMs), uploadUrl: `https://api.cloudinary.com/v1_1/${cloudName}/image/upload`, apiKey: API_KEY, uploads });
  }

  function confirm(uid, body) {
    const ALL = ['imageId', 'thumbnail', 'medium', 'webp', 'originalSize', 'processingMs', 'fileName', 'width', 'height', 'thumbnailId', 'mediumId', 'webpId', 'processedSize'];
    if (!body || typeof body !== 'object' || Object.keys(body).some((k) => !ALL.includes(k))) return err(400, 'Unknown field');
    for (const k of ['imageId', 'thumbnail', 'medium', 'webp', 'originalSize', 'processingMs']) if (body[k] === undefined) return err(400, `Missing field: ${k}`);
    const grant = grants.get(body.imageId);
    if (!grant) return err(403, 'Upload authorization required');
    if (grant.ownerId !== uid) return err(403, 'Forbidden');
    const versions = {};
    for (const k of VARIANTS) {
      const m = new RegExp(`^https://res\\.cloudinary\\.com/${cloudName}/image/upload/v(\\d+)/(.+)\\.webp$`).exec(body[k]);
      if (!m || m[2] !== grant.publicIds[k]) return err(400, 'Invalid cloudinary url');
      versions[k] = Number(m[1]);
      if (body[`${k}Id`] !== undefined && body[`${k}Id`] !== grant.publicIds[k]) return err(400, 'Invalid thumbnailId');
    }
    const d = grant.declared;
    if (body.originalSize !== d.originalSize) return err(409, 'Confirm parameters differ from the upload grant');
    if ((body.width !== undefined && body.width !== d.width) || (body.height !== undefined && body.height !== d.height)) return err(409, 'Confirm parameters differ from the upload grant');
    if (body.fileName !== undefined && body.fileName !== d.fileName) return err(409, 'Confirm parameters differ from the upload grant');
    if (grant.status === 'CONFIRMED') {
      if (body.processedSize !== undefined && body.processedSize !== grant.result.processedSize) return err(409, 'Confirm parameters differ from the upload grant');
      return reply(200, grant.result.response);
    }
    if (clock.now >= grant.expiresAtMs) return err(409, 'Upload grant expired');
    const found = VARIANTS.map((k) => cloud.assets.get(grant.publicIds[k]));
    if (found.some((a) => !a)) return err(409, 'Uploaded assets not found');
    for (const [i, k] of VARIANTS.entries()) {
      const a = found[i];
      const dv = d.variants[k];
      if (a.bytes !== dv.bytes || a.width !== dv.width || a.height !== dv.height || a.version !== versions[k]) return err(409, 'Uploaded assets do not match the upload grant');
      if (a.createdAtMs < grant.issuedAtMs - 120_000) return err(409, 'Uploaded assets do not match the upload grant');
    }
    const webpBytes = found[2].bytes;
    if (body.processedSize !== undefined && body.processedSize !== webpBytes) return err(409, 'Confirm parameters differ from the upload grant');
    const variants = {};
    for (const [i, k] of VARIANTS.entries()) {
      variants[k] = `https://res.cloudinary.com/${cloudName}/image/upload/v${found[i].version}/${grant.publicIds[k]}.webp`;
      variants[`${k}Id`] = grant.publicIds[k];
    }
    const response = { imageId: grant.imageId, status: 'DONE', ownerId: uid, variants, processingMs: body.processingMs, savedPercent: Math.round((1 - webpBytes / d.originalSize) * 1000) / 10 };
    grant.status = 'CONFIRMED';
    grant.result = { response, processedSize: webpBytes };
    images.set(grant.imageId, { ownerId: uid, status: 'DONE' });
    return reply(200, response);
  }

  backend.fetch = async (url, init = {}) => {
    const u = new URL(url);
    const entry = { method: init.method, path: u.pathname, headers: init.headers, credentials: init.credentials, body: init.body ? JSON.parse(init.body) : undefined, url: String(url) };
    log.push(entry);
    const m = /^Bearer token-([a-z0-9]+)(?:\.r\d+)?$/.exec(init.headers?.Authorization ?? '');
    if (!m) return err(401, 'Invalid token');
    const uid = m[1];
    const endpoint = u.pathname === '/images/cloudinary/authorize' ? 'authorize' : u.pathname === '/images/cloudinary/confirm' ? 'confirm' : null;
    if (!endpoint || init.method !== 'POST') return err(404, 'Not Found');
    const fault = faults[endpoint].shift();
    if (fault && !fault.afterCommit) return err(fault.status, fault.detail, fault.headers);
    const response = endpoint === 'authorize' ? authorize(uid, entry.body) : confirm(uid, entry.body);
    if (fault?.afterCommit) {
      if (fault.drop) throw new TypeError('network error');
      return err(fault.status, fault.detail, fault.headers);
    }
    return response;
  };
  return backend;
}
