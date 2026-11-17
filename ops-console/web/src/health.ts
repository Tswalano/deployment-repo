import type { AppStatus } from './api';
import type { Tone } from './components/ui';

/** Cell colour for an app: down → critical, warnings/errors in 24h → warning, else healthy. */
export const appTone = (a: AppStatus): Tone => (!a.healthy ? 'bad' : a.errors24h > 0 || a.warnings24h > 0 ? 'warn' : 'ok');

import type { Instance } from './api';

/** Stopped / stopping / terminated on purpose (EC2 state), as opposed to running-but-unreachable. */
export const poweredOff = (i: Instance) => !!i.ec2State && i.ec2State !== 'running' && i.ec2State !== 'pending';

/** Active instances first (healthy, then unreachable), powered-off last; alphabetical within each group. */
export function sortInstances<T extends Instance>(list: T[]): T[] {
  const rank = (i: Instance) => (poweredOff(i) ? 2 : i.lastError || !i.status ? 1 : 0);
  return [...list].sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name));
}
