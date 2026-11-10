/** Small UI kit: accessible primitives shared by every page. */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
} from 'react';
import { ApiError } from './api';

export const errorMessage = (e: unknown): string =>
  e instanceof ApiError ? e.message : e instanceof Error ? e.message : 'Something went wrong';

export function Logo({ size = 24 }: { size?: number }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" aria-hidden="true">
      <defs>
        <clipPath id="syncra-logo-clip">
          <circle cx="24" cy="32" r="18" />
        </clipPath>
      </defs>
      <circle cx="24" cy="32" r="18" fill="#faf8f3" />
      <circle cx="40" cy="32" r="18" fill="#cdf22b" />
      <circle cx="40" cy="32" r="18" fill="#08090b" clipPath="url(#syncra-logo-clip)" />
    </svg>
  );
}

type Variant = 'primary' | 'secondary' | 'danger';
const VARIANTS: Record<Variant, string> = {
  primary: 'btn-lift border border-primary bg-primary text-primary-contrast',
  secondary: 'btn-lift border border-line bg-surface text-fg hover:border-fg',
  danger: 'bg-danger text-white',
};

export function Button({
  variant = 'primary',
  loading,
  className = '',
  children,
  ...rest
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: Variant; loading?: boolean }) {
  return (
    <button
      {...rest}
      disabled={rest.disabled || loading}
      aria-busy={loading || undefined}
      className={`rounded-input px-3 py-2 font-medium disabled:opacity-60 ${VARIANTS[variant]} ${className}`}
    >
      {children}
    </button>
  );
}

export function Field({
  label,
  error,
  hint,
  ...rest
}: InputHTMLAttributes<HTMLInputElement> & {
  label: string;
  error?: string | undefined;
  hint?: string;
}) {
  const id = useId();
  const msg = error ? `${id}-err` : hint ? `${id}-hint` : undefined;
  return (
    <div className="mb-4">
      <label htmlFor={id} className="mb-1 block font-medium">
        {label}
      </label>
      <input
        id={id}
        {...rest}
        aria-invalid={error ? true : undefined}
        aria-describedby={msg}
        className="w-full rounded-input border border-line bg-bg px-3 py-2"
      />
      {error ? (
        <p id={`${id}-err`} role="alert" className="mt-1 text-danger">
          {error}
        </p>
      ) : hint ? (
        <p id={`${id}-hint`} className="mt-1 text-muted">
          {hint}
        </p>
      ) : null}
    </div>
  );
}

export function Card({
  title,
  actions,
  children,
}: {
  title?: string;
  actions?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="mb-6 rounded-card border border-line bg-surface p-4 transition-colors hover:border-fg/40">
      {(title ?? actions) && (
        <div className="mb-3 flex items-center justify-between gap-2">
          {title && <h2 className="font-semibold">{title}</h2>}
          {actions}
        </div>
      )}
      {children}
    </section>
  );
}

export function PageHeader({ title, children }: { title: string; children?: ReactNode }) {
  return (
    <div className="mb-4 flex flex-wrap items-center justify-between gap-2">
      <h1 className="text-2xl font-extrabold tracking-tight">{title}</h1>
      {children}
    </div>
  );
}

export function Skeleton({ rows = 3 }: { rows?: number }) {
  return (
    <div aria-busy="true" aria-label="Loading">
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton mb-2 h-8" />
      ))}
    </div>
  );
}

export function EmptyState({ title, action }: { title: string; action?: ReactNode }) {
  return (
    <div className="rounded-card border border-dashed border-line p-8 text-center">
      <p className="mb-3 text-muted">{title}</p>
      {action}
    </div>
  );
}

export function ErrorBanner({ error, retry }: { error: unknown; retry?: () => void }) {
  return (
    <div
      role="alert"
      className="mb-4 flex items-center justify-between gap-3 rounded-card border border-danger p-3 text-danger"
    >
      <span>{errorMessage(error)}</span>
      {retry && (
        <Button variant="secondary" onClick={retry}>
          Retry
        </Button>
      )}
    </div>
  );
}

/** Modal with a labelled dialog role, focus moved in on open and restored on close, Escape to close, Tab trapped. */
export function Modal({
  title,
  onClose,
  children,
  closable = true,
}: {
  title: string;
  onClose: () => void;
  children: ReactNode;
  closable?: boolean;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const titleId = useId();
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    const focusables = (): HTMLElement[] =>
      [
        ...(ref.current?.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        ) ?? []),
      ].filter((e) => !e.hasAttribute('disabled'));
    (focusables()[0] ?? ref.current)?.focus();
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape' && closable) onClose();
      if (e.key === 'Tab') {
        const f = focusables();
        const first = f[0];
        const last = f[f.length - 1];
        if (!first || !last) return;
        if (e.shiftKey && document.activeElement === first) {
          e.preventDefault();
          last.focus();
        } else if (!e.shiftKey && document.activeElement === last) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('keydown', onKey);
      previous?.focus();
    };
  }, [onClose, closable]);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4">
      <div
        ref={ref}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        className="max-h-[90vh] w-full max-w-lg overflow-y-auto rounded-card border border-line bg-bg p-5"
      >
        <h2 id={titleId} className="mb-3 text-lg font-semibold">
          {title}
        </h2>
        {children}
      </div>
    </div>
  );
}

