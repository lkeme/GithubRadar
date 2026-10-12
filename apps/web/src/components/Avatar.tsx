import { FolderGit2 } from 'lucide-react';
import { useState } from 'react';

import { safeAvatarSrc } from '../lib/format';
import { cn } from './ui/cn';

export interface OwnerAvatarProps {
  src: string | null | undefined;
  /** 仓库规范名，用于替代文本。 */
  alt: string;
  size?: number;
  className?: string;
}

/**
 * 仓库所有者头像：
 * - 只允许 https://avatars.githubusercontent.com；loading="lazy"、referrerPolicy="no-referrer"。
 * - 离线或加载失败回落本地 Lucide 图标，不阻塞卡片。
 */
export function OwnerAvatar({ src, alt, size = 32, className }: OwnerAvatarProps) {
  const [failed, setFailed] = useState(false);
  const safeSrc = safeAvatarSrc(src);
  if (safeSrc === null || failed) {
    return (
      <span
        aria-hidden="true"
        className={cn(
          'inline-flex shrink-0 items-center justify-center rounded-full border border-border bg-inset text-muted',
          className,
        )}
        style={{ width: size, height: size }}
      >
        <FolderGit2 size={Math.round(size * 0.5)} />
      </span>
    );
  }
  return (
    <img
      src={safeSrc}
      alt={`${alt} 的头像`}
      width={size}
      height={size}
      loading="lazy"
      referrerPolicy="no-referrer"
      onError={() => {
        setFailed(true);
      }}
      className={cn('shrink-0 rounded-full border border-border bg-inset object-cover', className)}
      style={{ width: size, height: size }}
    />
  );
}
