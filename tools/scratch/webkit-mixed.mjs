#!/usr/bin/env node
/** Throwaway: does WebKit apply an address-space carve-out for ws:// from https? */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createServer as createHttp } from 'node:http';
import { createServer as createHttps } from 'node:https';
import { mkdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { launchBrowser } from '../lib/browser-budget.mjs';
import { lanAddress } from '../lib/lan-address.mjs';

const ROOT = path.resolve(import.meta.dirname, '..', '..');
const lan = lanAddress().ip;
const DIR = '/tmp/tc-webkit-mixed';
mkdirSync(DIR, { recursive: true });
execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes',
  '-keyout', `${DIR}/key.pem`, '-out', `${DIR}/cert.pem`, '-days', '2',
  '-subj', `/CN=${lan}`, '-addext', `subjectAltName=IP:${lan}`], { stdio: 'ignore' });
const PAGE = '<!doctype html><meta charset=utf-8><title>p</title><body>p</body>';
const h = (_q, r) => { r.writeHead(200, { 'content-type': 'text/html' }); r.end(PAGE); };
const tls = createHttps({ key: readFileSync(`${DIR}/key.pem`), cert: readFileSync(`${DIR}/cert.pem`) }, h);
await new Promise((r) => tls.listen(5972, '0.0.0.0', r));
const ws = createHttp((_q, s) => { s.writeHead(200); s.end('ok'); });
ws.on('upgrade', (req, sock) => {
  const a = createHash('sha1')
    .update(String(req.headers['sec-websocket-key']) + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11')
    .digest('base64');
  sock.write(`HTTP/1.1 101 Switching Protocols\r\nupgrade: websocket\r\nconnection: Upgrade\r\nsec-websocket-accept: ${a}\r\n\r\n`);
});
await new Promise((r) => ws.listen(5973, '0.0.0.0', r));

const targets = [`ws://${lan}:5973/x`, 'ws://127.0.0.1:5973/x', 'ws://1.1.1.1:81/x'];
for (const engine of ['webkit', 'chromium']) {
  const b = await launchBrowser({ label: `webkit-mixed/${engine}`, engine, port: 5972, root: ROOT });
  const p = await b.newPage({ ignoreHTTPSErrors: true });
  const msgs = [];
  p.on('console', (m) => { if (m.type() === 'error') msgs.push(m.text().slice(0, 100)); });
  await p.goto(`https://${lan}:5972/`, { waitUntil: 'domcontentloaded' });
  const out = await p.evaluate(async (list) => {
    const res = { secure: window.isSecureContext, origin: location.origin, tried: {} };
    for (const url of list) {
      try {
        const s = new WebSocket(url);
        res.tried[url] = await new Promise((ok) => {
          const done = (x) => { try { s.close(); } catch { /* */ } ok(x); };
          s.onopen = () => done('opened');
          s.onerror = () => done('error');
          s.onclose = (e) => done(`closed ${e.code}`);
          setTimeout(() => done('timeout'), 3500);
        });
      } catch (e) { res.tried[url] = `threw ${e.name}`; }
    }
    return res;
  }, targets);
  console.log(engine, JSON.stringify({ ...out, console: msgs }, null, 1));
  await b.close();
}
tls.close(); ws.close();
