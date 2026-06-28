import { DryRunAdActionPort } from './dry-run-port.js';
import type { AdActionPort } from './port.js';

/**
 * The single action port the whole service uses. Today it is always dry-run.
 * When LiveAdActionPort is built + an approval gate is in place, flip here behind
 * env.MIL_ACTION_MODE — no caller changes.
 */
export const actionPort: AdActionPort = new DryRunAdActionPort();
