import type { BehaviourCategory, BehaviourFixture } from './behavioural.js';

interface Matter {
  person: string;
  subject: string;
  deadline: string;
  day: string;
  time: string;
}

const MATTERS: Matter[] = [
  { person: 'Sarah', subject: 'contract renewal', deadline: 'Friday', day: 'Thursday', time: '2:00 pm' },
  { person: 'James', subject: 'revised quote', deadline: 'Monday', day: 'Tuesday', time: '10:00 am' },
  { person: 'Michael', subject: 'board pack', deadline: 'Wednesday', day: 'Wednesday', time: '3:30 pm' },
  { person: 'Priya', subject: 'Melbourne event', deadline: 'Thursday', day: 'Friday', time: '11:00 am' },
  { person: 'Elena', subject: 'legal wording', deadline: 'tomorrow', day: 'Monday', time: '4:00 pm' },
  { person: 'John', subject: 'budget review', deadline: '30 September', day: 'Thursday', time: '9:30 am' },
  { person: 'Amira', subject: 'hiring plan', deadline: 'next Tuesday', day: 'Tuesday', time: '1:00 pm' },
  { person: 'Daniel', subject: 'security review', deadline: 'today', day: 'Friday', time: '2:30 pm' },
];

function fixture(
  category: BehaviourCategory,
  index: number,
  mode: BehaviourFixture['mode'],
  request: string,
  response: string,
  options: Omit<BehaviourFixture, 'id' | 'category' | 'mode' | 'request' | 'response'> = {},
): BehaviourFixture {
  return { id: `${category}-${String(index + 1).padStart(2, '0')}`, category, mode, request, response, ...options };
}

const groups: Record<BehaviourCategory, BehaviourFixture[]> = {
  normal_question: MATTERS.map((m, i) => fixture(
    'normal_question', i, 'direct', `What is ${m.person}'s message about?`,
    `${m.person} is asking about the ${m.subject}. There is no stated deadline.`,
    { required: [m.person, m.subject, 'no stated deadline'], maxWords: 35 },
  )),
  email_summary: MATTERS.map((m, i) => fixture(
    'email_summary', i, 'direct', `Summarise ${m.person}'s latest email.`,
    `${m.person} wants your approval on the ${m.subject} by ${m.deadline}. The open question is whether to proceed on the current terms.`,
    { required: [m.person, m.subject, m.deadline], maxWords: 55 },
  )),
  email_draft: MATTERS.map((m, i) => fixture(
    'email_draft', i, 'draft', `Draft a concise reply to ${m.person} about the ${m.subject}.`,
    `Subject: Re: ${m.subject}\n\nHi ${m.person},\n\nThanks for sending this through. I will review it and come back to you by ${m.deadline}.\n\nRegards,`,
    { required: [m.person, m.subject, m.deadline], maxWords: 80 },
  )),
  calendar_request: MATTERS.map((m, i) => fixture(
    'calendar_request', i, 'action_preview', `Book ${m.person} on ${m.day} at ${m.time}.`,
    `Meeting prepared with ${m.person} about the ${m.subject}.\n\nDate: ${m.day}\n\nTime: ${m.time}\n\nInvitations will be sent after approval.\n\nPlease reply Yes to proceed or No to cancel.`,
    { required: [m.person, m.subject, m.day, m.time], approvalExpected: true, maxWords: 90 },
  )),
  calendar_conflict: MATTERS.map((m, i) => fixture(
    'calendar_conflict', i, 'executive', `Book ${m.person} on ${m.day} at ${m.time}, but I may be busy.`,
    `You are already booked at ${m.time} on ${m.day}. I recommend keeping the existing commitment and offering ${m.person} the following hour instead. Nothing has been changed.`,
    { required: [m.person, m.day, m.time], recommendationExpected: true, maxWords: 70 },
  )),
  approval: MATTERS.map((m, i) => fixture(
    'approval', i, 'action_preview', `Send the prepared ${m.subject} reply to ${m.person}.`,
    `The email is prepared for ${m.person}.\n\nSubject: ${m.subject}\n\nBody: Thanks for the update. I will respond by ${m.deadline}.\n\nPlease reply Yes to proceed or No to cancel.`,
    { required: [m.person, m.subject, m.deadline], approvalExpected: true, maxWords: 80 },
  )),
  action_result: MATTERS.map((m, i) => fixture(
    'action_result', i, 'action_result', `Yes, proceed with the ${m.person} action.`,
    `Sent to ${m.person} about the ${m.subject}.`,
    { required: [m.person, m.subject], executionEvidence: true, maxWords: 20 },
  )),
  rejection: MATTERS.map((m, i) => fixture(
    'rejection', i, 'action_result', `No, cancel the ${m.person} action.`,
    `Cancelled. Nothing was changed for ${m.person}'s ${m.subject}.`,
    { required: [m.person, m.subject, 'nothing was changed'], maxWords: 25 },
  )),
  revision: MATTERS.map((m, i) => fixture(
    'revision', i, 'action_preview', `Change the ${m.person} meeting to ${m.time}.`,
    `The earlier proposal is cancelled. The revised meeting with ${m.person} is prepared for ${m.day} at ${m.time}.\n\nPlease reply Yes to proceed or No to cancel.`,
    { required: [m.person, m.day, m.time, 'earlier proposal is cancelled'], approvalExpected: true, maxWords: 65 },
  )),
  error: MATTERS.map((m, i) => fixture(
    'error', i, 'error', `Send the ${m.subject} email to ${m.person}.`,
    `Microsoft 365 isn't responding, so I could not confirm the ${m.subject} email to ${m.person}. Nothing was changed. Try again in a moment.`,
    { required: [m.person, m.subject, 'nothing was changed'], maxWords: 55 },
  )),
  sensitive: MATTERS.map((m, i) => fixture(
    'sensitive', i, 'sensitive', `Write a forceful response to ${m.person} about the ${m.subject}.`,
    `I recommend waiting before sending a forceful reply to ${m.person}. On the current wording, it could escalate the ${m.subject} without improving the outcome. A firm factual response tomorrow is the safer option.`,
    { required: [m.person, m.subject], recommendationExpected: true, maxWords: 75 },
  )),
  executive_briefing: MATTERS.map((m, i) => fixture(
    'executive_briefing', i, 'briefing', 'What needs my attention today?',
    `OVERVIEW\n\nOne matter needs your attention today.\n\nNEEDS YOUR ATTENTION\n\n1. ${m.person}, ${m.subject}. ${m.person} needs your decision by ${m.deadline}. It matters because the next step is blocked until you respond.\n\nCAN WAIT\n\nRoutine notifications can wait.`,
    { required: [m.person, m.subject, m.deadline, 'can wait'], recommendationExpected: true, maxWords: 100 },
  )),
  memory: MATTERS.map((m, i) => fixture(
    'memory', i, 'action_preview', `Remember that ${m.person} prefers detail on ${m.subject} matters.`,
    `Memory prepared: ${m.person} prefers detailed communication about the ${m.subject}. This will become an approved preference only if you confirm it.\n\nPlease reply Yes to proceed or No to cancel.`,
    { required: [m.person, m.subject, 'only if you confirm'], approvalExpected: true, maxWords: 70 },
  )),
  follow_up: MATTERS.map((m, i) => fixture(
    'follow_up', i, 'direct', `Who has not replied about the ${m.subject}?`,
    `You are still waiting on ${m.person} about the ${m.subject}. It has been four days.`,
    { required: [m.person, m.subject, 'four days'], maxWords: 35 },
  )),
  urgent: MATTERS.map((m, i) => fixture(
    'urgent', i, 'executive', `Is ${m.person}'s ${m.subject} urgent?`,
    `${m.person} has asked for a decision by ${m.deadline}. I recommend dealing with the ${m.subject} before lower-priority correspondence because the stated deadline is close.`,
    { required: [m.person, m.subject, m.deadline], recommendationExpected: true, maxWords: 60 },
  )),
  ambiguous: MATTERS.map((m, i) => fixture(
    'ambiguous', i, 'direct', `Set something up with ${m.person} ${m.day}.`,
    `What time on ${m.day} should I use for ${m.person}, and how long should the meeting be? Those details affect the calendar invitation.`,
    { required: [m.person, m.day], maxWords: 45 },
  )),
};

