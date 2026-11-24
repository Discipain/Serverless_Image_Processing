export function EmptyState({ title, description, children }) {
  return (
    <div className="state state--empty">
      <div className="state__icon" aria-hidden="true">🖼️</div>
      <h2 className="state__title">{title}</h2>
      {description && <p className="state__text">{description}</p>}
      {children && <div className="state__actions">{children}</div>}
    </div>
  );
}
