#!/usr/bin/env node
import console from 'node:console';
import process from 'node:process';

const group = process.argv[2];

if (!group || ['help', '--help', '-h'].includes(group)) {
  console.log(`mordecai — peer-to-peer apps and settlement

Usage:
  mordecai l1  <init|join|connect|start> [options]
  mordecai app <init|connect|start> [options]

Run mordecai l1 --help or mordecai app --help for options.`);
} else if (group === 'l1' || group === 'app') {
  process.argv.splice(2, 1);
  await import(
    group === 'l1' ? '../packages/node/dist/cli.js' : '../packages/appchain/dist/cli.js'
  );
} else {
  console.error(`Unknown command group: ${group}. Use mordecai --help.`);
  process.exitCode = 1;
}
