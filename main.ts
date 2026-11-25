// Pump.fun launch sniper entrypoint: wire the strategy into the replay shim.
// Run by the grader as `node /bot/main.ts` (Node 22 type-stripping, no build).

import { runBot } from './vendor/makefun-bot.ts';
import { SniperStrategy } from './strategy.ts';

const strategy = new SniperStrategy();

await runBot({
  onBatch: (state, batch) => strategy.onBatch(state, batch),
});
