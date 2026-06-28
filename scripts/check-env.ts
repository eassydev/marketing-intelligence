/**
 * Standalone env validation for CI / Docker healthcheck / pre-deploy. Imports
 * src/config/env which parses process.env at load and throws (exit 1) on any
 * invalid/missing key, listing them all.
 */
import { env } from '../src/config/env.js';

console.log('Environment OK:');
console.log(`  NODE_ENV=${env.NODE_ENV}`);
console.log(`  PORT=${env.PORT}`);
console.log(`  MIL_ACTION_MODE=${env.MIL_ACTION_MODE}`);
console.log(`  MIL_ENABLED_APPS=${env.MIL_ENABLED_APPS.join(',')}`);
console.log(`  ANTHROPIC_API_KEY=${env.ANTHROPIC_API_KEY ? 'set' : 'unset (LLM seam parked)'}`);
