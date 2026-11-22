// DOMAIN — JavaScript thuần: không import React, Firebase hay lớp khác.

// Vòng đời trạng thái ảnh (quyết định của nhóm trưởng):
//   PENDING    : đã có bản ghi, đang nén ảnh ở trình duyệt
//   PROCESSING : nén xong, đang upload các file lên Storage
//   DONE       : upload đủ file + ghi đủ metadata
//   FAILED     : lỗi (kèm errorReason), có thể retry
//
// LƯU Ý: SCHEMA.md hiện CHƯA liệt kê PROCESSING (và còn ghi PENDING -> DONE).
// Chờ nhóm cập nhật SCHEMA.md và Rules trước khi ghi PROCESSING lên Firestore thật.
export const IMAGE_STATUS = Object.freeze({
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  DONE: 'DONE',
  FAILED: 'FAILED',
});

// Lý do lỗi (trường `errorReason`, chỉ ghi khi status = FAILED).
// INVALID_IMAGE, TOO_LARGE, COMPRESS_FAIL theo SCHEMA.md.
// UPLOAD_FAIL (upload Storage / ghi metadata thất bại, PROCESSING -> FAILED) là giá trị MỚI,
// CHƯA có trong SCHEMA.md — đã được thống nhất thêm, chờ nhóm trưởng cập nhật tài liệu và Rules.
export const ERROR_REASON = Object.freeze({
  INVALID_IMAGE: 'INVALID_IMAGE',
  TOO_LARGE: 'TOO_LARGE',
  COMPRESS_FAIL: 'COMPRESS_FAIL',
  UPLOAD_FAIL: 'UPLOAD_FAIL',
});
