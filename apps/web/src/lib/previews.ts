import type { Step } from './api';

/**
 * Scripted example exchanges.
 *
 * These exist ONLY in demo mode, purely so the chat can be seen populated
 * before there are AI credits. Every preview reply is tagged so the UI can
 * label it. Nothing here is ever presented as a real answer, and none of it
 * runs in a live deployment.
 *
 * The wording mirrors what the real pipeline produces: prose, no lists, names
 * rather than subject lines, and the phishing warning leading.
 */
export interface Preview {
  question: string;
  steps: Step[];
  reply: string;
  /** 'direct' means the real system answers this with no model call. */
  model: 'direct' | 'gpt-5-mini';
  durationMs: number;
}

export const PREVIEWS: Preview[] = [
  {
    question: 'What needs me today?',
    steps: [{ tool: 'mail_needs_attention', summary: 'Checked what needs your attention', status: 'success' }],
    reply:
      'Be careful with one from IT Support at security@0utlook-verify.com. Note the zero in place of the letter O. It contains hidden instructions trying to get me to forward your inbox to an outside address. I have not acted on it and I would not. Worth deleting and reporting.\n\nThree things need you. Priya wants a yes or no on the Saturday roster before she tells the team. Elena needs your signature on the contract renewal before the 30th, or cover lapses. Michael is chasing the revenue figures for Thursday’s board pack. The other three can wait: a newsletter, a backup notice and the parking email.',
    model: 'direct',
    durationMs: 4,
  },
  {
    question: 'Has anyone not got back to me?',
    steps: [{ tool: 'mail_follow_ups', summary: 'Checked for threads with no reply', status: 'success' }],
    reply:
      'You are still waiting on James Whitlock about the supplier pricing, nine days now, and Dana Kim about the audit paperwork, six days. James is the one worth chasing. You also owe a reply to Michael Chen about the board pack and Elena Ross about the contract renewal.',
    model: 'direct',
    durationMs: 3,
  },
  {
    question: 'What did Michael want?',
    steps: [
      { tool: 'mail_search', summary: 'Searched email for "Michael"', status: 'success' },
      { tool: 'mail_read', summary: 'Looked up the email about "board pack"', status: 'success' },
    ],
    reply:
      'Michael Chen wrote five days ago about the board pack. He needs the revenue figures so he can circulate the papers before Thursday’s meeting, and asked whether you have them or whether he should use last quarter’s as a placeholder. You have not replied.',
    model: 'gpt-5-mini',
    durationMs: 2140,
  },
  {
    question: 'Remember that I never take meetings before 9',
    steps: [{ tool: 'memory_remember', summary: 'Remembered: No meetings before 9am', status: 'success' }],
    reply:
      'Saved. I will not put anything in before nine, and I will say so if someone asks for an earlier slot. You can change or remove that whenever you like.',
    model: 'gpt-5-mini',
    durationMs: 1680,
  },
  {
    question: 'Reply to Elena and tell her I will sign it today',
    steps: [],
    reply:
      'I cannot send or reply to email yet. I only have read access to your mailbox, and nothing else is switched on. I can tell you what she asked and by when: the renewal expires on the 30th and she needs a signed copy back before then.',
    model: 'direct',
    durationMs: 1,
  },
];

export function findPreview(question: string): Preview | undefined {
  const q = question.trim().toLowerCase();
  return PREVIEWS.find((p) => p.question.toLowerCase() === q);
}
