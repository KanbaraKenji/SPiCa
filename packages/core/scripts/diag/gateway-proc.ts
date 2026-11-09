// Diagnostic: the fake gateway alone in its own process.
import { FakeGateway } from '../../src/testing/fake-gateway.ts';
const gw = await new FakeGateway().start();
gw.onRequest((r) => (JSON.stringify(r.body).includes('HANG') ? { text: ['a', 'b'], hangAfterChunks: 1 } : { text: 'ok' }));
console.log(gw.baseUrl);
setInterval(() => {}, 1000);
