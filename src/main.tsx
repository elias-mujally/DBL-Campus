import { createRoot } from 'react-dom/client';
import { registerSW } from 'virtual:pwa-register';
import App from './App.tsx';
import './index.css';

// Register PWA Service Worker for HTTPS standalone mobile installability and seamless updates
registerSW({ immediate: true });

createRoot(document.getElementById('root')!).render(<App />);
