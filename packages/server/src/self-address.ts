import os from "node:os";
import { execFileSync } from "node:child_process";

/**
 * Normalizes IPv4-mapped IPv6 addresses (e.g. ::ffff:127.0.0.1 or ::ffff:7f00:1)
 * to standard IPv4 dotted-decimal format.
 */
function unmapIpv6(host: string): string {
  if (host.startsWith("::ffff:")) {
    const rest = host.slice(7);
    if (rest.includes(".")) return rest;
    const parts = rest.split(":");
    if (parts.length === 2) {
      const high = parseInt(parts[0] ?? "", 16);
      const low = parseInt(parts[1] ?? "", 16);
      if (!isNaN(high) && !isNaN(low)) {
        return `${(high >> 8) & 0xff}.${high & 0xff}.${(low >> 8) & 0xff}.${low & 0xff}`;
      }
    }
  }
  return host;
}

const resolveCache = new Map<string, string[]>();

/**
 * Resolves a hostname synchronously to its IP addresses via getent hosts.
 * Caches results so repeated lookups cost 0ms.
 * If resolution fails or the host is unresolvable, returns [] (treated as remote/unbound).
 */
function resolveHostSync(host: string): string[] {
  if (resolveCache.has(host)) return resolveCache.get(host)!;
  const addrs: string[] = [];
  try {
    const out = execFileSync("getent", ["hosts", host], { encoding: "utf8", timeout: 1000 });
    for (const line of out.split("\n")) {
      const parts = line.trim().split(/\s+/);
      if (parts[0]) {
        const clean = unmapIpv6(parts[0].toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "");
        if (clean) addrs.push(clean);
      }
    }
  } catch {
    // Unresolvable host: cannot reach this daemon. Treated as remote so
    // dials fail harmlessly without refusing legitimate remote homes.
  }
  resolveCache.set(host, addrs);
  return addrs;
}

/**
 * Set of all IP addresses and hostnames that reach this machine locally.
 */
function getLocalAddresses(listenHost?: string | null): Set<string> {
  const localSet = new Set<string>(["127.0.0.1", "localhost", "0.0.0.0", "::", "::1"]);
  const myHost = os.hostname().toLowerCase();
  localSet.add(myHost);
  localSet.add(`${myHost}.local`);

  if (listenHost) {
    const clean = unmapIpv6(listenHost.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "");
    if (clean) localSet.add(clean);
  }

  const ifaces = os.networkInterfaces();
  for (const iface of Object.values(ifaces)) {
    for (const info of iface ?? []) {
      const clean = unmapIpv6(info.address.toLowerCase().replace(/^\[|\]$/g, "").split("%")[0] ?? "");
      if (clean) localSet.add(clean);
    }
  }
  return localSet;
}

/**
 * Does this target URL point back to the local daemon's own listen address?
 * (isocan-vab: prevents infinite self-dialing loops that exhaust the socket table).
 *
 * Compares addresses, not names:
 *  1. Matches target port against daemon listen port.
 *  2. Normalizes target host (strips brackets, trailing FQDN dots, zone ids, and unmaps IPv4-mapped IPv6).
 *  3. Directly checks loopbacks and local interface sets.
 *  4. Resolves names (getent hosts) and checks whether ANY resolved address reaches a local interface.
 *  5. Names that do not resolve to a local interface (e.g. omarchy.evil.com or unresolvable hosts)
 *     are treated as remote, allowing legitimate remote homes to forward rather than being falsely denied.
 */
export function isSelfAddress(
  targetUrl: string | null | undefined,
  listenPort: number,
  listenHost?: string | null | undefined,
): boolean {
  if (!targetUrl) return false;
  try {
    const parsed = new URL(targetUrl);
    const targetPort = parsed.port ? Number(parsed.port) : (parsed.protocol === "https:" ? 443 : 80);
    if (targetPort !== listenPort) return false;

    let host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    // F6: Strip single trailing root dot in FQDN (e.g. localhost. -> localhost)
    if (host.endsWith(".")) host = host.slice(0, -1);
    // Strip IPv6 zone index (e.g. %eth0)
    host = host.split("%")[0] ?? "";
    host = unmapIpv6(host);

    if (host.startsWith("127.")) return true;

    const localSet = getLocalAddresses(listenHost);
    if (localSet.has(host)) return true;

    // Resolve name to IP addresses and compare against local interface set
    const resolved = resolveHostSync(host);
    for (const addr of resolved) {
      if (addr.startsWith("127.") || localSet.has(addr)) return true;
    }

    return false;
  } catch {
    return false;
  }
}
