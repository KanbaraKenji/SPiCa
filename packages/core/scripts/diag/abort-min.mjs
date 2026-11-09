// Minimal: plain fetch against the gateway process; how we stop the stream varies.
const [mode, rounds] = [process.argv[2], Number(process.argv[3] ?? 2000)];
const base = process.env.GW_URL;
const body = (t) => JSON.stringify({ model: 'm', messages: [{ role: 'user', content: t }], stream: true });
for (let i = 0; i < rounds; i++) {
  const ac = new AbortController();
  const res = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: body('HANG'), headers: { 'content-type': 'application/json' }, signal: ac.signal });
  const reader = res.body.getReader();
  await reader.read();
  try {
    if (mode === 'abort') { ac.abort(); await reader.read().catch(() => 0); }
    else if (mode === 'cancel') { await reader.cancel(); }
    else if (mode === 'both') { const p = reader.read().catch(() => 0); ac.abort(); reader.cancel().catch(() => 0); await p; }
  } catch {
    // the abort error itself is expected
  }
  const r2 = await fetch(`${base}/v1/chat/completions`, { method: 'POST', body: body('go'), headers: { 'content-type': 'application/json' } });
  await r2.text();
}
console.log('survived', mode);
