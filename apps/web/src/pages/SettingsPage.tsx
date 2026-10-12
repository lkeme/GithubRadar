import {
  CircleCheck,
  CircleX,
  Clock,
  KeyRound,
  LoaderCircle,
  Lock,
  Network,
  PlugZap,
  RefreshCw,
  Save,
  ShieldCheck,
  Trash2,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { Fragment, useEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { useNavigate } from 'react-router';

import { RequireAuth } from '../components/AppShell';
import { useAuth } from '../features/auth/AuthProvider';
import {
  useChangePassword,
  useClearToken,
  usePutProxy,
  usePutSettings,
  useSubmitToken,
  useTestProxy,
  useVerifyToken,
} from '../features/repos/mutations';
import {
  useCredentialStatus,
  useOperation,
  useProxyStatus,
  useSettings,
  useSystemStatus,
} from '../features/repos/queries';
import { Button } from '../components/ui/Button';
import { Modal } from '../components/ui/Dialog';
import { LabelManager } from '../components/settings/LabelManager';
import { Field, Input, PasswordInput, RadioGroupField, SwitchControl } from '../components/ui/Form';
import { IconButton, TooltipHint } from '../components/ui/IconButton';
import { SelectField } from '../components/ui/Select';
import { useToast } from '../components/ui/Toast';
import { cn } from '../components/ui/cn';
import type { CredentialStatusData, OperationData } from '../lib/api';
import { noteProxyApplied } from '../lib/api';
import { ApiError } from '../lib/errors';
import {
  EXPIRY_URGENT_DAYS,
  EXPIRY_WARN_DAYS,
  INTERVAL_OPTIONS,
  MAX_PASSWORD_LENGTH,
  MIN_PASSWORD_LENGTH,
  PASSWORD_ALLOWED_SYMBOLS,
} from '../lib/constants';
import { errorCodeMessage, errorMessage } from '../lib/errors';
import { serverNow } from '../lib/clock';
import { formatBeijingDateTime } from '../lib/relative-time';
import { filterPortInput, filterTokenInput } from '../lib/input-filters';
import {
  GITHUB_TOKEN_INVALID,
  PROXY_HOST_INVALID,
  PROXY_PORT_INVALID,
  PROXY_USERNAME_INVALID,
  isValidGithubToken,
  isValidPort,
  isValidProxyHost,
  isValidProxyUsername,
  passwordPolicyViolation,
} from '../lib/validation';

/**
 * 系统设置：
 * 门禁未就绪时按“代理 → PAT → 在线验证”初始化；操作按钮统一收在章节右上（图标按钮 + Tooltip），
 * 章节内只保留输入本身；敏感字段只显示“已配置”，保存成功后清空输入框。
 */

const CREDENTIAL_STATE_TEXT: Record<CredentialStatusData['state'], string> = {
  missing: '未配置',
  unverified: '待验证',
  valid: '有效',
  invalid: '无效',
  expired: '已过期',
};

const PROBE_STAGE_TEXT: Record<'dns' | 'connect' | 'tls' | 'http', string> = {
  dns: 'DNS 解析',
  connect: 'TCP 连接',
  tls: 'TLS 握手',
  http: 'HTTP 响应',
};

const OPERATION_STATUS_TEXT: Record<OperationData['status'], string> = {
  pending: '等待中',
  running: '执行中',
  succeeded: '成功',
  failed: '失败',
  cancelled: '已取消',
  expired: '已过期',
};

type ProxyFormValues = { scheme: string; host: string; port: string; username: string; password: string };

/**
 * 输入阶段的代理字段校验：只报告"已填但不合法"的值，不报告空值
 * （空值是"还没填完"，提交时由 `readProxyCandidate` 统一给出必填提示）。
 * 端口在输入时已被字符级过滤（只可能是数字），这里只判范围。
 */
function proxyFormIssues(form: ProxyFormValues): Record<string, string> {
  const issues: Record<string, string> = {};
  const host = form.host.trim();
  if (host !== '' && !isValidProxyHost(host)) {
    issues['host'] = PROXY_HOST_INVALID;
  }
  const port = form.port.trim();
  if (port !== '' && !isValidPort(port)) {
    issues['port'] = PROXY_PORT_INVALID;
  }
  const username = form.username.trim();
  if (username !== '' && !isValidProxyUsername(username)) {
    issues['username'] = username.length > 255 ? '账号最多 255 个字符' : PROXY_USERNAME_INVALID;
  }
  if (form.password.length > 512) {
    issues['password'] = '代理密码最多 512 个字符';
  }
  return issues;
}

/** 剩余天数按校正后的服务器时间计算：客户端时钟偏移不应改变“还剩几天/是否临近到期”。 */
function daysUntil(iso: string | null): number | null {
  if (iso === null) {
    return null;
  }
  const target = Date.parse(iso);
  if (!Number.isFinite(target)) {
    return null;
  }
  return Math.floor((target - serverNow()) / 86_400_000);
}

/** 服务端的逐字段校验结果（VALIDATION_FAILED 的 fields）优先于笼统错误码文案。 */
function serverFieldErrors(error: unknown): Record<string, string> {
  return error instanceof ApiError && error.fields !== undefined ? error.fields : {};
}

/**
 * 设置页统一的章节卡：图标底衬 + 标题 + 右上操作区，标题下不再堆叠说明文字。
 * 操作多于一个时用竖线分隔：开关与图标按钮外形差异大，紧挨着看不清边界。
 */
function Section({
  icon: Icon,
  title,
  ariaLabel,
  aside,
  children,
}: {
  icon: LucideIcon;
  title: string;
  ariaLabel: string;
  aside?: readonly ReactNode[];
  children: ReactNode;
}) {
  return (
    <section aria-label={ariaLabel} className="gr-card flex flex-col gap-5 p-5 md:p-6">
      <header className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border pb-4">
        <h2 className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight text-text">
          <span aria-hidden="true" className="gr-icon-tile size-8">
            <Icon size={15} />
          </span>
          {title}
        </h2>
        {aside === undefined || aside.length === 0 ? null : (
          <div className="flex items-center gap-1.5">
            {aside.map((item, index) => (
              <Fragment key={index}>
                {index > 0 ? <span aria-hidden="true" className="mx-1 h-5 w-px shrink-0 bg-border" /> : null}
                {item}
              </Fragment>
            ))}
          </div>
        )}
      </header>
      {children}
    </section>
  );
}

export function SettingsPage() {
  return (
    <RequireAuth>
      <SettingsContent />
    </RequireAuth>
  );
}

function SettingsContent() {
  const auth = useAuth();
  const navigate = useNavigate();
  const { push } = useToast();

  const credentialQuery = useCredentialStatus();
  const settingsQuery = useSettings();
  const proxyQuery = useProxyStatus();
  const systemQuery = useSystemStatus();

  const credential = credentialQuery.data;
  const settings = settingsQuery.data;
  const proxy = proxyQuery.data;
  const system = systemQuery.data;

  const [operationId, setOperationId] = useState<string | null>(null);
  const operationQuery = useOperation(operationId);
  const operation = operationQuery.data;
  const handledOperations = useRef(new Set<string>());
  const proxySubmitRevision = useRef<number | null>(null);

  const businessReady = credential?.state === 'valid';

  // 操作到达终态：刷新状态卡与代理/系统状态，并按结果给出反馈。
  useEffect(() => {
    if (operation === undefined) {
      return;
    }
    if (operation.status !== 'succeeded' && operation.status !== 'failed' && operation.status !== 'cancelled' && operation.status !== 'expired') {
      return;
    }
    if (handledOperations.current.has(operation.id)) {
      return;
    }
    handledOperations.current.add(operation.id);
    if (operation.kind === 'proxy_apply' && operation.status === 'succeeded' && proxySubmitRevision.current !== null) {
      noteProxyApplied(proxySubmitRevision.current);
    }
    void credentialQuery.refetch();
    void proxyQuery.refetch();
    void systemQuery.refetch();
    // 凭证状态变化会改变业务门禁，会话里缓存的 setupRequired 也必须一起复核，
    // 否则看板会一直显示“业务尚未解锁”直到窗口失焦或刷新。
    if (operation.kind === 'github_token') {
      void auth.refreshSession();
    }
    if (operation.status === 'succeeded') {
      if (operation.kind === 'github_token') {
        push('success', 'GitHub Token 验证通过，业务已解锁');
      } else if (operation.kind === 'proxy_apply') {
        push('success', '代理配置已生效');
      } else {
        // 纯连通性测试不写任何配置，不能宣告“已生效”。
        push('success', '代理连通性测试通过（未保存）');
      }
    } else if (operation.status === 'failed') {
      push(
        'error',
        operation.errorCode === null ? '操作失败，请检查配置' : `操作失败：${errorCodeMessage(operation.errorCode)}`,
      );
    }
  }, [operation, credentialQuery, proxyQuery, systemQuery, push, auth]);

  // ---- 代理表单 ----
  const [proxyForm, setProxyForm] = useState({ scheme: 'http', host: '', port: '', username: '', password: '' });
  const [proxyFieldErrors, setProxyFieldErrors] = useState<Record<string, string>>({});
  const [proxyError, setProxyError] = useState<string | null>(null);
  /** 上一次来自服务端的代理值；只有服务端值真的变化时才回填表单。 */
  const syncedProxySignature = useRef<string | null>(null);

  useEffect(() => {
    if (proxy === undefined) {
      return;
    }
    // 窗口聚焦或写操作都会重取代理状态：同值回填会把用户正在输入的内容清掉，
    // 因此按"服务端值是否变化"决定是否覆盖表单（表单编辑不被后台刷新打断）。
    const signature = `${proxy.scheme ?? 'http'}|${proxy.host ?? ''}|${proxy.port === null ? '' : proxy.port}`;
    if (syncedProxySignature.current === signature) {
      return;
    }
    syncedProxySignature.current = signature;
    setProxyForm((prev) => ({
      ...prev,
      scheme: proxy.scheme ?? 'http',
      host: proxy.host ?? '',
      port: proxy.port === null ? '' : String(proxy.port),
    }));
    // 回填只覆盖协议/主机/端口：这三个字段在输入阶段结算过的提示要一起作废，
    // 否则旧值留下的错误会挂在一个已经合法的新值上（账号与密码未被回填，提示保持有效）。
    setProxyFieldErrors((prev) => {
      const next = { ...prev };
      delete next['host'];
      delete next['port'];
      return next;
    });
  }, [proxy]);

  const putProxyMutation = usePutProxy({ errorToToast: false });
  const testProxyMutation = useTestProxy({ errorToToast: false });

  /** 表单内任意一次输入：写回字段并立刻按输入阶段规则结算提示（错误随输入即时出现/消失）。 */
  const updateProxyForm = (patch: Partial<ProxyFormValues>): void => {
    const next = { ...proxyForm, ...patch };
    setProxyForm(next);
    setProxyFieldErrors(proxyFormIssues(next));
  };

  /** 表单校验：返回可直接提交的候选值，任一项不合法时给出对应字段错误并返回 null。 */
  const readProxyCandidate = (): {
    scheme: 'http' | 'https' | 'socks5';
    host: string;
    port: number;
    username: string;
    password: string;
  } | null => {
    const host = proxyForm.host.trim();
    const port = proxyForm.port.trim();
    const username = proxyForm.username.trim();
    const errors: Record<string, string> = {};
    if (host === '') {
      errors['host'] = '请填写代理主机';
    } else if (!isValidProxyHost(host)) {
      errors['host'] = PROXY_HOST_INVALID;
    }
    if (port === '') {
      errors['port'] = '请填写端口';
    } else if (!isValidPort(port)) {
      errors['port'] = PROXY_PORT_INVALID;
    }
    if (username !== '' && !isValidProxyUsername(username)) {
      errors['username'] = username.length > 255 ? '账号最多 255 个字符' : PROXY_USERNAME_INVALID;
    }
    if (proxyForm.password.length > 512) {
      errors['password'] = '代理密码最多 512 个字符';
    }
    setProxyFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return null;
    }
    return {
      scheme: proxyForm.scheme as 'http' | 'https' | 'socks5',
      host,
      port: Number(port),
      username,
      password: proxyForm.password,
    };
  };

  const candidateBody = (candidate: { scheme: 'http' | 'https' | 'socks5'; host: string; port: number; username: string; password: string }) => ({
    scheme: candidate.scheme,
    host: candidate.host,
    port: candidate.port,
    // 留空即"该代理不使用认证"：候选凭据原样替换已存值，服务端不做合并，
    // 因此界面不再声称"留空表示保留原有认证"（与 applyProxyResult 的写入语义一致）。
    ...(candidate.username.length > 0 ? { username: candidate.username } : {}),
    ...(candidate.password.length > 0 ? { password: candidate.password } : {}),
  });

  const saveProxy = (): void => {
    if (proxy === undefined) {
      return;
    }
    const candidate = readProxyCandidate();
    if (candidate === null) {
      return;
    }
    setProxyError(null);
    putProxyMutation.mutate(
      { enabled: true, ...candidateBody(candidate), expectedRevision: proxy.revision },
      {
        onSuccess: ({ operationId: id }) => {
          proxySubmitRevision.current = proxy.revision;
          setProxyForm((prev) => ({ ...prev, password: '' }));
          if (id !== null) {
            setOperationId(id);
          } else {
            void proxyQuery.refetch();
            push('info', '已保存候选配置');
          }
        },
        onError: (error) => {
          const fields = serverFieldErrors(error);
          if (Object.keys(fields).length > 0) {
            setProxyFieldErrors(fields);
            setProxyError(null);
            return;
          }
          setProxyError(errorMessage(error));
        },
      },
    );
  };

  const testProxyOnly = (): void => {
    const candidate = readProxyCandidate();
    if (candidate === null) {
      return;
    }
    setProxyError(null);
    testProxyMutation.mutate(candidateBody(candidate), {
      onSuccess: ({ operationId: id }) => {
        if (id !== null) {
          setOperationId(id);
        } else {
          push('info', '已提交代理连通性测试');
        }
      },
      onError: (error) => {
        const fields = serverFieldErrors(error);
        if (Object.keys(fields).length > 0) {
          setProxyFieldErrors(fields);
          return;
        }
        setProxyError(errorMessage(error));
      },
    });
  };

  const disableProxy = (): void => {
    if (proxy === undefined) {
      return;
    }
    putProxyMutation.mutate(
      { enabled: false, expectedRevision: proxy.revision },
      {
        onSuccess: ({ operationId: id }) => {
          if (id !== null) {
            setOperationId(id);
            return;
          }
          // 关闭代理是同步完成的（不经候选验证），服务端直接返回新状态；
          // `putProxy` 已按响应写入真实 revision，这里不猜测版本（猜测值可能覆盖准确值）。
          void proxyQuery.refetch();
          void systemQuery.refetch();
          setProxyError(null);
          push('success', '代理已关闭，已回到直连');
        },
        onError: (error) => {
          setProxyError(errorMessage(error));
        },
      },
    );
  };

  // ---- Token 表单 ----
  const [tokenInput, setTokenInput] = useState('');
  const [tokenError, setTokenError] = useState<string | null>(null);
  const [clearTokenOpen, setClearTokenOpen] = useState(false);
  const submitTokenMutation = useSubmitToken({ errorToToast: false });
  const verifyTokenMutation = useVerifyToken({ errorToToast: false });
  const clearTokenMutation = useClearToken({ errorToToast: false });

  const submitToken = (): void => {
    const trimmed = tokenInput.trim();
    if (trimmed.length === 0) {
      setTokenError('请输入 GitHub Token');
      return;
    }
    if (!isValidGithubToken(trimmed)) {
      setTokenError(GITHUB_TOKEN_INVALID);
      return;
    }
    setTokenError(null);
    submitTokenMutation.mutate(trimmed, {
      onSuccess: ({ operationId: id }) => {
        setTokenInput('');
        if (id !== null) {
          setOperationId(id);
        } else {
          void credentialQuery.refetch();
          push('info', '已提交 Token，等待在线验证');
        }
      },
      onError: (error) => {
        setTokenError(serverFieldErrors(error)['token'] ?? errorMessage(error));
      },
    });
  };

  const verifyToken = (): void => {
    setTokenError(null);
    verifyTokenMutation.mutate(undefined, {
      onSuccess: ({ operationId: id }) => {
        if (id !== null) {
          setOperationId(id);
        } else {
          void credentialQuery.refetch();
          push('info', '已提交重新验证');
        }
      },
      onError: (error) => {
        setTokenError(errorMessage(error));
      },
    });
  };

  const clearToken = (): void => {
    clearTokenMutation.mutate(undefined, {
      onSuccess: () => {
        setClearTokenOpen(false);
        setTokenInput('');
        setTokenError(null);
        setOperationId(null);
        void credentialQuery.refetch();
        void systemQuery.refetch();
        void auth.refreshSession();
        push('success', 'Token 已重置，业务重新进入锁定');
      },
      onError: (error) => {
        setClearTokenOpen(false);
        setTokenError(errorMessage(error));
      },
    });
  };

  // ---- 业务设置 ----
  const [intervalChoice, setIntervalChoice] = useState('24');
  const [settingsError, setSettingsError] = useState<string | null>(null);
  const putSettingsMutation = usePutSettings({ errorToToast: false });
  /** 同上：只有服务端值真的变化时才回填，避免后台刷新清掉未保存的选择。 */
  const syncedSettingsSignature = useRef<string | null>(null);

  useEffect(() => {
    if (settings === undefined) {
      return;
    }
    const signature = String(settings.defaultIntervalHours);
    if (syncedSettingsSignature.current === signature) {
      return;
    }
    syncedSettingsSignature.current = signature;
    setIntervalChoice(String(settings.defaultIntervalHours));
  }, [settings]);

  const saveSettings = (): void => {
    if (settings === undefined) {
      return;
    }
    setSettingsError(null);
    putSettingsMutation.mutate(
      {
        revision: settings.revision,
        patch: {
          defaultIntervalHours: Number(intervalChoice),
        },
      },
      {
        onSuccess: () => {
          push('success', '全局配置已保存');
        },
        onError: (error) => {
          setSettingsError(errorMessage(error));
          void settingsQuery.refetch();
        },
      },
    );
  };

  // ---- 修改密码 ----
  const [passwordForm, setPasswordForm] = useState({ current: '', next: '', confirm: '' });
  /** 逐字段错误：当前密码 / 新密码 / 确认新密码各自显示在对应输入下（服务端 fields 也落这里）。 */
  const [passwordFieldErrors, setPasswordFieldErrors] = useState<Record<string, string>>({});
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const changePasswordMutation = useChangePassword();

  /** 输入阶段结算新密码提示：边输入边给出当前还差什么（长度/字符集合/组成），而不是等提交才一次报出来。 */
  const updatePasswordField = (patch: Partial<{ current: string; next: string; confirm: string }>): void => {
    const next = { ...passwordForm, ...patch };
    setPasswordForm(next);
    const live: Record<string, string> = {};
    const violation = next.next.length === 0 ? null : passwordPolicyViolation(next.next);
    if (violation !== null) {
      live['next'] = violation;
    }
    if (next.confirm.length > 0 && next.confirm !== next.next) {
      live['confirm'] = '两次输入的新密码不一致';
    }
    setPasswordFieldErrors(live);
  };

  const submitPassword = (): void => {
    const errors: Record<string, string> = {};
    if (passwordForm.current.length === 0) {
      errors['current'] = '请输入当前密码';
    }
    const violation = passwordPolicyViolation(passwordForm.next);
    if (violation !== null) {
      errors['next'] = violation;
    } else if (passwordForm.next !== passwordForm.confirm) {
      errors['confirm'] = '两次输入的新密码不一致';
    }
    setPasswordFieldErrors(errors);
    if (Object.keys(errors).length > 0) {
      return;
    }
    setPasswordError(null);
    changePasswordMutation.mutate(
      { currentPassword: passwordForm.current, newPassword: passwordForm.next },
      {
        onSuccess: () => {
          setPasswordForm({ current: '', next: '', confirm: '' });
          setPasswordFieldErrors({});
          push('success', '密码已修改，所有旧会话已撤销，请重新登录');
          void auth.logout().then(() => {
            navigate('/login?returnTo=%2Fsettings', { replace: true });
          });
        },
        onError: (error) => {
          setPasswordFieldErrors(serverFieldErrors(error));
          setPasswordError(Object.keys(serverFieldErrors(error)).length > 0 ? null : errorMessage(error));
        },
      },
    );
  };

  const expiryDays = daysUntil(credential?.expiresAt ?? null);
  const operationRunning = operation !== undefined && (operation.status === 'pending' || operation.status === 'running');

  return (
    <div className="mx-auto flex w-full max-w-4xl flex-col gap-5 px-4 py-5 md:px-6 md:py-7 lg:px-8">
      <header className="gr-rise flex flex-col gap-1.5">
        <h1 className="text-display font-semibold text-text">系统设置</h1>
      </header>

      {credential !== undefined && !businessReady ? (
        <section aria-label="初始化步骤" className="gr-card flex flex-col gap-4 border-warning/50 p-5 md:p-6">
          <h2 className="text-[15px] font-semibold tracking-tight text-text">初始化</h2>
          <ol className="relative flex flex-col gap-0 text-aux2">
            {/* 步骤间的连接线：绝对定位的静态竖线，穿过左侧圆点列。 */}
            <span aria-hidden="true" className="absolute bottom-3 left-[11px] top-3 w-px bg-border" />
            {[
              {
                step: 1,
                title: '代理',
                state: proxy?.enabled ? '已启用' : proxy?.configured ? '已配置，未启用' : '未配置，可跳过',
                done: proxy?.enabled === true,
              },
              {
                step: 2,
                title: 'PAT',
                state: credential.configured ? '已配置' : '未配置',
                done: credential.configured,
              },
              {
                step: 3,
                title: '在线验证',
                state: credential.state === 'valid' ? '已完成' : '未完成',
                done: credential.state === 'valid',
              },
            ].map((item) => (
              <li key={item.step} className="relative flex items-center gap-3 py-2">
                <span
                  aria-hidden="true"
                  className={cn(
                    'relative z-10 flex size-6 shrink-0 items-center justify-center rounded-full border font-mono text-aux',
                    'transition-colors duration-150',
                    item.done
                      ? 'border-success/40 bg-success-subtle text-success'
                      : 'border-border-strong bg-surface text-muted',
                  )}
                >
                  {item.step}
                </span>
                <span className="font-medium text-text">{item.title}</span>
                <span className="text-muted">{item.state}</span>
              </li>
            ))}
          </ol>
          <p className="text-aux leading-relaxed text-muted">
            未解锁期间只能配置代理与 Token、修改密码；其余写操作由服务端拒绝。
          </p>
        </section>
      ) : null}

      {/* ---- 代理 ---- */}
      <Section
        icon={Network}
        title="代理"
        ariaLabel="代理配置"
        aside={[
          <SwitchControl
            key="proxy-enabled"
            label="启用代理"
            checked={proxy?.enabled === true}
            disabled={
              proxy === undefined || putProxyMutation.isPending || testProxyMutation.isPending || operationRunning
            }
            onCheckedChange={(next) => {
              if (next) {
                saveProxy();
              } else {
                disableProxy();
              }
            }}
          />,
          <IconButton
            key="proxy-save"
            icon={Save}
            tone="accent"
            label="保存代理配置"
            tooltip="保存并验证候选配置"
            onClick={saveProxy}
            disabled={putProxyMutation.isPending || operationRunning || proxy === undefined}
            aria-busy={putProxyMutation.isPending}
          />,
          <IconButton
            key="proxy-test"
            icon={PlugZap}
            label="测试代理连通性"
            tooltip="仅测试连通性，不保存"
            onClick={testProxyOnly}
            disabled={testProxyMutation.isPending || operationRunning}
            aria-busy={testProxyMutation.isPending}
          />,
        ]}
      >
        <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-[9rem_minmax(0,1fr)_10rem]">
          <Field label="协议" htmlFor="proxy-scheme">
            <SelectField
              id="proxy-scheme"
              ariaLabel="代理协议"
              className="h-10 w-full"
              value={proxyForm.scheme}
              onValueChange={(value) => {
                updateProxyForm({ scheme: value });
              }}
              options={[
                { value: 'http', label: 'HTTP' },
                { value: 'https', label: 'HTTPS' },
                { value: 'socks5', label: 'SOCKS5' },
              ]}
            />
          </Field>
          <Field label="主机" htmlFor="proxy-host" error={proxyFieldErrors['host']}>
            <Input
              id="proxy-host"
              value={proxyForm.host}
              placeholder="172.17.0.1 或 host.docker.internal"
              invalid={proxyFieldErrors['host'] !== undefined}
              spellCheck={false}
              autoComplete="off"
              onChange={(event) => {
                updateProxyForm({ host: event.target.value });
              }}
            />
          </Field>
          <Field label="端口" htmlFor="proxy-port" error={proxyFieldErrors['port']}>
            <Input
              id="proxy-port"
              value={proxyForm.port}
              inputMode="numeric"
              placeholder="1–65535"
              invalid={proxyFieldErrors['port'] !== undefined}
              onChange={(event) => {
                updateProxyForm({ port: filterPortInput(event.target.value) });
              }}
            />
          </Field>
        </div>
        <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-2">
          <Field
            label="账号"
            htmlFor="proxy-username"
            error={proxyFieldErrors['username']}
            hint={
              // 凭据不回显：只有"服务端已存有认证 + 当前表单未填"时才提醒，
              // 因为此时提交空值会把已配置的认证一并清掉。
              proxy?.usernameConfigured === true && proxyForm.username === '' && proxyForm.password === ''
                ? '认证已配置；留空保存会清除'
                : undefined
            }
          >
            <Input
              id="proxy-username"
              value={proxyForm.username}
              autoComplete="off"
              invalid={proxyFieldErrors['username'] !== undefined}
              onChange={(event) => {
                updateProxyForm({ username: event.target.value });
              }}
            />
          </Field>
          <Field label="密码" htmlFor="proxy-password" error={proxyFieldErrors['password']}>
            <PasswordInput
              id="proxy-password"
              revealLabel="代理密码"
              value={proxyForm.password}
              autoComplete="new-password"
              invalid={proxyFieldErrors['password'] !== undefined}
              onChange={(event) => {
                updateProxyForm({ password: event.target.value });
              }}
            />
          </Field>
        </div>
        {proxyError !== null ? (
          <p role="alert" className="text-aux2 text-danger">
            {proxyError}
          </p>
        ) : null}
      </Section>

      {/* ---- PAT ---- */}
      <Section
        icon={KeyRound}
        title="GitHub Token"
        ariaLabel="GitHub Token"
        aside={[
          <IconButton
            key="token-verify"
            icon={RefreshCw}
            label="重新验证当前 Token"
            onClick={verifyToken}
            disabled={verifyTokenMutation.isPending || operationRunning || credential?.configured !== true}
            aria-busy={verifyTokenMutation.isPending}
          />,
          credential?.configured === true ? (
            <IconButton
              key="token-clear"
              icon={Trash2}
              tone="danger"
              label="重置 Token"
              tooltip="重置 Token（清空后可重新填写）"
              onClick={() => {
                setClearTokenOpen(true);
              }}
              disabled={clearTokenMutation.isPending || operationRunning}
              aria-busy={clearTokenMutation.isPending}
            />
          ) : (
            <IconButton
              key="token-save"
              icon={Save}
              tone="accent"
              label="保存并验证 Token"
              onClick={submitToken}
              disabled={submitTokenMutation.isPending || operationRunning || tokenInput.length === 0}
              aria-busy={submitTokenMutation.isPending}
            />
          ),
        ]}
      >
        {/* 状态行：状态、有效期与最近错误；其余字段（类型提示、scope、配置时间、下次复核、额度）不再展示。 */}
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2 text-aux2" role="status">
          {credential === undefined ? (
            <span className="text-muted">正在读取状态…</span>
          ) : (
            <>
              {credential.state === 'valid' ? (
                <span className="gr-chip bg-success-subtle text-success">
                  <CircleCheck size={13} aria-hidden="true" />
                  {CREDENTIAL_STATE_TEXT[credential.state]}
                </span>
              ) : credential.state === 'invalid' || credential.state === 'expired' ? (
                <span className="gr-chip bg-danger-subtle text-danger">
                  <CircleX size={13} aria-hidden="true" />
                  {CREDENTIAL_STATE_TEXT[credential.state]}
                </span>
              ) : (
                <span className="gr-chip bg-warning-subtle text-warning">
                  <Clock size={13} aria-hidden="true" />
                  {CREDENTIAL_STATE_TEXT[credential.state]}
                </span>
              )}
              {credential.configured ? (
                <span className="text-muted">
                  有效期{' '}
                  {credential.expiresAt === null ? (
                    <span className="text-text">未提供</span>
                  ) : expiryDays !== null ? (
                    <TooltipHint
                      label={
                        expiryDays <= EXPIRY_URGENT_DAYS ? '不足 1 天，请尽快更新' : `剩余约 ${expiryDays} 天`
                      }
                    >
                      <span
                        className={cn(
                          'cursor-default text-text underline decoration-dotted underline-offset-4',
                          expiryDays <= EXPIRY_WARN_DAYS ? 'text-warning' : undefined,
                        )}
                      >
                        {formatBeijingDateTime(Date.parse(credential.expiresAt))}
                      </span>
                    </TooltipHint>
                  ) : (
                    <span className="text-text">未知</span>
                  )}
                </span>
              ) : null}
              {credential.lastErrorCode !== null ? (
                <span className="text-danger">最近错误 {errorCodeMessage(credential.lastErrorCode)}</span>
              ) : null}
            </>
          )}
        </div>

        {credential?.configured === true ? null : (
          <Field
            label="Personal Access Token"
            htmlFor="token-input"
            error={tokenError ?? undefined}
            hint="推荐 fine-grained 令牌：对监控的仓库授予 Metadata、Contents 读取权限"
          >
            <PasswordInput
              id="token-input"
              revealLabel="Token"
              value={tokenInput}
              autoComplete="off"
              spellCheck={false}
              invalid={tokenError !== null}
              placeholder="ghp_… 或 github_pat_…"
              onChange={(event) => {
                const next = filterTokenInput(event.target.value);
                setTokenInput(next);
                setTokenError(next.length === 0 || isValidGithubToken(next) ? null : GITHUB_TOKEN_INVALID);
              }}
            />
          </Field>
        )}

        {operation !== undefined ? (
          <div className="rounded-control border border-border bg-inset p-3.5 text-aux2" role="status" aria-live="polite">
            <p className="flex items-center gap-2 text-text">
              {operationRunning ? (
                <LoaderCircle size={15} aria-hidden="true" className="motion-safe:animate-spin text-accent" />
              ) : operation.status === 'succeeded' ? (
                <CircleCheck size={15} aria-hidden="true" className="text-success" />
              ) : (
                <CircleX size={15} aria-hidden="true" className="text-danger" />
              )}
              验证/测试操作：{OPERATION_STATUS_TEXT[operation.status]}
              {operation.errorCode !== null ? `（${errorCodeMessage(operation.errorCode)}）` : ''}
            </p>
            {operation.result?.probeStages != null ? (
              <ul className="mt-2 flex flex-wrap gap-1.5">
                {operation.result.probeStages.map((stage) => (
                  <li
                    key={stage.stage}
                    className={cn(
                      'gr-chip border',
                      stage.ok ? 'border-success/30 bg-success-subtle text-success' : 'border-danger/30 bg-danger-subtle text-danger',
                    )}
                  >
                    {stage.ok ? (
                      <CircleCheck size={12} aria-hidden="true" />
                    ) : (
                      <CircleX size={12} aria-hidden="true" />
                    )}
                    {PROBE_STAGE_TEXT[stage.stage]} · <span className="tabular-nums">{stage.elapsedMs}ms</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {tokenError !== null && credential?.configured === true ? (
          <p role="alert" className="text-aux2 text-danger">
            {tokenError}
          </p>
        ) : null}
      </Section>

      {/* ---- 全局默认 ---- */}
      <Section
        icon={ShieldCheck}
        title="全局默认"
        ariaLabel="全局默认设置"
        aside={[
          <IconButton
            key="settings-save"
            icon={Save}
            tone="accent"
            label="保存全局设置"
            onClick={saveSettings}
            disabled={!businessReady || settings === undefined || putSettingsMutation.isPending}
            aria-busy={putSettingsMutation.isPending}
          />,
        ]}
      >
        <fieldset disabled={!businessReady} className="flex flex-col gap-0 disabled:opacity-60">
          {!businessReady ? (
            <p className="text-aux text-muted">Token 验证完成后可修改（当前条目被业务门禁锁定）。</p>
          ) : null}
          <div className="flex flex-col gap-2.5 py-1">
            <span className="text-aux2 font-medium text-text">默认检测档位</span>
            <RadioGroupField
              ariaLabel="默认检测档位"
              value={intervalChoice}
              onValueChange={setIntervalChoice}
              options={INTERVAL_OPTIONS.map((hours) => ({ value: String(hours), label: `${hours} 小时` }))}
            />
          </div>
          {settingsError !== null ? (
            <p role="alert" className="mt-4 text-aux2 text-danger">
              {settingsError}
            </p>
          ) : null}
        </fieldset>
      </Section>

      {/* ---- 分类标签定义（业务门禁同样约束标签定义） ---- */}
      <LabelManager disabled={!businessReady} />

      {/* ---- 修改密码 ---- */}
      <Section
        icon={Lock}
        title="修改密码"
        ariaLabel="修改密码"
        aside={[
          <IconButton
            key="password-save"
            icon={Save}
            tone="accent"
            label="保存新密码"
            onClick={submitPassword}
            disabled={changePasswordMutation.isPending}
            aria-busy={changePasswordMutation.isPending}
          />,
        ]}
      >
        <div className="grid grid-cols-1 gap-x-3 gap-y-4 sm:grid-cols-3">
          <Field label="当前密码" htmlFor="password-current" error={passwordFieldErrors['current']}>
            <PasswordInput
              id="password-current"
              revealLabel="当前密码"
              value={passwordForm.current}
              autoComplete="current-password"
              invalid={passwordFieldErrors['current'] !== undefined}
              onChange={(event) => {
                updatePasswordField({ current: event.target.value });
              }}
            />
          </Field>
          <Field
            label="新密码"
            htmlFor="password-next"
            error={passwordFieldErrors['next']}
            hint={`${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 个字符，含大写、小写与数字；可选特殊字符仅 ${PASSWORD_ALLOWED_SYMBOLS}`}
          >
            <PasswordInput
              id="password-next"
              revealLabel="新密码"
              value={passwordForm.next}
              autoComplete="new-password"
              invalid={passwordFieldErrors['next'] !== undefined}
              placeholder={`${MIN_PASSWORD_LENGTH}–${MAX_PASSWORD_LENGTH} 个字符`}
              onChange={(event) => {
                updatePasswordField({ next: event.target.value });
              }}
            />
          </Field>
          <Field label="确认新密码" htmlFor="password-confirm" error={passwordFieldErrors['confirm']}>
            <PasswordInput
              id="password-confirm"
              revealLabel="确认新密码"
              value={passwordForm.confirm}
              autoComplete="new-password"
              invalid={passwordFieldErrors['confirm'] !== undefined}
              onChange={(event) => {
                updatePasswordField({ confirm: event.target.value });
              }}
            />
          </Field>
        </div>
        {passwordError !== null ? (
          <p role="alert" className="text-aux2 text-danger">
            {passwordError}
          </p>
        ) : null}
      </Section>

      {system !== undefined ? (
        <p className="text-aux text-muted">
          数据库版本 {system.database.schemaVersion ?? '—'} · 数据大小 {Math.round(system.database.sizeBytes / 1024 / 1024)} MiB
        </p>
      ) : null}

      <Modal
        open={clearTokenOpen}
        onOpenChange={setClearTokenOpen}
        title="重置 GitHub Token"
        description="清除已保存的 Token，代理配置不受影响。"
        size="sm"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => {
                setClearTokenOpen(false);
              }}
            >
              取消
            </Button>
            <Button
              variant="danger"
              onClick={clearToken}
              disabled={clearTokenMutation.isPending}
              aria-busy={clearTokenMutation.isPending}
            >
              重置 Token
            </Button>
          </>
        }
      >
        <p className="text-aux2 leading-relaxed text-text">
          重置后采集暂停，直到新的 Token 通过 <span className="font-mono">GET /user</span> 在线验证。
        </p>
      </Modal>
    </div>
  );
}
