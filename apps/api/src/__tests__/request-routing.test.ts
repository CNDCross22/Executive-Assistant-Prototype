import { describe, test } from 'node:test';
import assert from 'node:assert/strict';

import { availableTools } from '../agent/registry.js';
import { interpretRequest, permittedToolsForIntent, type RequestDomain, type RequestOperation } from '../agent/request-intent.js';
import { mailRequestParameters } from '../mail/request-parameters.js';

interface Scenario {
  request: string;
  operation: RequestOperation;
  domains: RequestDomain[];
  includes?: string[];
}

function plan(request: string, history: Array<{ role: 'user' | 'assistant'; content: string }> = []) {
  const intent = interpretRequest(request, history);
  return { intent, tools: permittedToolsForIntent(intent, availableTools()) };
}

describe('Director request capability routing matrix', () => {
  const scenarios: Scenario[] = [
    { request: 'Give me a summary of my inbox.', operation: 'read', domains: ['mail'], includes: ['mail_inbox_summary'] },
    { request: 'How many unread emails do I have?', operation: 'read', domains: ['mail'], includes: ['mail_recent'] },
    { request: "Read Sarah's latest email.", operation: 'read', domains: ['mail'], includes: ['mail_search', 'mail_read'] },
    { request: 'Who has not replied to my emails?', operation: 'read', domains: ['mail'], includes: ['mail_follow_ups'] },
    { request: 'Which messages need my attention?', operation: 'read', domains: ['mail'], includes: ['mail_needs_attention'] },
    { request: 'Can you check the 5 important emails to attend or reply to?', operation: 'read', domains: ['mail'], includes: ['mail_needs_attention'] },
    { request: 'Show me the top ten priority messages from the last two weeks.', operation: 'read', domains: ['mail'], includes: ['mail_needs_attention'] },
    { request: 'What are my emails for the past 1 week?', operation: 'read', domains: ['mail'], includes: ['mail_recent'] },
    { request: 'List 50 unread emails from the previous 30 days.', operation: 'read', domains: ['mail'], includes: ['mail_recent'] },
    { request: 'What came in today?', operation: 'read', domains: ['mail'], includes: ['mail_recent'] },
    { request: 'List the attachments on this email.', operation: 'read', domains: ['mail'], includes: ['mail_list_attachments'] },
    { request: 'Draft an email to the board.', operation: 'write', domains: ['mail'], includes: ['mail_create_draft'] },
    { request: 'Send an email to Carlo.', operation: 'write', domains: ['mail'], includes: ['mail_send'] },
    { request: 'Reply to the latest message from Sarah.', operation: 'write', domains: ['mail'], includes: ['mail_reply'] },
    { request: 'Forward this email to Priya.', operation: 'write', domains: ['mail'], includes: ['mail_forward'] },
    { request: 'Archive this email.', operation: 'write', domains: ['mail'], includes: ['mail_move'] },
    { request: 'Delete that email.', operation: 'write', domains: ['mail'], includes: ['mail_delete'] },

    { request: 'Can you summarise my calendar? Do I have upcoming events?', operation: 'read', domains: ['calendar'], includes: ['calendar_upcoming'] },
    { request: 'What is on my calendar tomorrow?', operation: 'read', domains: ['calendar'], includes: ['calendar_list'] },
    { request: 'Search my calendar for Melbourne Opera.', operation: 'read', domains: ['calendar'], includes: ['calendar_search'] },
    { request: 'When are Sarah and I both available?', operation: 'read', domains: ['calendar'], includes: ['calendar_find_slots'] },
    { request: 'Book a meeting with Sarah next Tuesday.', operation: 'write', domains: ['calendar'], includes: ['calendar_create', 'directory_search'] },
    { request: 'Move that meeting to tomorrow.', operation: 'write', domains: ['calendar'], includes: ['calendar_update'] },
    { request: 'Add Carlo as an attendee to the meeting.', operation: 'write', domains: ['calendar'], includes: ['calendar_update', 'directory_search'] },
    { request: 'Cancel the Melbourne Opera calendar event.', operation: 'write', domains: ['calendar'], includes: ['calendar_delete'] },
    { request: 'Accept the calendar invitation.', operation: 'write', domains: ['calendar'], includes: ['calendar_respond'] },

    { request: 'Show my task lists.', operation: 'read', domains: ['tasks'], includes: ['task_lists'] },
    { request: 'What tasks are due?', operation: 'read', domains: ['tasks'], includes: ['tasks_list'] },
    { request: 'Create a task to review the contract.', operation: 'write', domains: ['tasks'], includes: ['task_create'] },
    { request: 'Complete this task.', operation: 'write', domains: ['tasks'], includes: ['task_update'] },
    { request: 'Delete that reminder.', operation: 'write', domains: ['tasks'], includes: ['task_delete'] },

    { request: "Find Sarah's email address.", operation: 'read', domains: ['contacts'], includes: ['contacts_search', 'directory_search'] },
    { request: 'Search the company directory for Carlo.', operation: 'read', domains: ['contacts'], includes: ['directory_search'] },
    { request: 'Add Priya to my contacts.', operation: 'write', domains: ['contacts'], includes: ['contact_create'] },
    { request: 'Update this contact.', operation: 'write', domains: ['contacts'], includes: ['contact_update'] },
    { request: 'Delete that contact.', operation: 'write', domains: ['contacts'], includes: ['contact_delete'] },

    { request: 'What do you remember about my preferences?', operation: 'read', domains: ['memory'], includes: ['memory_list'] },
    { request: 'Remember that I prefer short emails.', operation: 'write', domains: ['memory'], includes: ['memory_remember'] },
    { request: 'Forget that preference.', operation: 'write', domains: ['memory'], includes: ['memory_forget'] },

    { request: 'What are my Outlook working hours?', operation: 'read', domains: ['mailbox_settings'], includes: ['mailbox_settings_read'] },
    { request: 'Turn on my out of office reply.', operation: 'write', domains: ['mailbox_settings'], includes: ['mailbox_settings_update'] },
    { request: 'Who am I signed in as?', operation: 'read', domains: ['identity'], includes: ['profile_read'] },

    { request: 'List my Microsoft Teams.', operation: 'read', domains: ['teams'], includes: ['teams_list'] },
    { request: 'Show the messages in this Teams channel.', operation: 'read', domains: ['teams'], includes: ['teams_channel_messages'] },
    { request: 'Search my OneDrive files for the budget.', operation: 'read', domains: ['files'], includes: ['onedrive_search'] },
    { request: 'Read this OneDrive file.', operation: 'read', domains: ['files'], includes: ['onedrive_read_text'] },
    { request: 'List my SharePoint sites.', operation: 'read', domains: ['sharepoint'], includes: ['sharepoint_sites_search'] },
    { request: 'Find the policy in SharePoint.', operation: 'read', domains: ['sharepoint'], includes: ['sharepoint_files'] },

    { request: 'Summarise my inbox and calendar.', operation: 'read', domains: ['calendar', 'mail'], includes: ['mail_recent', 'calendar_upcoming'] },
    { request: 'Read my email and schedule a meeting in my calendar.', operation: 'write', domains: ['calendar', 'mail'], includes: ['mail_read', 'calendar_create'] },
    { request: 'Post a message in the Teams channel.', operation: 'write', domains: ['teams'], includes: ['teams_list'] },
    { request: 'Delete this OneDrive file.', operation: 'write', domains: ['files'], includes: ['onedrive_list'] },
    { request: 'Upload this document to SharePoint.', operation: 'write', domains: ['sharepoint'], includes: ['sharepoint_sites_search'] },
  ];

  for (const scenario of scenarios) {
    test(scenario.request, () => {
      const result = plan(scenario.request);
      assert.equal(result.intent.operation, scenario.operation);
      assert.deepEqual(result.intent.domains, scenario.domains);
      for (const expected of scenario.includes ?? []) {
        assert.ok(result.tools.includes(expected), `${expected} missing from ${result.tools.join(', ')}`);
      }
      if (scenario.operation === 'read') {
        const selected = availableTools().filter((tool) => result.tools.includes(tool.name));
        assert.ok(selected.every((tool) => tool.riskLevel === 0), `read plan exposed a mutation: ${selected.filter((tool) => tool.riskLevel > 0).map((tool) => tool.name)}`);
      }
    });
  }

  test('natural Inbox counts and time windows become bounded parameters', () => {
    const scenarios = [
      ['check the 5 important emails', { limit: 5, unreadOnly: false }],
      ['show the top ten priority messages from the last two weeks', { limit: 10, sinceHours: 336, unreadOnly: false }],
      ['what are my emails for past 1 week', { sinceHours: 168, unreadOnly: false }],
      ['list 50 unread emails from the previous 30 days', { limit: 50, sinceHours: 720, unreadOnly: true }],
      ['show all my emails from the last month', { limit: 100, sinceHours: 720, unreadOnly: false }],
      ['what came in this morning', { sinceHours: 24, unreadOnly: false }],
    ] as const;

    for (const [request, expected] of scenarios) {
      assert.deepEqual(mailRequestParameters(request), expected, request);
    }
  });

  test('the current explicit calendar request overrides earlier email context', () => {
    const history = [
      { role: 'user' as const, content: 'Give me an email summary.' },
      { role: 'assistant' as const, content: 'Your Inbox has eleven messages.' },
      { role: 'user' as const, content: 'Read them all.' },
      { role: 'assistant' as const, content: 'I checked the Inbox.' },
    ];
    const result = plan('Can you give me a summary on my calendar as well? Do I have upcoming events?', history);
    assert.deepEqual(result.intent.domains, ['calendar']);
    assert.ok(result.tools.includes('calendar_upcoming'));
    assert.ok(result.tools.every((name) => name.startsWith('calendar_')));
  });

  test('a genuine reference inherits the most recent relevant domain', () => {
    const history = [
      { role: 'user' as const, content: 'What is on my calendar next week?' },
      { role: 'assistant' as const, content: 'I checked next week.' },
    ];
    assert.deepEqual(plan('What about tomorrow?', history).intent.domains, ['calendar']);
    assert.deepEqual(plan('Move it to Friday.', history).intent.domains, ['calendar']);
  });

  test('a general conversation does not expose Microsoft 365 tools', () => {
    const result = plan('What do you think about this approach?');
    assert.equal(result.intent.domain, 'general');
    assert.deepEqual(result.tools, []);
  });

  test('common executive shorthand still reaches verified data', () => {
    assert.deepEqual(plan('What needs my attention today?').intent.domains, ['mail', 'calendar', 'tasks']);
    assert.deepEqual(plan("Who's waiting on me?").intent.domains, ['mail']);
    assert.deepEqual(plan("What's on today?").intent.domains, ['calendar']);
    assert.deepEqual(plan('Walk me through my day.').intent.domains, ['calendar']);
    assert.equal(plan('Who needs a reply from me?').intent.operation, 'read');
    assert.equal(plan('Please reply to Sarah.').intent.operation, 'write');
  });

  test('calendar reminders do not leak into the To Do workflow', () => {
    const result = plan('Set a calendar reminder for the IT Infrastructure meeting.');
    assert.deepEqual(result.intent.domains, ['calendar']);
    assert.ok(result.tools.includes('calendar_update'));
    assert.ok(result.tools.every((name) => !name.startsWith('task')));
  });
});
