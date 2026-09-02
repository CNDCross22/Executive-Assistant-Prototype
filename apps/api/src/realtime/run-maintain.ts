/**
 * Entry point for the scheduled real-time maintenance pass.
 *
 * Follows the same shape as the other operational entry points in dev/: build
 * the API workspace, then run the compiled file. Exits non-zero when nothing
 * could be maintained, so a schedule that has quietly stopped working shows up
 * as a failed job rather than a green one.
 */
import { closeDb } from '../db/index.js';
import { logger } from '../lib/logger.js';
import { maintainRealtime } from './maintain.js';
import { realtimeAvailable, notificationUrl } from './subscriptions.js';

async function main(): Promise<void> {
  if (!realtimeAvailable()) {
    console.error('Real-time mail is not configured.');
    console.error('Set HERMES_WEBHOOK_URL to a public HTTPS endpoint, or leave it unset to stay on polling.');
    process.exitCode = 1;
    return;
  }

  console.log(`Notification URL: ${notificationUrl()}`);
  const report = await maintainRealtime();

  console.log('\nReal-time maintenance');
  console.log('─'.repeat(40));
  console.log(`  subscriptions renewed    ${report.renewed}`);
  console.log(`  subscriptions recreated  ${report.recreated}`);
  console.log(`  renewal failures         ${report.renewalFailures}`);
  console.log(`  mailboxes reconciled     ${report.reconciled}`);
  console.log(`  missed messages found    ${report.newMailFound}`);
  console.log(`  users skipped            ${report.skipped}`);

  if (report.renewalFailures > 0) {
    console.error('\nOne or more subscriptions could not be renewed or recreated.');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    logger.error({ err }, 'Real-time maintenance failed');
    process.exitCode = 1;
  })
  .finally(() => closeDb());
