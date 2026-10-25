import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import createTestnet from 'hyperdht/testnet';
import { expect, it } from 'vitest';
import { encodeAddress, generateSeed, keyPairFromSeed } from '@mordecai/crypto';
import { Chain } from '@mordecai/chain';
import { Network } from '@mordecai/networking';
import { encodeTransaction } from '@mordecai/protocol';
import { Wallet } from '@mordecai/wallet';
import { Node } from '../src/node.js';

it(
  'bundles HTTP, sync and seeding for validators and non-voting peers',
  { timeout: 90_000 },
  async () => {
    const testnet = await createTestnet(3);
    const dir = mkdtempSync(join(tmpdir(), 'mordecai-peer-'));
    const nodes: Node[] = [];
    const publisher = Network.create({
      storageDir: join(dir, 'publisher'),
      bootstrap: testnet.bootstrap,
    });
    let reader: Network | undefined;
    let publisherClosed = false;
    try {
      const bundle = await publisher.createFeed('bundle');
      await bundle.append('app bundle');
      await publisher.joinFeed(bundle);
      const validator = keyPairFromSeed(generateSeed());
      const { wallet } = Wallet.create();
      const recipient = keyPairFromSeed(generateSeed());
      const genesis = {
        chainId: 'bundled-peer',
        validators: [encodeAddress(validator.publicKey)],
        allocations: [{ address: wallet.address, balance: 1_000_000n }],
      };
      // Existing single-validator data directories have proposer-signed blocks
      // without separate vote certificates. They must remain joinable.
      const legacy = await Chain.open(join(dir, 'node-0', 'chain'), genesis);
      await legacy.produceBlock(
        [
          wallet.signTransaction({
            chainId: genesis.chainId,
            nonce: 0n,
            maxFee: 1_000n,
            payload: { kind: 'transfer', to: recipient.publicKey, amount: 7n },
          }),
        ],
        validator,
      );
      await legacy.close();
      for (const keyPair of [validator, keyPairFromSeed(generateSeed())]) {
        const node = await Node.start({
          dir: join(dir, `node-${nodes.length}`),
          genesis,
          keyPair,
          bootstrap: testnet.bootstrap,
          blockIntervalMs: 50,
          feedKeys: [bundle.key],
        });
        nodes.push(node);
        expect(node.gateway).toBeDefined();
        const head = await fetch(`http://127.0.0.1:${node.gateway.port}/api/head`);
        expect(await head.json()).toMatchObject({ chainId: 'bundled-peer' });
        const copy = await node.network.openFeed(bundle.key);
        await expect.poll(() => copy.has(0), { timeout: 15_000 }).toBe(true);
      }
      const [v, peer] = nodes as [Node, Node];
      expect(v.isValidator).toBe(true);
      expect(peer.isValidator).toBe(false);
      await bundle.append('updated data');
      const copy = await peer.network.openFeed(bundle.key);
      await expect.poll(() => copy.has(1), { timeout: 15_000 }).toBe(true);
      await expect.poll(() => peer.peerCount, { timeout: 15_000 }).toBeGreaterThan(0);
      await expect.poll(() => peer.chain.height, { timeout: 15_000 }).toBe(1n);
      const tx = wallet.signTransaction({
        chainId: genesis.chainId,
        nonce: 1n,
        maxFee: 1_000n,
        payload: { kind: 'transfer', to: recipient.publicKey, amount: 123n },
      });
      const response = await fetch(`http://127.0.0.1:${peer.gateway.port}/api/tx`, {
        method: 'POST',
        body: JSON.stringify({ tx: Buffer.from(encodeTransaction(tx)).toString('hex') }),
      });
      expect(response.ok).toBe(true);
      await expect.poll(() => peer.chain.height, { timeout: 15_000 }).toBe(2n);
      expect((await peer.chain.getAccount(recipient.publicKey)).balance).toBe(130n);
      const votes = await peer.chain.getCertificate(2n);
      expect(votes).toHaveLength(1);
      expect(votes![0]!.validator).toEqual(validator.publicKey);

      // Only the ordinary peer remains: it must still seed and serve history.
      await publisher.close();
      publisherClosed = true;
      await v.stop();
      nodes.shift();
      reader = Network.create({ storageDir: join(dir, 'reader'), bootstrap: testnet.bootstrap });
      const downloaded = await reader.openFeed(bundle.key);
      await reader.joinFeed(downloaded);
      expect(new TextDecoder().decode(await downloaded.get(0, { timeout: 15_000 }))).toBe(
        'app bundle',
      );
      expect(new TextDecoder().decode(await downloaded.get(1, { timeout: 15_000 }))).toBe(
        'updated data',
      );
      const late = await Node.start({
        dir: join(dir, 'late'),
        genesis,
        keyPair: keyPairFromSeed(generateSeed()),
        bootstrap: testnet.bootstrap,
        blockIntervalMs: 50,
      });
      nodes.push(late);
      await expect.poll(() => late.chain.height, { timeout: 15_000 }).toBe(2n);
      expect((await late.chain.getAccount(recipient.publicKey)).balance).toBe(130n);
      const next = wallet.signTransaction({
        chainId: genesis.chainId,
        nonce: 2n,
        maxFee: 1_000n,
        payload: { kind: 'transfer', to: recipient.publicKey, amount: 1n },
      });
      await fetch(`http://127.0.0.1:${peer.gateway.port}/api/tx`, {
        method: 'POST',
        body: JSON.stringify({ tx: Buffer.from(encodeTransaction(next)).toString('hex') }),
      });
      await new Promise((resolve) => setTimeout(resolve, 300));
      expect(peer.chain.height).toBe(2n);
      expect(late.chain.height).toBe(2n);
    } finally {
      await reader?.close();
      for (const node of nodes) await node.stop();
      if (!publisherClosed) await publisher.close();
      await testnet.destroy();
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
