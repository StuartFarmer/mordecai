#!/usr/bin/env node
// Persistent node site + Hex on one settlement network.
process.env.MORDECAI_NODE_DEMO = '1';
process.env.PORT ??= '8790';
await import('./hex-demo.mjs');
