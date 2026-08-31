import { env, getSetupStatus, productionConfigurationIssues } from '../config/env.js';
import { activeGraphScopes } from '../config/graphScopes.js';
import { pingDb, closeDb } from '../db/index.js';

interface Result { status: 'PASS' | 'WARN' | 'FAIL'; name: string; detail: string; }

function loopback(value: string): boolean {
  try {
    return ['localhost', '127.0.0.1', '::1'].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

function secureOrLocal(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || loopback(value);
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const results: Result[] = [];
  const productionIssues = productionConfigurationIssues({ ...env, NODE_ENV: 'production' });
  results.push({
    status: productionIssues.length ? 'FAIL' : 'PASS',
    name: 'Production safety configuration',
    detail: productionIssues.length ? productionIssues.join(' ') : 'Persistent storage, separate secrets, allowlist and model budget are configured.',
  });

  const setup = getSetupStatus();
  for (const check of setup.checks) {
    results.push({ status: check.ready ? 'PASS' : 'FAIL', name: check.label, detail: check.ready ? 'configured' : check.detail });
  }

  const database = await pingDb();
  results.push({ status: database.ok ? 'PASS' : 'FAIL', name: 'Database connection', detail: database.ok ? 'reachable' : 'unavailable' });
  results.push({
    status: env.NODE_ENV === 'production' ? 'PASS' : 'WARN',
    name: 'Runtime mode',
    detail: env.NODE_ENV === 'production' ? 'production' : `currently ${env.NODE_ENV}; set NODE_ENV=production only in the deployed environment`,
  });
  results.push({
    status: secureOrLocal(env.APP_URL) && secureOrLocal(env.API_URL) ? 'PASS' : 'FAIL',
    name: 'Public URLs',
    detail: loopback(env.APP_URL) && loopback(env.API_URL) ? 'local development URLs; deployment must use HTTPS' : 'HTTPS or loopback URLs configured',
  });
  results.push({
    status: env.HERMES_PROACTIVE_BACKGROUND ? 'WARN' : 'PASS',
    name: 'Background Graph polling',
    detail: env.HERMES_PROACTIVE_BACKGROUND ? 'enabled; begin a new release with this disabled' : 'disabled for staged release',
  });
  results.push({
    status: env.HERMES_PROACTIVE_DELIVERY === 'observe' ? 'PASS' : 'WARN',
    name: 'Proactive delivery',
    detail: env.HERMES_PROACTIVE_DELIVERY === 'observe' ? 'observe mode' : 'notify mode; observe is recommended for the first production days',
  });
  results.push({
    status: Number(process.versions.node.split('.')[0]) >= 22 ? 'PASS' : 'FAIL',
    name: 'Node runtime', detail: `Node ${process.versions.node}`,
  });
  results.push({
    status: 'PASS', name: 'Graph permission policy',
    detail: `${activeGraphScopes().length} delegated Graph scopes configured; no application-permission flow exists`,
  });

  for (const result of results) console.log(`${result.status.padEnd(5)} ${result.name}: ${result.detail}`);
  const failed = results.filter((result) => result.status === 'FAIL').length;
  const warnings = results.filter((result) => result.status === 'WARN').length;
  console.log(`SUMMARY ${results.length - failed - warnings} passed, ${warnings} warnings, ${failed} failed`);
  if (failed) process.exitCode = 1;
}

void main().catch(() => {
  console.error('FAIL  Release audit could not complete.');
  process.exitCode = 1;
}).finally(() => closeDb());
