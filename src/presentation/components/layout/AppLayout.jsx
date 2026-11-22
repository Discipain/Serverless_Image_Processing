import { Outlet } from 'react-router';
import { Header } from './Header';

// Khung chung cho các trang sau đăng nhập: header + nội dung trang.
export function AppLayout() {
  return (
    <div className="app">
      <Header />
      <main className="main container">
        <Outlet />
      </main>
    </div>
  );
}
