// Same as abort-min.mjs, but with node:http instead of fetch.
import http from 'node:http';
const rounds = Number(process.argv[2] ?? 300);
const base = new URL(process.env.GW_URL);
const body = (t) => JSON.stringify({ model: 'm', messages: [{ role: 'user', content: t }], stream: true });
const post = (t, onData) => new Promise((resolve, reject) => {
  const req = http.request({ host: base.hostname, port: base.port, path: '/v1/chat/completions', method: 'POST', headers: { 'content-type': 'application/json' } }, (res) => {
    res.on('data', (d) => onData(d, req));
    res.on('end', resolve);
    res.on('error', resolve);
    res.on('close', resolve);
  });
  req.on('error', (e) => (e.code === 'ECONNRESET' || e.message === 'aborted' ? resolve() : reject(e)));
  req.end(body(t));
});
for (let i = 0; i < rounds; i++) {
  await post('HANG', (_d, req) => req.destroy());
  await post('go', () => {});
}
console.log('survived http');
