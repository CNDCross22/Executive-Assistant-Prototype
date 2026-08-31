/**
 * Privacy-safe, read-only live UAT for Phase 6 content surfaces.
 * Logs status and counts only. It never prints names, subjects, posts, file
 * contents, Microsoft ids or download URLs and performs no mutation.
 */
import { requireDb, closeDb } from '../db/index.js';
import { getAccessToken } from '../auth/msal.js';
import { GraphClient } from '../graph/client.js';
import { MailService } from '../graph/mail.service.js';
import { TeamsService } from '../graph/teams.service.js';
import { FilesService, type FileSummary } from '../graph/files.service.js';
import { assessSuspicion } from '../mail/suspicion.js';

type Row = { id: string; email: string; home_account_id: string };
type Status = 'PASS' | 'SKIP' | 'FAIL';

function report(status: Status, name: string, detail: string): void {
  console.log(`${status.padEnd(5)} ${name}: ${detail}`);
}

async function findOneDriveText(files: FilesService): Promise<FileSummary | null> {
  const pending: Array<string | undefined> = [undefined];
  let visited = 0;
  while (pending.length && visited < 100) {
    const folder = pending.shift();
    const items = await files.listOneDrive(folder, 50);
    visited += items.length;
    const readable = items.find((item) => item.textSupported);
    if (readable) return readable;
    for (const item of items) if (item.kind === 'folder' && pending.length < 20) pending.push(item.id);
  }
  return null;
}

async function main(): Promise<void> {
  const db = requireDb();
  const rows = await db<Row[]>`
    select u.id, u.email, o.home_account_id
    from users u join oauth_connections o on o.user_id = u.id
    where u.is_active and o.provider = 'microsoft' and o.status = 'connected'
    order by u.last_login_at desc limit 1
  `;
  const user = rows[0];
  if (!user) throw new Error('No connected Microsoft user was found.');
  const token = await getAccessToken(user.id, user.home_account_id);
  const graph = new GraphClient(token, { userId: user.id, requestId: 'live-content-uat' });
  const mail = new MailService(graph, user.email.split('@')[1]?.toLowerCase() ?? '');
  const teams = new TeamsService(graph);
  const files = new FilesService(graph);
  let failures = 0;

  try {
    const messages = await mail.list({ limit: 50 });
    const message = messages.find((item) => item.hasAttachments);
    if (!message) report('SKIP', 'Attachment content', 'no sampled message has an attachment');
    else {
      const attachments = await mail.listAttachments(message.id);
      const readable = attachments.find((item) => item.textSupported);
      if (!readable) report('SKIP', 'Attachment content', `${attachments.length} metadata item(s), none in a supported text format`);
      else {
        const content = await mail.readAttachmentText({ messageId: message.id, attachmentId: readable.id, maxCharacters: 2_000 });
        const suspicious = assessSuspicion(content.text).suspicious;
        report('PASS', 'Attachment content', `${content.returnedCharacters} bounded character(s) read; suspicious=${suspicious}`);
      }
    }
  } catch {
    failures++;
    report('FAIL', 'Attachment content', 'read failed without exposing content');
  }

  try {
    const joined = await teams.listJoinedTeams(5);
    if (!joined[0]) report('SKIP', 'Teams channel content', 'the account has no joined Team');
    else {
      const channels = await teams.listChannels(joined[0].id, 10);
      if (!channels[0]) report('SKIP', 'Teams channel content', 'no readable channel is available');
      else {
        const messages = await teams.listChannelMessages(joined[0].id, channels[0].id, 3);
        const suspicious = messages.some((item) => assessSuspicion(item.text).suspicious);
        report('PASS', 'Teams channel content', `${messages.length} bounded post(s) read; suspicious=${suspicious}`);
      }
    }
  } catch {
    failures++;
    report('FAIL', 'Teams channel content', 'read failed without exposing content');
  }

  try {
    const item = await findOneDriveText(files);
    if (!item) report('SKIP', 'OneDrive file content', 'no supported text file found within the bounded search');
    else {
      const content = await files.readText({ driveId: item.driveId, itemId: item.id, maxCharacters: 2_000 });
      report('PASS', 'OneDrive file content', `${content.returnedCharacters} bounded character(s) read; suspicious=${assessSuspicion(content.text).suspicious}`);
    }
  } catch {
    failures++;
    report('FAIL', 'OneDrive file content', 'read failed without exposing content');
  }

  try {
    const sites = await files.searchSites('*', 5);
    if (!sites[0]) report('SKIP', 'SharePoint file content', 'no accessible site returned by the bounded site search');
    else {
      const items = await files.listSiteFiles(sites[0].id, undefined, 50);
      const item = items.find((candidate) => candidate.textSupported);
      if (!item) report('SKIP', 'SharePoint file content', `${items.length} item(s) found, none in a supported text format`);
      else {
        const content = await files.readText({ driveId: item.driveId, itemId: item.id, maxCharacters: 2_000 });
        report('PASS', 'SharePoint file content', `${content.returnedCharacters} bounded character(s) read; suspicious=${assessSuspicion(content.text).suspicious}`);
      }
    }
  } catch {
    failures++;
    report('FAIL', 'SharePoint file content', 'read failed without exposing content');
  }

  if (failures) process.exitCode = 1;
}

void main().catch(() => {
  console.error('FAIL  Live content UAT could not start.');
  process.exitCode = 1;
}).finally(() => closeDb());
