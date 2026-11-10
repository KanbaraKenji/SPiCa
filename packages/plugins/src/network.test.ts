// Plugin servers connect like the app itself: through the proxy from the
// network settings and trusting the same certificates (the core puts both
// into every MCP child's environment). A plugin with no certificate or proxy
// code reaches an internal HTTPS service signed by a private CA; with the CA
// no longer trusted it cannot. After a change, restartServers() applies it.
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { readFileSync, writeFileSync } from 'node:fs';
import { createServer as createHttp, type Server } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { connect as netConnect, type AddressInfo, type Socket } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { configureNetwork } from '@spica/core';
import { callTool, manifest, rig, until, writePlugin, type Rig } from './testing/helpers.ts';

// A fictional internal host name; the test proxy sends every tunnel to 127.0.0.1.
const HOST = 'intranet.example.test';

/** A throwaway CA and a server certificate for HOST (needs the openssl command). */
function makeCerts(at: string): { ca: string; cert: string; key: string } | undefined {
  try {
    const run = (...args: string[]) =>
      execFileSync('openssl', args, { cwd: at, stdio: 'pipe', windowsHide: true, env: { ...process.env, OPENSSL_CONF: join(at, 'o.cnf') } });
    writeFileSync(
      join(at, 'o.cnf'),
      [
        '[req]',
        'distinguished_name=dn',
        '[dn]',
        '[ca_ext]',
        'basicConstraints=critical,CA:TRUE',
        'keyUsage=critical,keyCertSign,cRLSign',
        'subjectKeyIdentifier=hash',
        '[ext]',
        `subjectAltName=DNS:${HOST}`,
        'basicConstraints=CA:FALSE',
        '',
      ].join('\n'),
    );
    run('req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key', '-out', 'ca.pem', '-days', '2', '-subj', '/CN=Example Internal Test CA', '-config', 'o.cnf', '-extensions', 'ca_ext');
    run('req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'srv.key', '-out', 'srv.csr', '-subj', `/CN=${HOST}`, '-config', 'o.cnf');
    run('x509', '-req', '-in', 'srv.csr', '-CA', 'ca.pem', '-CAkey', 'ca.key', '-CAcreateserial', '-out', 'srv.pem', '-days', '2', '-extfile', 'o.cnf', '-extensions', 'ext');
    return { ca: join(at, 'ca.pem'), cert: join(at, 'srv.pem'), key: join(at, 'srv.key') };
  } catch {
    return undefined;
  }
}

const hasOpenssl = (() => {
  try {
    execFileSync('openssl', ['version'], { stdio: 'pipe', windowsHide: true });
    return true;
  } catch {
    return false;
  }
})();

const listen = (s: Server) => new Promise<number>((done) => s.listen(0, '127.0.0.1', () => done((s.address() as AddressInfo).port)));

/** The plugin: plain fetch and https.get, no certificate or proxy code. The address comes from its data folder. */
const SERVER = `import { readFileSync } from 'node:fs';
import { get } from 'node:https';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
const send = (m) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', ...m }) + '\\n');
const config = () => JSON.parse(readFileSync(join(process.env.SPICA_PLUGIN_DATA, 'config.json'), 'utf8'));
const viaHttps = (url) => new Promise((done) => {
  get(url, (res) => { res.resume(); done(String(res.statusCode)); }).on('error', (e) => done(e.code || e.message));
});
async function status() {
  const url = config().baseUrl + '/status';
  const f = await fetch(url).then(async (r) => r.status + ' ' + (await r.text()), (e) => (e.cause && e.cause.code) || e.message);
  return 'fetch: ' + f + ' | https: ' + (await viaHttps(url));
}
createInterface({ input: process.stdin }).on('line', async (l) => {
  const m = JSON.parse(l);
  if (m.method === 'initialize') send({ id: m.id, result: { protocolVersion: '2025-06-18', capabilities: {}, serverInfo: { name: 'intranet' } } });
  if (m.method === 'tools/list') send({ id: m.id, result: { tools: [{ name: 'service_status', inputSchema: { type: 'object' } }] } });
  if (m.method === 'tools/call') send({ id: m.id, result: { content: [{ type: 'text', text: await status() }] } });
});
`;

describe.skipIf(!hasOpenssl)('network settings reach plugin servers', () => {
  let work: string;
  let certs: { ca: string; cert: string; key: string };
  let service: Server;
  let proxy: Server;
  let proxyUrl: string;
  const tunnels: string[] = [];
  const sockets: Socket[] = [];
  let r: Rig | undefined;
  let dir: string;

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'spica-plugin-net-'));
    certs = makeCerts(work)!;
    service = createHttps({ cert: readFileSync(certs.cert), key: readFileSync(certs.key) }, (_req, res) => res.end('ok'));
    const servicePort = await listen(service);
    // Company-style proxy: HTTPS by CONNECT. Every tunnel goes to the test service.
    proxy = createHttp((_req, res) => res.writeHead(502).end());
    proxy.on('connect', (req, socket: Socket) => {
      tunnels.push(String(req.url));
      sockets.push(socket);
      const up = netConnect(servicePort, '127.0.0.1', () => {
        socket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
        up.pipe(socket);
        socket.pipe(up);
      });
      sockets.push(up);
      up.on('error', () => socket.destroy());
      socket.on('error', () => up.destroy());
    });
    proxyUrl = `http://127.0.0.1:${await listen(proxy)}`;
    dir = await writePlugin({ 'manifest.json': manifest('intranet'), 'mcp/srv.json': { runtime: 'node', entry: 'srv.js' }, 'srv.js': SERVER });
  });

  afterAll(async () => {
    await r?.cleanup();
    configureNetwork({ proxy: null, caFile: null });
    for (const s of sockets) s.destroy();
    service?.close();
    proxy?.close();
    await rm(work, { recursive: true, force: true });
    await rm(dir, { recursive: true, force: true });
  });

  it('a plugin with no certificate code reaches a service signed by a trusted private CA, through the proxy; untrusted, it cannot', async () => {
    configureNetwork({ proxy: { url: proxyUrl }, caFile: certs.ca, useSystemCa: false });
    r = await rig();
    await r.pm.install(dir);
    await mkdir(r.pm.dataDir('intranet'), { recursive: true });
    await writeFile(join(r.pm.dataDir('intranet'), 'config.json'), JSON.stringify({ baseUrl: `https://${HOST}` }));
    await r.pm.enable('intranet');

    const ok = await callTool(r.rt, 'intranet__service_status', {});
    expect(ok.content).toBe('fetch: 200 ok | https: 200');
    expect(tunnels).toContain(`${HOST}:443`);

    // The CA is no longer trusted: after the restart the same plugin is refused.
    configureNetwork({ proxy: { url: proxyUrl }, caFile: null, useSystemCa: false });
    await r.pm.restartServers('network settings changed');
    await until(() => r!.pm.describe('intranet').servers[0]?.status === 'running');
    const refused = await callTool(r.rt, 'intranet__service_status', {});
    expect(refused.content).toMatch(/^fetch: (UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)/);
    expect(refused.content).toMatch(/https: (UNABLE_TO_VERIFY_LEAF_SIGNATURE|SELF_SIGNED_CERT_IN_CHAIN|UNABLE_TO_GET_ISSUER_CERT_LOCALLY)$/);
  });
});
