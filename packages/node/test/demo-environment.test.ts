import { expect, it } from 'vitest';
import { configureDemoEnvironment } from '../../../scripts/lib/demo-environment.mjs';

it('requires persistent storage on Railway and rejects data outside its mount', () => {
  expect(() => configureDemoEnvironment({ RAILWAY_ENVIRONMENT_ID: 'test' })).toThrow(
    /Attach a Railway volume/,
  );
  for (const dir of ['/tmp/demo', '/data-other', '/data/../tmp/demo'])
    expect(() =>
      configureDemoEnvironment({
        RAILWAY_ENVIRONMENT_ID: 'test',
        RAILWAY_VOLUME_MOUNT_PATH: '/data',
        DEMO_DIR: dir,
      }),
    ).toThrow(/inside/);
});

it('uses the Railway volume, supplied port and explicit proxy opt-out', () => {
  const env: Record<string, string> = {
    RAILWAY_ENVIRONMENT_ID: 'test',
    RAILWAY_VOLUME_MOUNT_PATH: '/data',
    PORT: '8080',
  };
  configureDemoEnvironment(env);
  expect(env).toMatchObject({
    DEMO_DIR: '/data',
    PORT: '8080',
    MORDECAI_NODE_DEMO: '1',
    MORDECAI_TRUST_RAILWAY_PROXY: '1',
  });
  env.DEMO_DIR = '/data/demo';
  env.MORDECAI_TRUST_RAILWAY_PROXY = '0';
  configureDemoEnvironment(env);
  expect(env.MORDECAI_TRUST_RAILWAY_PROXY).toBe('0');
});

it('keeps local defaults without trusting proxy headers', () => {
  const env: Record<string, string> = {};
  configureDemoEnvironment(env);
  expect(env).toEqual({ MORDECAI_NODE_DEMO: '1', PORT: '8790' });
});
