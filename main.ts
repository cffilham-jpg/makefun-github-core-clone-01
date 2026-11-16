import { createApp } from './app.ts';

// The forge lives until its local trial coordinator has finished all work.
const coordinator = process.env.MAKEFUN_ENV_URL?.replace(/\/+$/, '');
if (!coordinator) process.exit(1);
const pause = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));
const server = createApp();
await new Promise<void>(resolve => server.listen(0, resolve));
const bound = server.address();
if (!bound || typeof bound === 'string') process.exit(1);
console.log(`Forge listening on ${bound.port}`);
for (;;) {
  try {
    const response = await fetch(`${coordinator}/register`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ port: bound.port }), signal: AbortSignal.timeout(30000),
    });
    if (response.ok || response.status === 409) break;
    if (response.status === 400 || response.status === 405) process.exit(1);
  } catch {}
  await pause(500);
}
for (;;) {
  try {
    const response = await fetch(`${coordinator}/done`, { signal: AbortSignal.timeout(30000) });
    if (response.ok && (await response.json()).done === true) break;
  } catch {}
  await pause(500);
}
server.close();
process.exit(0);
