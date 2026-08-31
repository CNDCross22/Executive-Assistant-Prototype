const API_BASE = import.meta.env.VITE_API_URL ?? 'http://localhost:4000';

export interface ApiErrorBody {
  code: string;
  message: string;
  detail?: string;
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    readonly detail?: string,
  ) {
    super(message);
    this.name = 'ApiError';
  }
}

async function request<T>(path: string, init: RequestInit = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      ...init,
      credentials: 'include',
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...init.headers,
      },
    });
  } catch {
    throw new ApiError(0, 'offline', 'I could not reach the assistant server.', 'Is the API running on port 4000?');
  }

  if (res.status === 204) return undefined as T;

  const payload = await res.json().catch(() => null);

  if (!res.ok) {
    const body = (payload as { error?: ApiErrorBody } | null)?.error;
    throw new ApiError(res.status, body?.code ?? 'unknown', body?.message ?? 'Something went wrong.', body?.detail);
  }

  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'POST', body: body === undefined ? undefined : JSON.stringify(body) }),
  patch: <T>(path: string, body?: unknown) =>
    request<T>(path, { method: 'PATCH', body: body === undefined ? undefined : JSON.stringify(body) }),
  del: <T>(path: string) => request<T>(path, { method: 'DELETE' }),
};

export const loginUrl = `${API_BASE}/api/auth/login`;

// --- shapes returned by the API -------------------------------------------

export interface SetupCheck {
  key: string;
  label: string;
  ready: boolean;
  detail: string;
  action?: string;
}

export interface Spend {
  monthToDate: string;
  budget: string;
  percentUsed: number;
  callsThisMonth: number;
  projectedMonthEnd: string;
  overBudget: boolean;
  categories?: Record<string, {
    monthToDate: string;
    budget: string | null;
    percentUsed: number | null;
    overBudget: boolean;
  }>;
}

export interface SetupResponse {
  ready: boolean;
  checks: SetupCheck[];
  capabilities?: { key: string; label: string; enabled: boolean; note: string; scopes: string[] }[];
  ai?: {
    provider: 'openai';
    model: string;
    roles?: Record<string, { model: string; reasoningEffort: string }>;
    adaptiveResponseLimits?: boolean;
  };
  soul?: { source: string; words: number; approxTokens: number };
  spend?: Spend;
}

export interface MeResponse {
  authenticated: boolean;
  /** Fixture mailbox, no Microsoft account. Always surfaced in the UI. */
  demo?: boolean;
  setup: { ready: boolean; checks: SetupCheck[] };
  user?: {
    id: string;
    email: string;
    displayName: string;
    jobTitle: string | null;
    timezone: string;
  };
  microsoft?: { status: 'connected' | 'needs_reauth' };
}

export interface Step {
  tool: string;
  summary: string;
  status: 'success' | 'failed' | 'approval_required';
}

export interface ActionPreview {
  title: string;
  summary: string;
  details: Array<{ label: string; value: string }>;
  warning?: string;
}

export interface PendingApproval {
  id: string;
  preview: ActionPreview;
  expiresAt: string;
}

export interface ConversationSummary {
  id: string;
  title: string;
  messageCount: number;
  lastMessageAt: string;
  pinned: boolean;
}

export interface StoredMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  steps: Step[];
  approval?: PendingApproval;
  model: string | null;
  durationMs: number | null;
  wasBlocked: boolean;
  createdAt: string;
}

export interface ChatResponse {
  conversationId: string;
  reply: string;
  steps: Step[];
  approval?: PendingApproval;
  meta: { iterations: number; model: string; durationMs: number };
}
