/**
 * Least privilege, declared per capability.
 *
 * A scope only appears here because a specific capability needs it. When a
 * capability is switched off, its scopes are never requested. Nothing is
 * added "just in case" — see docs/MICROSOFT_GRAPH.md.
 */
export interface Capability {
  key: string;
  label: string;
  scopes: string[];
  /** Enabled capabilities have their scopes requested at sign-in. */
  enabled: boolean;
  note: string;
}

export const CAPABILITIES: Capability[] = [
  {
    key: 'identity',
    label: 'Sign in and read your profile',
    scopes: ['openid', 'profile', 'email', 'offline_access', 'User.Read'],
    enabled: true,
    note: 'Required. offline_access lets the assistant work without you present.',
  },
  {
    key: 'mailbox_settings',
    label: 'Read your working hours and timezone',
    scopes: ['MailboxSettings.Read'],
    enabled: true,
    note: 'Feeds the scheduling engine so it respects your actual working day.',
  },
  {
    key: 'mail_read',
    label: 'Read and search your email',
    scopes: ['Mail.Read'],
    enabled: true,
    note: 'Triage, follow-ups, answering questions about your inbox.',
  },
  {
    key: 'calendar_read',
    label: 'Read your calendar',
    scopes: ['Calendars.Read'],
    enabled: true,
    note: 'Answering questions about your day and finding free time.',
  },
  {
    key: 'contacts_read',
    label: 'Read your contacts',
    scopes: ['Contacts.Read', 'People.Read'],
    enabled: true,
    note: 'Resolving names like "Sarah" to the right person.',
  },

  // --- Not enabled yet. Turned on at the stage that needs them. ---
  {
    key: 'mail_write',
    label: 'Create draft replies',
    scopes: ['Mail.ReadWrite'],
    enabled: false,
    note: 'Stage: actions. Drafts only, never sends.',
  },
  {
    key: 'mail_send',
    label: 'Send email on your behalf',
    scopes: ['Mail.Send'],
    enabled: false,
    note: 'Stage: actions. Always behind an explicit approval.',
  },
  {
    key: 'calendar_write',
    label: 'Create and change meetings',
    scopes: ['Calendars.ReadWrite'],
    enabled: false,
    note: 'Stage: actions. Always behind an explicit approval.',
  },
  {
    key: 'tasks',
    label: 'Manage your tasks and reminders',
    scopes: ['Tasks.ReadWrite'],
    enabled: false,
    note: 'Stage: reminders.',
  },
];

/** Scopes actually requested at sign-in, deduplicated. */
export function activeScopes(): string[] {
  const scopes = CAPABILITIES.filter((c) => c.enabled).flatMap((c) => c.scopes);
  return [...new Set(scopes)];
}

/** Scopes minus the OIDC ones MSAL adds implicitly. */
export function activeGraphScopes(): string[] {
  const oidc = new Set(['openid', 'profile', 'email', 'offline_access']);
  return activeScopes().filter((s) => !oidc.has(s));
}

export function capabilityForScope(scope: string): Capability | undefined {
  return CAPABILITIES.find((c) => c.scopes.includes(scope));
}

export function isCapabilityEnabled(key: string): boolean {
  return CAPABILITIES.some((c) => c.key === key && c.enabled);
}
