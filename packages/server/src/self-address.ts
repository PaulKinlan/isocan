import os from "node:os";

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

/**
 * Does this target URL point back to the local daemon's own listen address?
 * (isocan-vab: prevents infinite self-dialing loops that exhaust the socket table).
 *
 * Covers:
 *  - Loopback literals (127.*, localhost, 0.0.0.0, ::1, ::)
 *  - IPv4-mapped IPv6 loopbacks ([::ffff:127.0.0.1], [::ffff:7f00:1])
 *  - Machine's own hostname (os.hostname(), *.local FQDNs)
 *  - Bound listen host
 *  - All local network interfaces (LAN, Tailscale, virtual adapters)
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

    let hostname = unmapIpv6(parsed.hostname.toLowerCase().replace(/^\[|\]$/g, ""));

    // Loopback literals
    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("127.")
    ) {
      return true;
    }

    // F1: Machine's own hostname and local FQDNs
    const myHost = os.hostname().toLowerCase();
    if (
      hostname === myHost ||
      hostname === `${myHost}.local` ||
      hostname.startsWith(`${myHost}.`)
    ) {
      return true;
    }

    // Explicit listenHost if provided
    if (listenHost) {
      const cleanListenHost = unmapIpv6(listenHost.toLowerCase().replace(/^\[|\]$/g, ""));
      if (hostname === cleanListenHost) return true;
    }

    // Check all local network interface addresses (IPv4 & IPv6)
    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const info of iface ?? []) {
        const addr = unmapIpv6(info.address.toLowerCase().replace(/^\[|\]$/g, ""));
        if (hostname === addr) return true;
      }
    }

    return false;
  } catch {
    return false;
  }
}
