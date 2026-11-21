import { initializeApp } from 'firebase/app';
import { getFirestore } from 'firebase/firestore';
import { getAuth } from 'firebase/auth';

const firebaseConfig = {
  apiKey: "AIzaSyCWB2NlpKXpF-tcTxY8M3IvyXXaTpp3AMc",
  authDomain: "image-processing-project-ea23d.firebaseapp.com",
  projectId: "image-processing-project-ea23d",
  storageBucket: "image-processing-project-ea23d.firebasestorage.app",
  messagingSenderId: "327637110759",
  appId: "1:327637110759:web:e15c1de4a7c7a3e5c13742",
  measurementId: "G-9BNSJ8HHQC"
};

const app = initializeApp(firebaseConfig);
export const db = getFirestore(app);
export const auth = getAuth(app);
export default app;
