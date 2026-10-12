import { useRef, useState, type FormEvent } from 'react';

import { ApiError, errorMessage } from '../../lib/errors';
import { useAuth } from './AuthProvider';
import { Button } from '../../components/ui/Button';
import { CheckboxField, Field, Input, PasswordInput } from '../../components/ui/Form';

/**
 * 登录表单：
 * 弹窗与 /login 页面共用同一套逻辑；用户名固定 admin；记住我默认不勾选；
 * 登录接口要求真正的 JSON boolean 与精确 Origin（由请求层保证 application/json）。
 */

function loginErrorMessage(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'UNAUTHENTICATED') {
      return '用户名或密码错误';
    }
    if (error.code === 'FORBIDDEN') {
      return '当前访问来源不允许登录，请使用 HTTPS 或本机地址访问';
    }
    if (error.code === 'VALIDATION_FAILED') {
      return '请输入密码';
    }
    if (error.status === 429) {
      return '尝试过于频繁，请稍后再试';
    }
    return errorMessage(error);
  }
  return '登录失败，请稍后重试';
}

export interface LoginFormProps {
  onSuccess: () => void;
}

export function LoginForm({ onSuccess }: LoginFormProps) {
  const auth = useAuth();
  const [password, setPassword] = useState('');
  const [rememberMe, setRememberMe] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const passwordRef = useRef<HTMLInputElement | null>(null);

  const submit = async (event: FormEvent): Promise<void> => {
    event.preventDefault();
    if (password.length === 0) {
      setError('请输入密码');
      passwordRef.current?.focus();
      return;
    }
    setSubmitting(true);
    setError(null);
    try {
      await auth.login(password, rememberMe);
      onSuccess();
    } catch (caught) {
      setError(loginErrorMessage(caught));
      setPassword('');
      passwordRef.current?.focus();
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form className="flex flex-col gap-4" onSubmit={(event) => void submit(event)} noValidate>
      <Field label="用户名" htmlFor="login-username">
        <Input id="login-username" value="admin" readOnly autoComplete="username" className="font-sans" />
      </Field>
      <Field label="密码" htmlFor="login-password" error={error ?? undefined}>
        <PasswordInput
          id="login-password"
          ref={passwordRef}
          revealLabel="登录密码"
          value={password}
          autoComplete="current-password"
          autoFocus
          invalid={error !== null}
          className="font-sans"
          aria-describedby={error !== null ? 'login-password-error' : undefined}
          onChange={(event) => {
            setPassword(event.target.value);
          }}
        />
      </Field>
      <CheckboxField
        id="login-remember"
        checked={rememberMe}
        onCheckedChange={setRememberMe}
        label="记住我（30 天内保持登录）"
        disabled={submitting}
      />
      <Button type="submit" variant="primary" disabled={submitting} aria-busy={submitting}>
        {submitting ? '登录中…' : '登录'}
      </Button>
    </form>
  );
}
