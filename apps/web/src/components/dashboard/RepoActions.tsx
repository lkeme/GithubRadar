import { Clock, Ellipsis, Pause, Pin, PinOff, Play, RefreshCw, Settings2, Tags, Trash } from 'lucide-react';
import type { MouseEvent } from 'react';

import type { PublicRepository } from '../../lib/api';
import { IconButton } from '../ui/IconButton';
import { Menu, MenuItem, MenuSeparator } from '../ui/Menu';
import { useDashboard } from './DashboardContext';

const JOB_STATE_TEXT: Record<string, string> = {
  queued: '已排队',
  running: '执行中',
  retry_wait: '稍后重试',
};

/**
 * 每卡片/行的图标操作：
 * - 登录后固定显示“检测、暂停或恢复、更多”三个低干扰入口，不靠 hover 才出现。
 * - 检测按钮显示“已排队/执行中/稍后重试”，在途 disabled/aria-busy，重复点击不生成新任务。
 * - 按钮点击不冒泡触发仓库外链。
 */
export function RepoActions({ repo }: { repo: PublicRepository }) {
  const { browse, commands } = useDashboard();
  if (!browse.authenticated) {
    return null;
  }
  const control = browse.controlsById.get(repo.id);
  const jobState = control?.jobState ?? 'idle';
  const checkStateText = JOB_STATE_TEXT[jobState] ?? null;
  const checkBusy = commands.busy(repo.id, 'check');
  const pauseBusy = commands.busy(repo.id, 'pause');
  const pinBusy = commands.busy(repo.id, 'pin');
  const setupLocked = browse.setupRequired;
  const checkDisabled =
    setupLocked || control === undefined || !control.capabilities.canCheck || checkStateText !== null || checkBusy;
  const isPaused = control?.paused === true;
  const pauseAllowed = isPaused ? (control?.capabilities.canResume ?? false) : (control?.capabilities.canPause ?? false);
  const pauseDisabled = setupLocked || control === undefined || !pauseAllowed || pauseBusy;
  const pauseLabel = isPaused ? '恢复自动检测' : '暂停自动检测';
  const setupHint = setupLocked ? '（需先在系统设置完成 Token 验证）' : '';
  // 管理补充数据未加载时能力位未知，按"不可用"处理，避免点开菜单后才被服务端打回；
  // 能力字段由服务端计算，前端只负责据此禁用。
  const canEdit = control?.capabilities.canEdit;
  const canRemove = control?.capabilities.canRemove;

  const stop = (event: MouseEvent): void => {
    event.stopPropagation();
  };

  return (
    <div className="flex shrink-0 items-center gap-0.5">
      <span className="flex items-center">
        <IconButton
          icon={checkStateText !== null ? Clock : RefreshCw}
          spinning={jobState === 'running'}
          label={checkStateText !== null ? `检测${checkStateText}` : `检测一次${setupHint}`}
          disabled={checkDisabled}
          aria-busy={checkBusy || checkStateText !== null}
          onClick={(event) => {
            stop(event);
            commands.check(repo);
          }}
          className={checkStateText !== null ? 'text-warning' : undefined}
        />
        {checkStateText !== null ? (
          <span className="pr-1 text-aux text-muted" aria-hidden="true">
            {checkStateText}
          </span>
        ) : null}
      </span>
      <IconButton
        icon={isPaused ? Play : Pause}
        label={`${pauseLabel}${setupHint}`}
        disabled={pauseDisabled}
        aria-busy={pauseBusy}
        onClick={(event) => {
          stop(event);
          commands.togglePause(repo);
        }}
      />
      <Menu
        align="end"
        ariaLabel={`${repo.fullName} 的更多操作`}
        trigger={<IconButton icon={Ellipsis} label={`更多操作：${repo.fullName}`} />}
      >
        <MenuItem
          icon={repo.pinned ? PinOff : Pin}
          // 置顶提交的是完整顺序：本卡片的 pin 在途或任一其他卡片的 pin 在途时都不能再发起，
          // 否则后一次提交会拿旧的 pinsRevision 覆盖前一次的结果。
          disabled={setupLocked || canEdit !== true || pinBusy || browse.pinsPending}
          onSelect={() => {
            commands.togglePin(repo);
          }}
        >
          {repo.pinned ? '取消置顶' : '置顶'}
        </MenuItem>
        <MenuItem
          icon={Tags}
          disabled={setupLocked || canEdit !== true}
          onSelect={() => {
            commands.editLabels(repo);
          }}
        >
          设置标签
        </MenuItem>
        <MenuItem
          icon={Settings2}
          disabled={setupLocked || canEdit !== true}
          onSelect={() => {
            commands.editMonitor(repo);
          }}
        >
          编辑监控
        </MenuItem>
        <MenuSeparator />
        <MenuItem
          icon={Trash}
          tone="danger"
          disabled={setupLocked || canRemove !== true}
          onSelect={() => {
            commands.removeMonitor(repo);
          }}
        >
          移除监控
        </MenuItem>
      </Menu>
    </div>
  );
}
