// Accelerate only the worker heartbeat in its isolated subprocess. A tick
// advances its monotonic timeout clock by 30 seconds without delaying tests.
const interval = globalThis.setInterval;
const now = Date.now;
let elapsed = 0;
Date.now = () => now() + elapsed;
globalThis.setInterval = (callback, delay, ...args) => delay === 30_000
  ? interval(() => { elapsed += 30_000; callback(...args); }, 40)
  : interval(callback, delay, ...args);