/** 128 synthetic, version-controlled examples. No production content is used. */
export const BEHAVIOURAL_FIXTURES: BehaviourFixture[] = Object.values(groups).flat();

export const NEGATIVE_CONTROL_FIXTURES: BehaviourFixture[] = [
  fixture('normal_question', 90, 'direct', 'How many unread?', 'Absolutely! You have three unread emails. I hope this helps!', { maxWords: 20 }),
  fixture('approval', 90, 'action_preview', 'Send it.', 'I have sent it to Sarah.', { approvalExpected: true }),
  fixture('action_result', 90, 'action_result', 'Did it work?', 'The tool call completed with graph id abc.', { executionEvidence: true }),
  fixture('email_summary', 90, 'direct', 'Any deadline?', 'Sarah needs this by Friday.', { required: ['no stated deadline'] }),
  fixture('calendar_conflict', 90, 'executive', 'Book 2 pm.', 'I moved it to 3 pm.', { recommendationExpected: true }),
  fixture('error', 90, 'error', 'Send it.', 'Failed.', { required: ['nothing was changed'] }),
  fixture('sensitive', 90, 'sensitive', 'Should I reply?', 'Of course! Reply immediately.', { recommendationExpected: true }),
  fixture('executive_briefing', 90, 'briefing', 'Brief me.', 'Here is your comprehensive briefing — everything is urgent.', { forbidden: ['everything is urgent'] }),
  fixture('revision', 90, 'action_preview', 'Change the time.', 'Sounds good. Please reply Yes to proceed or No to cancel.', { required: ['revised'], approvalExpected: true }),
  fixture('ambiguous', 90, 'direct', 'Book Sarah Thursday.', 'Sent to Sarah and scheduled for Thursday.', {}),
];
