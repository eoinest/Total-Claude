#!/usr/bin/env node
/**
 * Can this machine send a UDP packet to its own LAN address and receive it?
 *
 * Isolates the network from WebRTC. If this fails, no ICE connectivity check over a host
 * candidate can succeed here either, and the reason is the machine rather than the transport.
 */
import dgram from 'node:dgram';
import { lanAddress } from '../lib/lan-address.mjs';

const ip = lanAddress().ip;
const server = dgram.createSocket('udp4');
server.on('message', (m, r) => {
  console.log(`recv "${m}" from ${r.address}:${r.port}`);
  process.exit(0);
});
server.bind(45455, '0.0.0.0', () => {
  const c = dgram.createSocket('udp4');
  c.send('hello', 45455, ip, (e) => { if (e) console.log(`send err: ${e.message}`); });
  setTimeout(() => {
    console.log(`NO PACKET in 2 s — inbound UDP to ${ip} does not arrive`);
    process.exit(1);
  }, 2000);
});
