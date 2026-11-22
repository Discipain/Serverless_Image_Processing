import { useState } from 'react';
import { useAuth } from '../../hooks/useAuth';
import { MockBadge } from '../common/MockBadge';

async function copyToClipboard(text) {
  if (!navigator.clipboard?.writeText) {
    throw new Error('Trình duyệt không hỗ trợ sao chép tự động (cần https hoặc localhost).');
  }
  await navigator.clipboard.writeText(text);
}

// Menu tài khoản: tên/email, UID (sao chép được) và nút sao chép Firebase ID token để thử Postman.
// ID token chỉ được lấy KHI BẤM nút, ghi thẳng vào clipboard, KHÔNG hiển thị, KHÔNG đưa vào state/log/storage/URL.
export function AccountMenu() {
  const { user, isMock, getIdToken } = useAuth();
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState(null); // { ok: boolean, text: string } | null

  if (!user) return null;

  async function handleCopyUid() {
    try {
      await copyToClipboard(user.uid);
      setFeedback({ ok: true, text: 'Đã sao chép UID.' });
    } catch (error) {
      setFeedback({ ok: false, text: error.message || 'Không sao chép được UID.' });
    }
  }

  async function handleCopyToken() {
    setBusy(true);
    setFeedback(null);
    try {
      await copyToClipboard(await getIdToken());
      setFeedback({
        ok: true,
        text: 'Đã sao chép ID token (hết hạn sau khoảng 1 giờ). Dán vào Postman: Authorization → Bearer Token. Không chia sẻ token này.',
      });
    } catch (error) {
      setFeedback({ ok: false, text: error.message || 'Không lấy được ID token.' });
    } finally {
      setBusy(false);
    }
  }

  return (
    <details className="account">
      <summary className="btn btn--ghost account__toggle">Tài khoản</summary>
      <div className="account__panel">
        <p className="account__line">
          {isMock && <MockBadge />} <strong>{user.displayName || 'Chưa có tên hiển thị'}</strong>
        </p>
        <p className="account__line account__muted">{user.email || 'Không có email'}</p>

        <p className="account__label">UID</p>
        <code className="account__uid">{user.uid}</code>
        <button type="button" className="btn btn--ghost account__btn" onClick={handleCopyUid}>
          Sao chép UID
        </button>

        <button
          type="button"
          className="btn btn--ghost account__btn"
          onClick={handleCopyToken}
          disabled={busy || isMock}
        >
          {busy ? 'Đang lấy token…' : 'Sao chép ID token'}
        </button>
        {isMock && (
          <p className="account__muted">
            Đang ở chế độ MOCK: không có Firebase ID token thật. Cấu hình Firebase và đăng nhập Google để lấy.
          </p>
        )}

        {feedback && (
          <p
            className={feedback.ok ? 'account__muted' : 'account__error'}
            role={feedback.ok ? 'status' : 'alert'}
          >
            {feedback.text}
          </p>
        )}
      </div>
    </details>
  );
}
