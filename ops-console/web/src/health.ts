import type { AppStatus } from './api';
import type { Tone } from './components/ui';

/** Cell colour for an app: down → critical, warnings/errors in 24h → warning, else healthy. */
export const appTone = (a: AppStatus): Tone => (!a.healthy ? 'bad' : a.errors24h > 0 || a.warnings24h > 0 ? 'warn' : 'ok');
