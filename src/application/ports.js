// APPLICATION — hợp đồng giữa Application và Infrastructure, chỉ là JSDoc (không có mã chạy).
//
// Infrastructure (Bước E) cài các "port" này: bản MOCK và bản Firebase phải trả về CÙNG hình dạng.
// Application nhận chúng qua tham số (Dependency Injection), không bao giờ import adapter hay Firebase SDK.
//
// Quy ước chung:
//  - Adapter tự lo timestamp: createdAt/updatedAt do repository gán (Firestore: serverTimestamp()).
//  - Trong bản cập nhật (patch), giá trị `null` nghĩa là XÓA trường đó (Firestore: deleteField()).
//  - Lỗi của SDK phải được adapter chuyển thành Error có `code` thuộc ERROR_CODE (application/errors.js), kèm
//    `originalCode` (mã gốc của SDK) và `cause` (lỗi gốc). Bảng ánh xạ: infrastructure/firebase/mapFirebaseError.js.
//    Mã adapter: NOT_FOUND, PERMISSION_DENIED, UNAUTHENTICATED, STATUS_CONFLICT, NETWORK, CANCELLED, POPUP_BLOCKED,
//    QUOTA_EXCEEDED, CONFIG, UNKNOWN. PERMISSION_DENIED KHÔNG BAO GIỜ được đổi thành NOT_FOUND (hay ngược lại).

/**
 * @typedef {Object} AuthUser
 * @property {string} uid
 * @property {string|null} displayName
 * @property {string|null} email
 */

/**
 * @typedef {Object} AuthRepository
 * @property {() => Promise<AuthUser>} signInWithGoogle
 *   Người dùng đóng popup: reject Error có `code: 'CANCELLED'` (không phải lỗi đăng nhập thật).
 *   Trình duyệt chặn popup: `code: 'POPUP_BLOCKED'`. Mất mạng: 'NETWORK'. Provider/domain chưa được bật hoặc
 *   môi trường không hỗ trợ popup: 'CONFIG'. Tài khoản bị vô hiệu hóa: 'PERMISSION_DENIED'.
 * @property {() => Promise<void>} signOut
 *   Lỗi SDK được map như trên (thường là 'NETWORK').
 * @property {(onChange: (user: AuthUser|null) => void, onError?: (error: Error) => void) => (() => void)} onAuthChanged
 *   Gọi onChange khi đã biết trạng thái đăng nhập (và mỗi lần đổi); trả về hàm hủy đăng ký, gọi nhiều lần an toàn.
 *   `onError` là tham số TÙY CHỌN dành cho lỗi của listener (đã map). Từ H1, Application (observeAuthState)
 *   truyền nó xuống để Presentation hiển thị lỗi; khi không có `onError`, adapter Firebase không biến lỗi thành
 *   "đã đăng xuất" mà giữ nguyên trạng thái.
 * @property {(forceRefresh?: boolean) => Promise<string>} getIdToken
 *   Trả về Firebase ID token THẬT của người dùng đang đăng nhập (chuỗi JWT). Chỉ gọi khi người dùng chủ động yêu cầu;
 *   KHÔNG được ghi log, lưu vào storage hay đưa vào URL. `forceRefresh = true` ép làm mới token.
 *   Chưa đăng nhập -> reject Error `code: 'UNAUTHENTICATED'`. Adapter MOCK KHÔNG có token thật: reject
 *   `code: 'UNAUTHENTICATED'` với `details.mock = true` (không bao giờ tạo token giả). Lỗi mạng: 'NETWORK'.
 */

/**
 * Document `images/{imageId}` theo SCHEMA.md (trường phẳng). Xem domain/models/image.js.
 * @typedef {Object} ImageDoc
 * @property {string} imageId
 * @property {string} ownerId
 * @property {'PENDING'|'PROCESSING'|'DONE'|'FAILED'} status
 * @property {string} originalPath
 * @property {number} originalSize
 * @property {{thumbnail: string, medium: string, webp: string}} [variants]  Đường dẫn Storage, không phải URL
 * @property {number} [processedSize]
 * @property {number} [originalWidth]
 * @property {number} [originalHeight]
 * @property {number} [processingMs]
 * @property {string|null} [errorReason]
 * @property {number} retryCount
 * @property {*} createdAt
 * @property {*} updatedAt
 */

