import { Modal } from '../../components/ui/Dialog';
import { LoginForm } from './LoginForm';

export interface LoginDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}

/**
 * 登录弹窗：
 * 登录成功后仅关闭弹窗，保持当前搜索、分页、视图与滚动位置不变。
 */
export function LoginDialog({ open, onOpenChange }: LoginDialogProps) {
  return (
    <Modal
      open={open}
      onOpenChange={onOpenChange}
      title="登录管理"
      description="登录后可在看板直接添加、检测与编辑仓库；浏览始终无需登录。"
      size="sm"
    >
      <LoginForm
        onSuccess={() => {
          onOpenChange(false);
        }}
      />
    </Modal>
  );
}
