import { loginUrl } from '../lib/api';

const MESSAGES: Record<string, string> = {
  wrong_tenant: 'That account belongs to a different organisation. This assistant is locked to yours.',
  not_allowed: 'Use an approved Arete Care Microsoft account to sign in.',
  access_denied: 'Sign in was cancelled.',
};

export default function SignIn() {
  const params = new URLSearchParams(window.location.search);
  const error = params.get('error');
  const consent = params.get('consent');
  const message = error ? (MESSAGES[error] ?? 'Sign in did not complete.') : null;

  return (
    <div className="flex h-full items-center justify-center px-6">
      <div className="w-full max-w-sm">
        <p className="label mb-4">Executive Assistant</p>
        <h1 className="h-display mb-3 text-3xl">Good to see you</h1>
        <p className="mb-8" style={{ color: 'var(--ink-soft)' }}>
          Sign in with your Arete Care Microsoft account. Your password is never shown to, or stored by, this
          application.
        </p>

        {consent === 'granted' && (
          <div
            className="mb-6 border-l-2 p-4 text-[0.94rem]"
            style={{ background: 'var(--sage-bg)', borderColor: 'var(--sage)', color: 'var(--ink)' }}
            role="status"
          >
            Permissions approved for your organisation. You can sign in now.
          </div>
        )}

        {consent === 'declined' && (
          <div
            className="mb-6 border-l-2 p-4 text-[0.94rem]"
            style={{ background: 'var(--clay-bg)', borderColor: 'var(--clay)', color: 'var(--ink)' }}
            role="alert"
          >
            Consent was declined, so the assistant cannot read the mailbox. An administrator needs to approve
            the permissions before sign in will work.
          </div>
        )}

        {message && (
          <div
            className="mb-6 border-l-2 p-4 text-[0.94rem]"
            style={{ background: 'var(--clay-bg)', borderColor: 'var(--clay)', color: 'var(--ink)' }}
            role="alert"
          >
            {message}
          </div>
        )}

        <a href={loginUrl} className="btn inline-block no-underline">
          Continue with Microsoft
        </a>

        <p className="label mt-10 leading-relaxed">
          Locked to one organisation · Read only to begin with · Nothing is sent without your approval
        </p>
      </div>
    </div>
  );
}