/**
 * @typedef {Object} ImageRepository
 * @property {(doc: Omit<ImageDoc,'createdAt'|'updatedAt'>) => Promise<void>} create
 *   Ghi document với id = doc.imageId; reject nếu id đã tồn tại. Repository gán createdAt/updatedAt.
 * @property {(imageId: string) => Promise<ImageDoc|null>} get
 *   Trả null nếu không tồn tại (hoặc không đọc được vì không phải chủ sở hữu).
 * @property {(query: {ownerId: string, limit: number, cursor?: *}) => Promise<{items: ImageDoc[], nextCursor: *|null}>} list
 *   where ownerId == ..., orderBy createdAt desc, limit. `cursor` là giá trị mờ (opaque) do chính repository trả về.
 * @property {(query: {ownerId: string, limit: number}, onData: (items: ImageDoc[]) => void, onError: (error: Error) => void) => (() => void)} subscribe
 *   Realtime (onSnapshot). Phải trả về hàm hủy listener.
 * @property {(imageId: string, change: {from: string, to: string, patch: Object}) => Promise<void>} transition
 *   COMPARE-AND-SET: chỉ ghi khi status hiện tại == `from` (Firestore: runTransaction).
 *   Ghi `{...patch, status: to}` + updatedAt. Reject Error `code: 'STATUS_CONFLICT'` nếu status khác `from`,
 *   `code: 'NOT_FOUND'` nếu document không tồn tại.
 * @property {(imageId: string) => Promise<void>} remove
 *   Xóa document; không tồn tại thì coi như thành công.
 */

/**
 * @typedef {Object} StorageRepository
 * @property {(args: {path: string, blob: Blob, contentType: string, onProgress?: (bytesTransferred: number, totalBytes: number) => void}) => Promise<void>} upload
 *   Ghi đè nếu path đã tồn tại (retry không tạo object trùng).
 * @property {(path: string) => Promise<string>} getDownloadUrl
 * @property {(path: string) => Promise<Blob>} download
 *   Reject nếu object không tồn tại.
 * @property {(path: string) => Promise<void>} remove
 *   Object không tồn tại (storage/object-not-found) PHẢI coi là thành công.
 */

/**
 * @typedef {Object} ProcessedImage
 * @property {{thumbnail: Blob, medium: Blob, webp: Blob}} blobs  WebP; kích thước theo IMAGE_VARIANTS
 * @property {number} width   Chiều rộng ảnh gốc (px)
 * @property {number} height  Chiều cao ảnh gốc (px)
 * @property {number} processingMs
 */

/**
 * @typedef {Object} ImageProcessor
 * @property {(source: Blob) => Promise<ProcessedImage>} process
 *   Giải mã + nén ở trình duyệt. Lỗi phải kèm `errorReason`: 'INVALID_IMAGE' (không giải mã được,
 *   vd file giả đổi đuôi) hoặc 'COMPRESS_FAIL'.
 */

/**
 * Kết quả upload MỘT ảnh lên Cloudinary, chỉ lấy từ response của Cloudinary (không tự dựng URL/public_id).
 * @typedef {Object} CloudinaryAsset
 * @property {string} secureUrl     secure_url (https)
 * @property {string} publicId      public_id (Backend cần để xác minh quyền sở hữu và xóa ảnh sau này)
 * @property {'image'} resourceType resource_type
 * @property {string|null} format   vd 'webp'
 * @property {number|null} bytes
 * @property {number|null} width
 * @property {number|null} height
 * @property {string|null} assetId
 * @property {number} [version]    chỉ có ở uploader CÓ CHỮ KÝ (H4B-4): số phiên bản Cloudinary đã được kiểm tra
 * @property {boolean} [existing]  chỉ có ở uploader CÓ CHỮ KÝ: true khi Cloudinary báo asset đã tồn tại (overwrite=false), KHÔNG phải upload mới
 */

/**
 * @typedef {Object} CloudinaryUploader
 * @property {(args: {blob: Blob, variant?: 'thumbnail'|'medium'|'webp', onProgress?: (percent: number) => void, signal?: AbortSignal}) => Promise<CloudinaryAsset>} upload
 *   UNSIGNED upload một Blob image/webp. Chỉ gửi `file` + `upload_preset`. Tiến độ 0-100 (100 chỉ khi đã thành công).
 *   Lỗi có `code` thuộc ERROR_CODE và `details.kind` (infrastructure/cloudinary/cloudinaryUploader.js UPLOAD_ERROR_KIND):
 *   CONFIG (thiếu cấu hình), VALIDATION/INVALID_INPUT (Blob sai), NETWORK/NETWORK, NETWORK/TIMEOUT, CANCELLED,
 *   UPLOAD_FAILED/CLOUDINARY_REJECTED (HTTP lỗi; 420/429 -> QUOTA_EXCEEDED), UPLOAD_FAILED/INVALID_RESPONSE.
 *   KHÔNG tự retry; sau khi hủy thì không tự upload lại; không xóa gì trên Cloudinary.
 */

