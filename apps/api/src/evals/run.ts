import { BEHAVIOURAL_FIXTURES, NEGATIVE_CONTROL_FIXTURES } from './fixtures.js';
import { evaluateCorpus } from './behavioural.js';

const report = evaluateCorpus(BEHAVIOURAL_FIXTURES);
const negative = evaluateCorpus(NEGATIVE_CONTROL_FIXTURES);
const rejectedControls = negative.results.filter((result) => !result.passed).length;

console.log(JSON.stringify({
  suite: 'hermes-humanisation-v1',
  fixtures: report.total,
  passed: report.passed,
  hardFailures: report.hardFailures,
  averageScores: report.averageScores,
  negativeControls: { total: negative.total, rejected: rejectedControls },
}, null, 2));

if (report.total < 100 || report.passed !== report.total || report.hardFailures !== 0 || rejectedControls !== negative.total) {
  process.exitCode = 1;
}
