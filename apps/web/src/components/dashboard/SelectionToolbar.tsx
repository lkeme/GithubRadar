import { Ellipsis, Pause, Play, RefreshCw, Tags, TagX, Trash } from 'lucide-react';
import { useEffect, useRef } from 'react';

import { Button } from '../ui/Button';
import { CheckboxField } from '../ui/Form';
import { IconButton } from '../ui/IconButton';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';

/**
 * 批量选择操作栏：
 * - 始终展示“已选 N 项”；全选仅当前页；动作为含义确定的独立动作。
 * - 全尺寸下都是悬浮命令条（fixed 居中 + 毛玻璃），手机空间不足时动作收进有文字的动作菜单。
 */

export interface SelectionToolbarProps {
  selectedCount: number;
  pageCount: number;
  allSelected: boolean;
  onToggleAll: () => void;
  onExit: () => void;
  onCheck: () => void;
  onPause: () => void;
  onResume: () => void;
  onAddLabels: () => void;
  onRemoveLabels: () => void;
  onRemove: () => void;
  busy: boolean;
}

export function SelectionToolbar({
  selectedCount,
  pageCount,
  allSelected,
  onToggleAll,
  onExit,
  onCheck,
  onPause,
  onResume,
  onAddLabels,
  onRemoveLabels,
  onRemove,
  busy,
}: SelectionToolbarProps) {
  const none = selectedCount === 0;
  const barRef = useRef<HTMLDivElement>(null);

  /**
   * 命令条高度随断点与内容折行变化（手机上是 2–3 行），固定值对不准：
   * 这里实测并写入 CSS 变量，提示层据此上移，避免提示压住命令条按钮。
   */
  useEffect(() => {
    const element = barRef.current;
    if (element === null || typeof ResizeObserver === 'undefined') return;
    const root = document.documentElement;
    const publish = (): void => {
      const height = Math.round(element.getBoundingClientRect().height) + 12;
      root.style.setProperty('--gr-toast-offset', `${height}px`);
    };
    publish();
    const observer = new ResizeObserver(publish);
    observer.observe(element);
    return () => {
      observer.disconnect();
      root.style.removeProperty('--gr-toast-offset');
    };
  }, []);

  return (
    <>
      {/* 悬浮命令条固定在视口底部，这里留出同高占位，避免遮住最后一张卡片或分页。 */}
      <div aria-hidden="true" className="h-28" />
      {/*
        fixed + inset-x-0 + mx-auto w-fit：命令条水平居中；
        max-w 用 calc(100vw-1.5rem) 扣除两侧留白，内容超宽时折行而不溢出视口。
      */}
      <div
        ref={barRef}
        className="fixed inset-x-3 bottom-4 z-50 mx-auto flex w-fit max-w-[calc(100vw-1.5rem)] flex-wrap items-center justify-center gap-x-2.5 gap-y-2 rounded-card border border-border bg-surface/90 px-3 py-2 shadow-pop backdrop-blur-md"
      >
        <CheckboxField
          id="select-page"
          checked={allSelected && pageCount > 0}
          onCheckedChange={onToggleAll}
          disabled={pageCount === 0}
          label={`全选当前页（${pageCount} 项）`}
        />
        <span role="status" className="gr-chip border border-accent/30 bg-accent-subtle font-semibold text-accent-strong">
          已选 {selectedCount} 项
        </span>
        <span aria-hidden="true" className="hidden h-6 w-px bg-border md:block" />
        <div className="hidden items-center gap-0.5 md:flex">
          <IconButton icon={RefreshCw} label="检测所选仓库" disabled={none || busy} onClick={onCheck} />
          <IconButton icon={Pause} label="暂停所选仓库的自动检测" disabled={none || busy} onClick={onPause} />
          <IconButton icon={Play} label="恢复所选仓库的自动检测" disabled={none || busy} onClick={onResume} />
          <IconButton icon={Tags} label="为所选仓库添加标签" disabled={none || busy} onClick={onAddLabels} />
          <IconButton icon={TagX} label="从所选仓库移除标签" disabled={none || busy} onClick={onRemoveLabels} />
          <IconButton icon={Trash} label="移除所选仓库的监控" tone="danger" disabled={none || busy} onClick={onRemove} />
        </div>
        <div className="md:hidden">
          <Menu
            align="end"
            ariaLabel="批量操作"
            trigger={
              <Button size="sm" variant="secondary" disabled={none || busy} leadingIcon={<Ellipsis size={16} aria-hidden="true" />}>
                动作
              </Button>
            }
          >
            <MenuItem icon={RefreshCw} onSelect={onCheck}>
              检测所选
            </MenuItem>
            <MenuItem icon={Pause} onSelect={onPause}>
              暂停所选
            </MenuItem>
            <MenuItem icon={Play} onSelect={onResume}>
              恢复所选
            </MenuItem>
            <MenuItem icon={Tags} onSelect={onAddLabels}>
              添加标签
            </MenuItem>
            <MenuItem icon={TagX} onSelect={onRemoveLabels}>
              移除标签
            </MenuItem>
            <MenuSeparator />
            <MenuItem icon={Trash} tone="danger" onSelect={onRemove}>
              移除监控
            </MenuItem>
          </Menu>
        </div>
        <Button size="sm" variant="ghost" onClick={onExit}>
          退出选择
        </Button>
      </div>
    </>
  );
}
