import type { CapacitorConfig } from '@capacitor/cli';

const config: CapacitorConfig = {
  appId: 'edu.dbl.campus',
  appName: 'DBL Campus',
  webDir: 'dist',
  server: {
    // Use HTTP inside Android WebView so the app can connect to local LAN HTTP servers (e.g. http://192.168.x.x:3000)
    androidScheme: 'http',
    cleartext: true,
  },
  android: {
    allowMixedContent: true,
  },
  ios: {
    contentInset: 'automatic',
  },
};

export default config;
