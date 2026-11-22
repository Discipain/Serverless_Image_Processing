import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter } from 'react-router';
import { createAuthServices } from './app/createAuthServices';
import { createUploadServices } from './app/createUploadServices';
import { AuthProvider } from './presentation/contexts/AuthProvider';
import { UploadServicesContext } from './presentation/contexts/UploadServicesContext';
import App from './App';
import './styles/index.css';

// Composition root: Authentication (H1) và luồng upload MOCK (H4A).
// createUploadServices chỉ ghép adapter MOCK: không có đường nào tới Cloudinary/Backend thật.
const authServices = createAuthServices();
const uploadServices = createUploadServices();

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <BrowserRouter>
      <AuthProvider services={authServices}>
        <UploadServicesContext.Provider value={uploadServices}>
          <App />
        </UploadServicesContext.Provider>
      </AuthProvider>
    </BrowserRouter>
  </StrictMode>,
);
