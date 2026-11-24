/** A public DNS origin for the bundled native API and production deployment. */
export function validateProductionOrigin(value: string, allowFixture = false): string {
  const origin = new URL(value);
  const host = origin.hostname;
  const labels = host.split('.');
  const isDomain = labels.length > 1 && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  const privateSuffix = /\.(?:local|localhost|lan|internal|home|invalid|test)$/;
  const reserved = /(?:^|\.)example\.(?:com|net|org|edu)$/;
  if (origin.protocol !== 'https:' || origin.username || origin.password || origin.port ||
      origin.pathname !== '/' || origin.search || origin.hash || !isDomain || !/[a-z]/.test(labels.at(-1) || '') ||
      privateSuffix.test(host) || (!allowFixture && reserved.test(host))) {
    throw new Error('Use a public HTTPS origin without a port, path, credentials or placeholder hostname.');
  }
  return origin.origin;
}
