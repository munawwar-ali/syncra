import { useState, type FormEvent, type ReactNode } from 'react';
import { Link, Navigate, useNavigate, useSearchParams } from 'react-router-dom';
import { z } from 'zod';
import { useAuth } from '../auth';
import { useTitle } from '../hooks';
import { Button, ErrorBanner, Field, Logo, SecretModal } from '../ui';

const email = z.string().trim().email('Enter a valid email address');
const password = z.string().min(10, 'Use at least 10 characters');

type Errors = Record<string, string | undefined>;

function validate<T extends z.ZodRawShape>(
  shape: T,
  values: Record<string, string>,
): { ok: true } | { ok: false; errors: Errors } {
  const r = z.object(shape).safeParse(values);
  if (r.success) return { ok: true };
  const errors: Errors = {};
  for (const i of r.error.issues) errors[String(i.path[0])] ??= i.message;
  return { ok: false, errors };
}

function AuthShell({
  title,
  children,
  footer,
}: {
  title: string;
  children: ReactNode;
  footer: ReactNode;
}) {
  useTitle(title);
  return (
    <main className="page-in mx-auto mt-14 max-w-sm px-4">
      <div className="mb-6 flex items-center gap-2 rounded-card bg-ink px-4 py-3 text-lg font-bold tracking-tight text-ivory">
        <Logo size={28} />
        syncra
      </div>
      <div className="rounded-card border border-line bg-surface p-6 shadow-[6px_6px_0_var(--lime)]">
        <h1 className="mb-1 text-2xl font-extrabold tracking-tight">{title}</h1>
        <p className="mb-6 text-muted">Syncra, the self-hostable sync engine.</p>
        {children}
        <p className="mt-4 text-muted">{footer}</p>
      </div>
    </main>
  );
}

export function Login() {
  const auth = useAuth();
  const nav = useNavigate();
  const [v, setV] = useState({ email: '', password: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [fail, setFail] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (auth.status === 'authenticated') return <Navigate to="/" replace />;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const r = validate({ email, password: z.string().min(1, 'Enter your password') }, v);
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    setBusy(true);
    auth
      .login(v.email.trim(), v.password)
      .then(() => nav('/'))
      .catch((err: unknown) => {
        setFail(err);
        setBusy(false);
      });
  };
  return (
    <AuthShell
      title="Log in"
      footer={
        <>
          No account?{' '}
          <Link className="underline" to="/signup">
            Sign up
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        {fail !== null && <ErrorBanner error={fail} />}
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={v.email}
          error={errors.email}
          onChange={(e) => setV({ ...v, email: e.target.value })}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="current-password"
          value={v.password}
          error={errors.password}
          onChange={(e) => setV({ ...v, password: e.target.value })}
        />
        <Button type="submit" loading={busy} className="w-full">
          Log in
        </Button>
      </form>
    </AuthShell>
  );
}

export function Signup() {
  const auth = useAuth();
  const nav = useNavigate();
  const [v, setV] = useState({ name: '', tenantName: '', email: '', password: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [fail, setFail] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const [keys, setKeys] = useState<{ secretKey: string; publishableKey: string } | null>(null);
  // The session becomes authenticated a moment before the keys arrive; do not redirect while signing up.
  const [signingUp, setSigningUp] = useState(false);
  if (auth.status === 'authenticated' && !signingUp) return <Navigate to="/" replace />;

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    const r = validate(
      {
        name: z.string().trim().min(1, 'Enter your name'),
        tenantName: z.string().trim().min(1, 'Name your organization'),
        email,
        password,
      },
      v,
    );
    if (!r.ok) return setErrors(r.errors);
    setErrors({});
    setBusy(true);
    setSigningUp(true);
    auth
      .signup({ ...v, email: v.email.trim(), name: v.name.trim(), tenantName: v.tenantName.trim() })
      .then(setKeys)
      .catch((err: unknown) => {
        setFail(err);
        setBusy(false);
        setSigningUp(false);
      });
  };
  return (
    <AuthShell
      title="Create your account"
      footer={
        <>
          Have an account?{' '}
          <Link className="underline" to="/login">
            Log in
          </Link>
        </>
      }
    >
      <form onSubmit={submit} noValidate>
        {fail !== null && <ErrorBanner error={fail} />}
        <Field
          label="Your name"
          autoComplete="name"
          value={v.name}
          error={errors.name}
          onChange={(e) => setV({ ...v, name: e.target.value })}
        />
        <Field
          label="Organization"
          value={v.tenantName}
          error={errors.tenantName}
          onChange={(e) => setV({ ...v, tenantName: e.target.value })}
        />
        <Field
          label="Email"
          type="email"
          autoComplete="email"
          value={v.email}
          error={errors.email}
          onChange={(e) => setV({ ...v, email: e.target.value })}
        />
        <Field
          label="Password"
          type="password"
          autoComplete="new-password"
          hint="At least 10 characters"
          value={v.password}
          error={errors.password}
          onChange={(e) => setV({ ...v, password: e.target.value })}
        />
        <Button type="submit" loading={busy} className="w-full">
          Create account
        </Button>
      </form>
      {keys && (
        <SecretModal title="Your secret API key" secret={keys.secretKey} onClose={() => nav('/')} />
      )}
    </AuthShell>
  );
}

export function AcceptInvite() {
  const auth = useAuth();
  const nav = useNavigate();
  const [params] = useSearchParams();
  const token = params.get('token') ?? '';
  const [v, setV] = useState({ name: '', password: '' });
  const [errors, setErrors] = useState<Errors>({});
  const [fail, setFail] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);

  const submit = (e: FormEvent): void => {
    e.preventDefault();
    // An existing user can accept with no extra fields; a new one needs a name and a password.
    const filled = v.name !== '' || v.password !== '';
    if (filled) {
      const r = validate({ name: z.string().trim().min(1, 'Enter your name'), password }, v);
      if (!r.ok) return setErrors(r.errors);
    }
    setErrors({});
    setBusy(true);
    auth
      .acceptInvite({ token, ...(filled ? { name: v.name.trim(), password: v.password } : {}) })
      .then(() => nav('/'))
      .catch((err: unknown) => {
        setFail(err);
        setBusy(false);
      });
  };
  return (
    <AuthShell
      title="Join your team"
      footer={<>Already have an account? Leave the fields empty and continue.</>}
    >
      {token === '' ? (
        <ErrorBanner error="This invitation link is missing its token." />
      ) : (
        <form onSubmit={submit} noValidate>
          {fail !== null && <ErrorBanner error={fail} />}
          <Field
            label="Your name"
            value={v.name}
            error={errors.name}
            onChange={(e) => setV({ ...v, name: e.target.value })}
          />
          <Field
            label="Choose a password"
            type="password"
            autoComplete="new-password"
            value={v.password}
            error={errors.password}
            onChange={(e) => setV({ ...v, password: e.target.value })}
          />
          <Button type="submit" loading={busy} className="w-full">
            Accept invitation
          </Button>
        </form>
      )}
    </AuthShell>
  );
}
