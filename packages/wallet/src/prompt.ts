/**
 * Hidden passphrase prompt: raw-mode TTY input echoed as nothing.
 * Byte-wise backspace handling — fine for the ASCII passphrases this
 * dev CLI targets.
 */
export async function promptPassphrase(question: string): Promise<string> {
  const input = process.stdin;
  const output = process.stderr;
  if (!input.isTTY) {
    throw new Error('stdin is not a TTY; pass --passphrase or set HSSN_WALLET_PASSPHRASE');
  }
  output.write(question);
  return new Promise((resolve, reject) => {
    const bytes: number[] = [];
    const cleanup = () => {
      input.setRawMode(false);
      input.pause();
      input.off('data', onData);
    };
    const onData = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 0x03) {
          // Ctrl-C
          cleanup();
          output.write('\n');
          reject(new Error('aborted'));
          return;
        }
        if (byte === 0x0d || byte === 0x0a) {
          cleanup();
          output.write('\n');
          resolve(Buffer.from(bytes).toString('utf8'));
          return;
        }
        if (byte === 0x7f || byte === 0x08) {
          bytes.pop();
          continue;
        }
        bytes.push(byte);
      }
    };
    input.setRawMode(true);
    input.resume();
    input.on('data', onData);
  });
}
