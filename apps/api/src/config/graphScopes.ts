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
    label: 'Manage mailbox settings',
    scopes: ['MailboxSettings.ReadWrite'],
    enabled: true,
    note: 'Working hours, timezone, categories and automatic replies. Changes still require approval.',
  },
  {
    key: 'mail_read',
    label: 'Read and search your email',
    scopes: ['Mail.ReadWrite'],
    enabled: true,
    note: 'Triage, follow-ups, answering questions about your inbox.',
  },
  {
    key: 'calendar_read',
    label: 'Read your calendar',
    scopes: ['Calendars.ReadWrite'],
    enabled: true,
    note: 'Answering questions about your day and finding free time.',
  },
  {
    key: 'contacts_read',
    label: 'Read your contacts',
    scopes: ['Contacts.ReadWrite', 'People.Read', 'User.ReadBasic.All'],
    enabled: true,
    note: 'Resolving names like "Sarah" to the right person.',
  },
  {
    key: 'teams_structure',
    label: 'Read your Teams and channels',
    scopes: ['Team.ReadBasic.All', 'Channel.ReadBasic.All'],
    enabled: true,
    note: 'Read-only team and channel discovery. Hermes cannot join or change a team.',
  },
  {
    key: 'teams_messages',
    label: 'Read Teams channel posts',
    scopes: ['ChannelMessage.Read.All'],
    enabled: true,
    note: 'Read-only channel messages. Hermes cannot send, reply, react, edit or delete.',
  },
  {
    key: 'onedrive_read',
    label: 'Read your OneDrive files',
    scopes: ['Files.Read'],
    enabled: true,
    note: 'Read-only discovery and bounded text extraction. No upload, sharing, move or delete.',
  },
  {
    key: 'sharepoint_read',
    label: 'Read accessible SharePoint sites',
    scopes: ['Sites.Read.All'],
    enabled: true,
    note: 'Read-only site and file discovery. No SharePoint changes are available.',
  },

  // --- Write capabilities. Every operation is still approval-gated. ---
  {
    key: 'mail_write',
    label: 'Create draft replies',
    scopes: ['Mail.ReadWrite'],
    enabled: true,
    note: 'Drafts and mailbox changes. Every action requires an explicit preview and confirmation.',
  },
  {
    key: 'mail_send',
    label: 'Send email on your behalf',
    scopes: ['Mail.Send'],
    enabled: true,
    note: 'Always behind an explicit preview and approval.',
  },
  {
    key: 'calendar_write',
    label: 'Create and change meetings',
    scopes: ['Calendars.ReadWrite'],
    enabled: true,
    note: 'Always behind an explicit preview and approval.',
  },
  {
    key: 'tasks',
    label: 'Manage your tasks and reminders',
    scopes: ['Tasks.ReadWrite'],
    enabled: true,
    note: 'Always behind an explicit preview and approval.',
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