/**
 * Uploader CÓ CHỮ KÝ (H4B-4, infrastructure/cloudinary/signedCloudinaryUploader.js). Chưa được nối vào ứng dụng (H4B-5).
 * @typedef {Object} SignedCloudinaryUploader
 * @property {(args: {blob: Blob, variant: 'thumbnail'|'medium'|'webp', uploadUrl: string, fields: Record<string, string>, expected: {bytes: number, width: number, height: number}, onProgress?: (percent: number) => void, signal?: AbortSignal}) => Promise<CloudinaryAsset>} upload
 *   Gửi ĐÚNG tám trường Backend đã ký (public_id, timestamp, overwrite, allowed_formats, context, tags, api_key, signature) NGUYÊN VĂN + `file`.
 *   KHÔNG gửi upload_preset, KHÔNG gửi Bearer/Authorization, KHÔNG tự đặt/đổi tham số đã ký. Response được đối chiếu với `expected`
 *   (public_id, resource_type, type, format webp, bytes, width, height, version, asset_id, secure_url HTTPS của đúng cloud); lệch => lỗi.
 *   `existing: true` khớp số đo được trả về kèm cờ existing (không phải upload mới); Backend vẫn xác minh ở bước confirm.
 *   Lỗi: như CloudinaryUploader, thêm details.kind SIGNATURE_REJECTED (401/403/chữ ký cũ), UPLOAD_RESPONSE_MISMATCH, EXISTING_ASSET_MISMATCH.
 */

/**
 * Kết quả confirm đã được adapter kiểm tra (status DONE, imageId khớp, đủ 3 URL biến thể).
 * @typedef {Object} ConfirmResult
 * @property {string} imageId
 * @property {'DONE'} status
 * @property {string|null} ownerId
 * @property {{thumbnail: string, medium: string, webp: string, thumbnailId?: string, mediumId?: string, webpId?: string}} variants
 *   3 URL bắt buộc. thumbnailId/mediumId/webpId (public_id Cloudinary) CHỈ có mặt khi Backend trả về; adapter không tự bịa.
 * @property {number|null} processingMs
 * @property {number|null} savedPercent
 *   null khi Backend không trả. Backend dùng originalSize và processedSize (nếu request có gửi) để tính. Với adapter
 *   MOCK đây là giá trị do MOCK tính/mô phỏng, không khẳng định Backend thật làm tròn giống hệt.
 * @property {boolean} isMock   true khi do adapter MOCK tạo ra (KHÔNG phải phản hồi của Backend thật)
 */

