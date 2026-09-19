import os from "node:os";

/**
 * Does this target URL point back to the local daemon's own listen address?
 * (isocan-vab: prevents infinite self-dialing loops that exhaust the socket table).
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

    const hostname = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
    if (
      hostname === "localhost" ||
      hostname === "0.0.0.0" ||
      hostname === "::" ||
      hostname === "::1" ||
      hostname.startsWith("127.")
    ) {
      return true;
    }

    if (listenHost && hostname === listenHost.toLowerCase().replace(/^\[|\]$/g, "")) {
      return true;
    }

    const ifaces = os.networkInterfaces();
    for (const iface of Object.values(ifaces)) {
      for (const info of iface ?? []) {
        if (info.address.toLowerCase() === hostname) return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}
