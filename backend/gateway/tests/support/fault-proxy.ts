/**
 * In-process TCP fault proxy (spec gh-15): real socket faults between the gateway and Postgres,
 * Redis or ml-engine, without toxiproxy. Point the client at `proxy.port` instead of the target.
 *
 *  - cut()          destroys every open connection and resets new ones until restore()
 *  - restore()      clears cut, latency and drops
 *  - latency(ms)    delays every chunk in both directions by ms (order kept)
 *  - dropEvery(n)   resets every n-th new connection (0 turns it off)
 */

import net from 'net';

export interface FaultProxy {
  port: number;
  cut(): void;
  restore(): void;
  latency(ms: number): void;
  dropEvery(n: number): void;
  /** Connections accepted / reset so far. */
  stats(): { accepted: number; dropped: number };
  close(): Promise<void>;
}

export async function startFaultProxy(targetHost: string, targetPort: number): Promise<FaultProxy> {
  const open = new Set<net.Socket>();
  let isCut = false;
  let delayMs = 0;
  let every = 0;
  let since = 0; // `accepted` when dropEvery was set
  let accepted = 0;
  let dropped = 0;

  const kill = (s: net.Socket) => s.resetAndDestroy?.() ?? s.destroy();

  // Same delay for every chunk, so setTimeout keeps the byte order.
  const pipe = (from: net.Socket, to: net.Socket) => {
    from.on('data', (chunk) => {
      const write = () => {
        if (!to.destroyed) to.write(chunk);
      };
      if (delayMs > 0) setTimeout(write, delayMs);
      else write();
    });
    from.on('end', () => (delayMs > 0 ? setTimeout(() => to.end(), delayMs) : to.end()));
    from.on('error', () => to.destroy());
    from.on('close', () => (delayMs > 0 ? setTimeout(() => to.destroy(), delayMs) : to.destroy()));
  };

  const server = net.createServer((client) => {
    accepted += 1;
    if (isCut || (every > 0 && (accepted - since) % every === 0)) {
      dropped += 1;
      client.on('error', () => undefined);
      kill(client);
      return;
    }
    const upstream = net.connect(targetPort, targetHost);
    for (const s of [client, upstream]) {
      open.add(s);
      s.on('close', () => open.delete(s));
      s.on('error', () => undefined);
    }
    pipe(client, upstream);
    pipe(upstream, client);
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    port: (server.address() as net.AddressInfo).port,
    cut() {
      isCut = true;
      for (const s of open) kill(s);
    },
    restore() {
      isCut = false;
      delayMs = 0;
      every = 0;
    },
    latency(ms) {
      delayMs = ms;
    },
    dropEvery(n) {
      every = n;
      since = accepted;
    },
    stats: () => ({ accepted, dropped }),
    close() {
      for (const s of open) s.destroy();
      return new Promise((resolve) => server.close(() => resolve()));
    },
  };
}