/**
 * @typedef {Object} BackendApi
 * @property {(payload: Record<string, string|number>, options?: {signal?: AbortSignal}) => Promise<ConfirmResult>} confirmCloudinaryUpload
 *   POST /images/cloudinary/confirm (CONTRACT Hybrid mục 3). Backend nhận Firebase ID token qua
 *   `Authorization: Bearer <token>` (adapter thật tự lấy token mới ở MỖI request; không dùng X-User-Id).
 *   Payload (CONTRACT 72ee441 + xác nhận của nhóm trưởng Tới, xem domain/models/confirmPayload.js): 6 field bắt buộc
 *   (imageId, thumbnail, medium, webp, originalSize, processingMs) + 7 tùy chọn (fileName, width, height, thumbnailId,
 *   mediumId, webpId, processedSize; gửi PHẲNG và chỉ khi có giá trị hợp lệ; processedSize = tổng kích thước 3 Blob WebP,
 *   khuyến nghị luôn gửi). KHÔNG gửi contentType. Adapter từ chối payload có field ngoài 13 field này.
 *   imageId do FRONTEND tạo bằng crypto.randomUUID() một lần trước khi nén và giữ nguyên khi thử lại confirm (Backend dùng
 *   làm khóa chống trùng: trùng thì trả bản cũ). Port này KHÔNG có API cấp imageId.
 *   Lỗi có `code` thuộc ERROR_CODE và `details.kind` (infrastructure/api/backendErrors.js BACKEND_ERROR_KIND):
 *   VALIDATION (400/413/422), UNAUTHENTICATED (401), FORBIDDEN (403), NOT_FOUND (404), QUOTA_EXCEEDED (429),
 *   UNKNOWN/SERVER_ERROR (5xx), NETWORK, NETWORK/TIMEOUT, CANCELLED, CONFIG, UNKNOWN/INVALID_RESPONSE.
 *   `details.retryable` cho biết thử lại xác nhận có hợp lý không. KHÔNG tự retry vô hạn.
 * @property {(payload: object, options?: {signal?: AbortSignal}) => Promise<object>} authorizeCloudinaryUpload
 *   POST /images/cloudinary/authorize (H4B-2; Backend 30318ee). Request: { imageId (UUID v4 chữ thường), originalSize,
 *   variants: {thumbnail|medium|webp: {bytes, width, height}} } + tùy chọn { fileName, width, height }; field lạ => 400. Trả JSON THÔ của 2xx
 *   (imageId, expiresAt, uploadUrl, apiKey, uploads[variant].fields); việc kiểm tra do use case authorizeCloudinaryUpload làm. Lỗi giống confirm;
 *   429/503 có thể mang `details.retryAfterSeconds` (từ header Retry-After dạng số giây). Backend mặc định TẮT tính năng (503 "Signed upload unavailable").
 * @property {(query?: {limit?: number, cursor?: string|null}, options?: {signal?: AbortSignal}) => Promise<GalleryPage>} listImages
 *   GET /images?limit=&cursor= (CONTRACT mục 5). Chỉ gửi limit (1..20) và cursor (nguyên văn `nextCursor` trước đó);
 *   KHÔNG gửi ownerId/uid: Backend lấy uid từ token. Lỗi dùng cùng bộ `code`/`details.kind` như confirm; 400 có
 *   `details.detail` = "Invalid cursor" | "Invalid limit". Response sai cấu trúc => UNKNOWN/INVALID_RESPONSE (không hiển thị một phần).
 * @property {(imageId: string, options?: {signal?: AbortSignal}) => Promise<GalleryImage>} getImage
 *   GET /images/{imageId} (CONTRACT mục 4). 403 ảnh của người khác, 404 không có.
 */

/**
 * Ảnh trong Gallery, đã ánh xạ từ response của Backend (infrastructure/api/galleryMapper.js). KHÔNG chứa field nội bộ của Backend.
 * @typedef {Object} GalleryImage
 * @property {string} imageId
 * @property {'PENDING'|'PROCESSING'|'DONE'|'FAILED'} status
 * @property {string|null} ownerId
 * @property {'cloudinary'|'google_drive'|null} provider
 * @property {string} name  fileName (Cloudinary) hoặc originalName (Drive); thiếu thì dùng imageId
 * @property {string|null} previewUrl  URL https dùng được trong <img>; null với ảnh Drive (đường dẫn tương đối cần Bearer)
 * @property {{thumbnail: string|null, medium: string|null, webp: string|null}} variants  chỉ URL https, còn lại null
 * @property {number|null} originalSize  byte (Cloudinary: original.size; Drive: sizeBytes)
 * @property {number|null} width
 * @property {number|null} height
 * @property {number|null} processedSize
 * @property {number|null} processingMs
 * @property {number|null} savedPercent
 * @property {number|null} retryCount
 * @property {string|null} errorReason
 * @property {Date|null} createdAt  Date UTC; null nếu Backend không gửi/sai định dạng
 * @property {Date|null} updatedAt
 * @property {boolean} createdAtEstimated  true: Drive không cho thời gian dùng được nên Backend dùng giờ đồng bộ
 * @property {boolean} isMock  true khi do adapter MOCK tạo ra
 */

/**
 * @typedef {Object} GalleryPage
 * @property {GalleryImage[]} items  mới nhất trước (thứ tự do Backend quyết định, Frontend không sắp xếp lại)
 * @property {string|null} nextCursor  chuỗi MỜ, truyền lại nguyên văn; null = hết dữ liệu
 * @property {boolean} hasMore  luôn khớp với nextCursor !== null (đã kiểm tra)
 * @property {boolean} isMock
 */

/**
 * @typedef {Object} Adapters
 * @property {AuthRepository} authRepository
 * @property {ImageRepository} imageRepository
 * @property {StorageRepository} storageRepository
 * @property {ImageProcessor} imageProcessor
 * @property {() => string} generateId  UUID v4
 */

export {};
