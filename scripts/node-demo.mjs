#!/usr/bin/env node
// Persistent node site and all demos on one settlement network.
import { configureDemoEnvironment } from './lib/demo-environment.mjs';
configureDemoEnvironment(process.env);
await import('./hex-demo.mjs');
