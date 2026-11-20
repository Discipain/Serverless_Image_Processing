import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Cấu hình Vite tối thiểu cho React.
// https://vite.dev/config/
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
  },
});
