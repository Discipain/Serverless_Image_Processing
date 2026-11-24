export function LoadingState({ message = 'Đang tải…', fullPage = false }) {
  return (
    <div
      className={`state state--loading${fullPage ? ' state--full' : ''}`}
      role="status"
      aria-live="polite"
    >
      <span className="spinner" aria-hidden="true" />
      <p>{message}</p>
    </div>
  );
}
