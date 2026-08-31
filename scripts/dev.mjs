import { spawn } from 'node:child_process';

const npmCli = process.env.npm_execpath;
if (!npmCli) {
  console.error('npm_execpath is unavailable. Start this script with `npm run dev`.');
  process.exit(1);
}

const workspaces = ['apps/api', 'apps/web'];
const children = workspaces.map((workspace) =>
  spawn(process.execPath, [npmCli, 'run', 'dev', `--workspace=${workspace}`], {
    stdio: 'inherit',
    env: process.env,
  }),
);

let stopping = false;

function stop(signal = 'SIGTERM') {
  if (stopping) return;
  stopping = true;
  for (const child of children) {
    if (!child.killed) child.kill(signal);
  }
}

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, () => stop(signal));
}

for (const child of children) {
  child.once('error', (error) => {
    console.error(`Could not start a development process: ${error.message}`);
    process.exitCode = 1;
    stop();
  });

  child.once('exit', (code, signal) => {
    if (stopping) return;
    if (signal) console.error(`A development process stopped after ${signal}.`);
    process.exitCode = code ?? 1;
    stop();
  });
}
