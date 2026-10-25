import { isAbsolute, relative, resolve } from 'node:path';
import { readFileSync } from 'node:fs';

export function configureDemoEnvironment(env, mountInfo) {
  if (env.RENDER === 'true') {
    const mounts = mountInfo ?? readFileSync('/proc/self/mountinfo', 'utf8');
    if (!mounts.split('\n').some((line) => line.split(' ')[4] === '/data'))
      throw new Error('Attach a Render persistent disk at /data before starting the demo.');
    env.DEMO_DIR ??= '/data';
    const inside = relative('/data', resolve(env.DEMO_DIR));
    if (inside === '..' || inside.startsWith('../') || isAbsolute(inside))
      throw new Error('DEMO_DIR must be inside the Render disk at /data.');
    env.MORDECAI_TRUST_RENDER_PROXY ??= '1';
  }
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
