import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'edu.dbl.campus',
  appName: 'DBL Campus',
  webDir: 'dist',
  server: {
    // HTTPS origin inside WebView for secure internet deployment (e.g. https://campus.example.edu)
    androidScheme: 'https',
    cleartext: false,
  },
  android: {
    allowMixedContent: false,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
