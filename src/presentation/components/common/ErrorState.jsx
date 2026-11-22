export function ErrorState({ title = 'Đã có lỗi xảy ra', error, onRetry }) {
  const message = error?.message || 'Vui lòng thử lại sau.';

  return (
    <div className="state state--error" role="alert">
      <div className="state__icon" aria-hidden="true">⚠️</div>
      <h2 className="state__title">{title}</h2>
      <p className="state__text">{message}</p>
      {onRetry && (
        <div className="state__actions">
          <button type="button" className="btn btn--primary" onClick={onRetry}>
            Thử lại
          </button>
        </div>
      )}
    </div>
  );
}
