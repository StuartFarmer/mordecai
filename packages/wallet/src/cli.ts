#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { createWallet, showAddress, signTransfer } from './commands.js';
import { promptPassphrase } from './prompt.js';

const USAGE = `mordecai-wallet — Mordecai wallet

Usage:
  mordecai-wallet create   --keystore <path> [--force]
  mordecai-wallet address  --keystore <path>
  mordecai-wallet transfer --keystore <path> --to <address> --amount <n>
                       --nonce <n> --chain-id <id> [--max-fee <n>]

The passphrase is read from --passphrase, MORDECAI_WALLET_PASSPHRASE, or an
interactive prompt, in that order.
`;

function fail(message: string): never {
  process.stderr.write(`error: ${message}\n\n${USAGE}`);
  process.exit(1);
}

function required(values: Record<string, string | boolean | undefined>, name: string): string {
  const value = values[name];
  if (typeof value !== 'string' || value === '') fail(`--${name} is required`);
  return value;
}

function requiredBigInt(
  values: Record<string, string | boolean | undefined>,
  name: string,
): bigint {
  const raw = required(values, name);
  try {
    const value = BigInt(raw);
    if (value < 0n) throw new Error();
    return value;
  } catch {
    fail(`--${name} must be a non-negative integer, got: ${raw}`);
  }
}

async function resolvePassphrase(
  values: Record<string, string | boolean | undefined>,
  confirm: boolean,
): Promise<string> {
  if (typeof values.passphrase === 'string') return values.passphrase;
  const fromEnv = process.env.MORDECAI_WALLET_PASSPHRASE;
  if (fromEnv) return fromEnv;
  const passphrase = await promptPassphrase('Passphrase: ');
  if (confirm) {
    const again = await promptPassphrase('Confirm passphrase: ');
    if (again !== passphrase) fail('passphrases do not match');
  }
  if (passphrase === '') fail('passphrase must not be empty');
  return passphrase;
}

async function main(): Promise<void> {
  const [command, ...rest] = process.argv.slice(2);
  if (!command || command === 'help' || command === '--help') {
    process.stdout.write(USAGE);
    return;
  }

  const { values } = parseArgs({
    args: rest,
    options: {
      keystore: { type: 'string' },
      passphrase: { type: 'string' },
      force: { type: 'boolean' },
      to: { type: 'string' },
      amount: { type: 'string' },
      nonce: { type: 'string' },
      'chain-id': { type: 'string' },
      'max-fee': { type: 'string', default: '1000' },
    },
  });

  switch (command) {
    case 'create': {
      const result = createWallet({
        keystorePath: required(values, 'keystore'),
        passphrase: await resolvePassphrase(values, true),
        force: values.force === true,
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      process.stderr.write(
        '\nWrite the mnemonic down and store it safely — it is the only backup.\n',
      );
      break;
    }
    case 'address': {
      process.stdout.write(showAddress(required(values, 'keystore')) + '\n');
      break;
    }
    case 'transfer': {
      const result = signTransfer({
        keystorePath: required(values, 'keystore'),
        passphrase: await resolvePassphrase(values, false),
        to: required(values, 'to'),
        amount: requiredBigInt(values, 'amount'),
        nonce: requiredBigInt(values, 'nonce'),
        chainId: required(values, 'chain-id'),
        maxFee: requiredBigInt(values, 'max-fee'),
      });
      process.stdout.write(JSON.stringify(result, null, 2) + '\n');
      break;
    }
    default:
      fail(`unknown command: ${command}`);
  }
}

main().catch((err: unknown) => {
  process.stderr.write(`error: ${err instanceof Error ? err.message : String(err)}\n`);
  process.exit(1);
});
