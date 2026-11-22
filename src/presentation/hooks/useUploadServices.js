import { useContext } from 'react';
import { UploadServicesContext } from '../contexts/UploadServicesContext';

export function useUploadServices() {
  const services = useContext(UploadServicesContext);
  if (!services) {
    throw new Error('useUploadServices phải được dùng bên trong <UploadServicesContext.Provider>.');
  }
  return services;
}
