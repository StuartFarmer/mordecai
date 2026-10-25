import { isAbsolute, relative, resolve } from 'node:path';

export function configureDemoEnvironment(env) {
  if (env.RAILWAY_ENVIRONMENT_ID) {
    const mount = env.RAILWAY_VOLUME_MOUNT_PATH;
    if (!mount || !isAbsolute(mount))
      throw new Error('Attach a Railway volume at /data before starting the demo.');
    env.DEMO_DIR ??= mount;
    const inside = relative(resolve(mount), resolve(env.DEMO_DIR));
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
      throw new Error('DEMO_DIR must be inside the Railway volume mount.');
    env.MORDECAI_TRUST_RAILWAY_PROXY ??= '1';
  }
  env.MORDECAI_NODE_DEMO = '1';
  env.PORT ??= '8790';
}
