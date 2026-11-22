// INFRASTRUCTURE — sinh imageId (UUID v4) cho port `generateId`. Không phụ thuộc Firebase.
// Chỉ dùng bộ sinh số ngẫu nhiên an toàn của trình duyệt (Web Crypto); KHÔNG rơi về Math.random
// vì imageId là một phần đường dẫn Storage và khóa document.

/** Tạo hàm sinh UUID v4 từ một đối tượng crypto (mặc định là globalThis.crypto; truyền vào để kiểm thử). */
export function createGenerateId(cryptoImpl = globalThis.crypto) {
  return function generateId() {
    // randomUUID chỉ có trong secure context (HTTPS hoặc localhost).
    if (typeof cryptoImpl?.randomUUID === 'function') {
      return cryptoImpl.randomUUID();
    }
    if (typeof cryptoImpl?.getRandomValues === 'function') {
      const bytes = cryptoImpl.getRandomValues(new Uint8Array(16));
      bytes[6] = (bytes[6] & 0x0f) | 0x40; // phiên bản 4
      bytes[8] = (bytes[8] & 0x3f) | 0x80; // biến thể RFC 4122
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
    throw new Error('Trình duyệt không hỗ trợ Web Crypto nên không thể tạo imageId an toàn.');
  };
}

export const generateId = createGenerateId();
