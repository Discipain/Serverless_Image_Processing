import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { createAuthServices } from './app/createAuthServices';
import { createUploadServices } from './app/createUploadServices';
import { createGalleryServices } from './app/createGalleryServices';
import { AuthProvider } from './presentation/contexts/AuthProvider';
import { UploadServicesContext } from './presentation/contexts/UploadServicesContext';
import { GalleryServicesContext } from './presentation/contexts/GalleryServicesContext';
import App from './App';
import './styles/index.css';

// Composition root: Authentication (H1) và luồng upload MOCK (H4A).
// createUploadServices chỉ ghép adapter MOCK: không có đường nào tới Cloudinary/Backend thật.
const authServices = createAuthServices();
const uploadServices = createUploadServices();
// Gallery (INT-3B): MẶC ĐỊNH MOCK. Chỉ REAL khi VITE_GALLERY_MODE=real VÀ Backend localhost + development + Firebase Auth thật
// (xem createGalleryServices.js). Cấu hình REAL sai => hiện lỗi cấu hình, không fallback MOCK. Không gọi mạng khi khởi tạo.
const galleryServices = createGalleryServices({ authServices });

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider services={authServices}>
        <UploadServicesContext.Provider value={uploadServices}>
          <GalleryServicesContext.Provider value={galleryServices}>
            <App />
          </GalleryServicesContext.Provider>
        </UploadServicesContext.Provider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
