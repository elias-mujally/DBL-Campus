import React, { useState } from 'react';

interface AuroraLogoProps {
  size?: number;
  animate?: boolean;
  className?: string;
  alt?: string;
}

export const AuroraLogo: React.FC<AuroraLogoProps> = ({
  size = 32,
  animate = false,
  className = '',
  alt = 'Aurora DBL Campus',
}) => {
  const [src, setSrc] = useState('/aurora-logo.png');

  const handleError = () => {
    if (src !== '/icon.svg') {
      setSrc('/icon.svg');
    }
  };

  const combinedClassName = [
    animate ? 'aurora-signature-intro' : '',
    'object-contain select-none',
    className,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <img
      src={src}
      alt={alt}
      width={size}
      height={size}
      style={{ width: size, height: size }}
      onError={handleError}
      className={combinedClassName}
      draggable={false}
    />
  );
};

export default AuroraLogo;
