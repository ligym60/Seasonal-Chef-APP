// A tiny stand-in for Kroger's API, enough to exercise the client and the cart route.
import { createServer } from 'node:http';

export async function startFakeKroger({ products = {}, hang = [] } = {}) {
  const log = { tokenCalls: [], cartAdds: [], searches: 0, inFlight: 0, maxInFlight: 0 };
  let refreshCounter = 0;
  const validRefresh = new Set(); // single use, like Kroger's

  const server = createServer((req, res) => {
    const url = new URL(req.url, 'http://x');
    const send = (status, body) => {
      res.writeHead(status, { 'Content-Type': 'application/json' });
      res.end(body == null ? '' : JSON.stringify(body));
    };
    if (hang.some((p) => url.pathname.startsWith(p))) return; // never answers

    if (url.pathname === '/v1/connect/oauth2/token' && req.method === 'POST') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        const form = new URLSearchParams(raw);
        log.tokenCalls.push(Object.fromEntries(form));
        if (form.get('grant_type') === 'client_credentials') {
          return send(200, { access_token: 'app-token', expires_in: 1800 });
        }
        if (form.get('grant_type') === 'refresh_token') {
          const old = form.get('refresh_token');
          // slow enough that concurrent callers overlap
          return setTimeout(() => {
            if (!validRefresh.delete(old)) return send(400, { error: 'invalid_grant' });
            const fresh = `refresh-${++refreshCounter}`;
            validRefresh.add(fresh);
            send(200, { access_token: `user-token-${refreshCounter}`, refresh_token: fresh, expires_in: 1800 });
          }, 50);
        }
        send(400, { error: 'unsupported_grant_type' });
      });
      return;
    }

    if (url.pathname === '/v1/products') {
      log.searches++;
      log.inFlight++;
      log.maxInFlight = Math.max(log.maxInFlight, log.inFlight);
      const term = url.searchParams.get('filter.term');
      return setTimeout(() => {
        log.inFlight--;
        const hit = products[term];
        if (hit === 'error') return send(500, { error: 'boom' });
        if (!hit) return send(200, { data: [] });
        send(200, {
          data: [{ upc: hit, description: `${term} (store brand)`, brand: 'Kroger', items: [{ size: '1 ct', price: { regular: 2.99 } }] }],
        });
      }, 20);
    }

    if (url.pathname === '/v1/cart/add' && req.method === 'PUT') {
      let raw = '';
      req.on('data', (c) => (raw += c));
      req.on('end', () => {
        log.cartAdds.push({ auth: req.headers.authorization, body: JSON.parse(raw) });
        res.writeHead(204);
        res.end();
      });
      return;
    }
    send(404, { error: 'not found' });
  });

  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  return {
    url: `http://127.0.0.1:${server.address().port}`,
    log,
    allowRefresh: (t) => validRefresh.add(t),
    close: () => new Promise((r) => { server.closeAllConnections?.(); server.close(r); }),
  };
}
