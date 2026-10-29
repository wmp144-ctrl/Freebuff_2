import React from 'react';
import {
  Box,
  Camera,
  Cable,
  HardDrive,
  Network,
  Radio,
  Router,
  Server,
  Shield,
  Wifi,
} from 'lucide-react';

/**
 * آیکون تجهیزات بر اساس کلید ذخیره‌شده در دیاگرام.
 * نگاشت صریح است تا نام آیکون در داده ذخیره نشود و تغییر کتابخانهٔ آیکون
 * هرگز داده‌های ذخیره‌شده را نشکند.
 */
export function DeviceGlyph({ icon, size = 18 }: { icon: string; size?: number }) {
  const Icon =
    icon === 'switch'
      ? Network
      : icon === 'hub'
        ? Cable
        : icon === 'converter'
          ? Radio
          : icon === 'camera'
            ? Camera
            : icon === 'router'
              ? Router
              : icon === 'firewall'
                ? Shield
                : icon === 'wifi'
                  ? Wifi
                  : icon === 'server'
                    ? Server
                    : icon === 'panel'
                      ? HardDrive
                      : Box;
  return <Icon size={size} />;
}