export function Confirm({
  title,
  message,
  confirmLabel,
  requireText,
  onConfirm,
  onClose,
}: {
  title: string;
  message: string;
  confirmLabel: string;
  /** When set, the user must type this exactly before the button enables (tenant deletion). */
  requireText?: string;
  onConfirm: () => Promise<void> | void;
  onClose: () => void;
}) {
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<unknown>(null);
  return (
    <Modal title={title} onClose={onClose}>
      <p className="mb-3">{message}</p>
      {requireText !== undefined && (
        <Field
          label={`Type "${requireText}" to confirm`}
          value={typed}
          onChange={(e) => setTyped(e.target.value)}
        />
      )}
      {err !== null && <ErrorBanner error={err} />}
      <div className="flex justify-end gap-2">
        <Button variant="secondary" onClick={onClose}>
          Cancel
        </Button>
        <Button
          variant="danger"
          loading={busy}
          disabled={requireText !== undefined && typed !== requireText}
          onClick={() => {
            setBusy(true);
            Promise.resolve(onConfirm())
              .then(onClose)
              .catch((e: unknown) => {
                setErr(e);
                setBusy(false);
              });
          }}
        >
          {confirmLabel}
        </Button>
      </div>
    </Modal>
  );
}

/** Shows a secret exactly once. It cannot be dismissed until the user confirms they saved it. */
export function SecretModal({
  title,
  secret,
  onClose,
}: {
  title: string;
  secret: string;
  onClose: () => void;
}) {
  const [saved, setSaved] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <Modal title={title} onClose={onClose} closable={saved}>
      <p className="mb-2 text-muted">This is the only time it is shown. Store it somewhere safe.</p>
      <code
        data-testid="secret"
        className="mb-3 block break-all rounded-input bg-surface-2 p-3 font-mono"
      >
        {secret}
      </code>
      <div className="mb-4 flex items-center gap-3">
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard.writeText(secret).then(() => setCopied(true));
          }}
        >
          {copied ? 'Copied' : 'Copy'}
        </Button>
        <label className="flex items-center gap-2">
          <input type="checkbox" checked={saved} onChange={(e) => setSaved(e.target.checked)} />I
          saved this key
        </label>
      </div>
      <div className="flex justify-end">
        <Button disabled={!saved} onClick={onClose}>
          Done
        </Button>
      </div>
    </Modal>
  );
}

interface Toast {
  id: number;
  kind: 'ok' | 'error';
  text: string;
}
const ToastCtx = createContext<(kind: Toast['kind'], text: string) => void>(() => undefined);
export const useToast = (): ((kind: Toast['kind'], text: string) => void) => useContext(ToastCtx);

export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const push = useCallback((kind: Toast['kind'], text: string) => {
    const id = Date.now() + Math.random();
    setToasts((t) => [...t, { id, kind, text }]);
    setTimeout(() => {
      setToasts((t) => t.filter((x) => x.id !== id));
    }, 5000);
  }, []);
  return (
    <ToastCtx.Provider value={push}>
      {children}
      <div
        role="status"
        aria-live="polite"
        className="fixed bottom-4 right-4 z-[60] flex flex-col gap-2"
      >
        {toasts.map((t) => (
          <div
            key={t.id}
            className={`rounded-card border bg-bg px-4 py-2 shadow ${t.kind === 'error' ? 'border-danger text-danger' : 'border-line'}`}
          >
            {t.text}
          </div>
        ))}
      </div>
    </ToastCtx.Provider>
  );
}

export const fmtBytes = (n: number): string => {
  if (n < 1024) return `${String(n)} B`;
  const u = ['KB', 'MB', 'GB', 'TB'];
  let v = n / 1024;
  let i = 0;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 ? 1 : 0)} ${u[i] as string}`;
};

export const fmtNum = (n: number): string => n.toLocaleString('en-US');
export const fmtTime = (iso: string): string => new Date(iso).toLocaleString();

/** Quota bar with a text value, so the information is not conveyed by colour alone. */
export function Gauge({
  label,
  used,
  limit,
}: {
  label: string;
  used: number;
  limit: number | null;
}) {
  const pct = limit ? Math.min(100, (used / limit) * 100) : 0;
  const state = pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-warning' : 'bg-primary';
  return (
    <div className="mb-3">
      <div className="mb-1 flex justify-between">
        <span>{label}</span>
        <span className="text-muted">
          {limit === null ? `${fmtNum(used)} (unlimited)` : `${fmtNum(used)} / ${fmtNum(limit)}`}
        </span>
      </div>
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        className="h-2 rounded bg-surface-2"
      >
        <div className={`h-2 rounded ${state}`} style={{ width: `${String(pct)}%` }} />
      </div>
    </div>
  );
}
