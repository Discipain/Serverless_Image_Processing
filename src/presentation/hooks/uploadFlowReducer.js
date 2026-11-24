// Presentation — reducer THUẦN cho trạng thái giao diện upload (không import React; kiểm thử được bằng Node).
//
// phase: 'idle' | 'running' | 'done' | 'error'
// stage (khi running): 'VALIDATING' | 'COMPRESSING' | 'UPLOADING' | 'CONFIRMING'  (luồng REAL của H4B-4 có thêm 'AUTHORIZING' sau COMPRESSING)
// 'done' chỉ được đặt từ action DONE, tức là SAU KHI use case báo bước confirm thành công hợp lệ.

export const initialUploadState = Object.freeze({
  phase: 'idle',
  stage: null,
  fileName: null,
  fileSize: null, // dung lượng ảnh gốc (byte) của file được chọn
  variants: null, // { thumbnail|medium|webp: {bytes, width, height} } sau khi nén (luồng REAL báo qua onStage)
  imageId: null,
  progress: null, // { variant, variantPercent, overallPercent }
  result: null,
  error: null, // view model của lỗi, xem toErrorView
});

/**
 * Chuyển lỗi của use case thành view model gọn cho giao diện. KHÔNG giữ session, Blob, file, cause hay bất kỳ trường ký nào.
 * `retryAfterSeconds` (từ Retry-After của Backend) được đổi thành `retryNotBefore` (mốc thời gian, ms) để giao diện đếm ngược.
 */
export function toErrorView(error, { now = Date.now() } = {}) {
  const d = error?.details ?? {};
  const wait = Number.isInteger(d.retryAfterSeconds) && d.retryAfterSeconds > 0 ? d.retryAfterSeconds : null;
  return {
    newSessionRequired: d.newSessionRequired === true,
    restartable: d.newSessionRequired === true && Boolean(d.restartFile),
    retryAfterSeconds: wait,
    retryNotBefore: wait === null ? null : now + wait * 1000,
    message: error?.message || 'Đã xảy ra lỗi không xác định.',
    code: error?.code ?? 'UNKNOWN',
    kind: d.kind ?? null,
    stage: d.stage ?? null,
    imageId: d.imageId ?? null,
    retryable: d.retryable === true && Boolean(d.session),
    uploadedVariants: Array.isArray(d.uploadedVariants) ? d.uploadedVariants : [],
  };
}

export function uploadFlowReducer(state, action) {
  switch (action.type) {
    case 'START':
      return { ...initialUploadState, phase: 'running', stage: 'VALIDATING', fileName: action.fileName ?? null, fileSize: Number.isFinite(action.fileSize) ? action.fileSize : null };
    case 'RESUME':
      // Thử lại: giữ nguyên fileName và imageId.
      return { ...state, phase: 'running', error: null, progress: null, result: null };
    case 'STAGE':
      return {
        ...state,
        phase: 'running',
        stage: action.stage,
        imageId: action.imageId ?? state.imageId,
        variants: action.variants ?? state.variants,
        progress: action.stage === 'UPLOADING' ? { variant: null, variantPercent: 0, overallPercent: 0 } : state.progress,
      };
    case 'PROGRESS':
      return {
        ...state,
        progress: { variant: action.variant, variantPercent: action.variantPercent, overallPercent: action.overallPercent },
      };
    case 'DONE':
      return { ...state, phase: 'done', stage: null, progress: null, result: action.result, error: null, imageId: action.result?.imageId ?? state.imageId };
    case 'FAILED':
      return { ...state, phase: 'error', stage: null, progress: null, result: null, error: action.error, imageId: action.error?.imageId ?? state.imageId };
    case 'RESET':
      return initialUploadState;
    default:
      return state;
  }
}
