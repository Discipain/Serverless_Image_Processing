import { useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router';
import { useAuth } from '../../hooks/useAuth';
import { ROUTES } from '../../constants/routes';
import { MockBadge } from '../common/MockBadge';
import { AccountMenu } from '../auth/AccountMenu';

const NAV_ITEMS = [
  { to: ROUTES.upload, label: 'Tải ảnh lên' },
  { to: ROUTES.gallery, label: 'Thư viện' },
];

export function Header() {
  const { user, isMock, logout } = useAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const [logoutError, setLogoutError] = useState(null);

  async function handleLogout() {
    setLoggingOut(true);
    setLogoutError(null);
    try {
      await logout();
      navigate(ROUTES.login, { replace: true });
    } catch (error) {
      setLogoutError(error?.message || 'Đăng xuất thất bại, vui lòng thử lại.');
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <header className="header">
      <div className="header__inner container">
        <Link to={ROUTES.gallery} className="header__brand">
          Image Processing
        </Link>

        <nav className="header__nav" aria-label="Điều hướng chính">
          {NAV_ITEMS.map((item) => (
            <NavLink
              key={item.to}
              to={item.to}
              className={({ isActive }) => `nav-link${isActive ? ' nav-link--active' : ''}`}
            >
              {item.label}
            </NavLink>
          ))}
        </nav>

        {user && (
          <div className="header__user">
            {isMock && <MockBadge />}
            <span className="header__uid" title={user.uid}>
              UID: <code>{user.uid}</code>
            </span>
            <AccountMenu />
            <button
              type="button"
              className="btn btn--ghost"
              onClick={handleLogout}
              disabled={loggingOut}
            >
              {loggingOut ? 'Đang thoát…' : 'Đăng xuất'}
            </button>
            {logoutError && (
              <span className="header__error" role="alert">
                {logoutError}
              </span>
            )}
          </div>
        )}
      </div>
    </header>
  );
}
