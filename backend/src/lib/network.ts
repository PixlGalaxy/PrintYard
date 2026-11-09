import { existsSync, readFileSync } from 'node:fs';
import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os';
import { IpMatcher, isPrivateIp } from './ip.js';

export type InterfaceMap = Record<string, NetworkInterfaceInfo[] | undefined>;

/** Virtual interfaces that never face the physical LAN. */
const VIRTUAL_IFACE = /^(lo|docker\d*|veth|br-|virbr|cni|flannel|cali|vxlan|tun|tap|wg|tailscale|zt|podman|vEthernet)/i;

const dockerPool = new IpMatcher();
dockerPool.add('172.16.0.0/12');

/** Best-effort: are we inside a container (Docker/Podman)? */
export function inContainer(): boolean {
  if (existsSync('/.dockerenv') || existsSync('/run/.containerenv')) return true;
  try {
    return /docker|containerd|kubepods|libpod/.test(readFileSync('/proc/1/cgroup', 'utf8'));
  } catch {
    return false;
  }
}

export interface LanAddress {
  iface: string;
  address: string;
  netmask: string;
}

/**
 * Private IPv4 addresses on interfaces that look like they face the physical LAN.
 * Inside a container, 172.16/12 (Docker's bridge pool, eth0 172.17.x by default) is skipped.
 */
export function lanIPv4Addresses(ifaces: InterfaceMap = networkInterfaces(), containerized = inContainer()): LanAddress[] {
  const out: LanAddress[] = [];
  for (const [name, entries] of Object.entries(ifaces)) {
    if (!entries || VIRTUAL_IFACE.test(name)) continue;
    for (const e of entries) {
      if (e.internal || e.family !== 'IPv4') continue;
      if (!isPrivateIp(e.address) || e.address.startsWith('127.') || e.address.startsWith('169.254.')) continue;
      if (containerized && dockerPool.has(e.address)) continue;
      out.push({ iface: name, address: e.address, netmask: e.netmask });
    }
  }
  return out;
}

/**
 * Contract `hostNetworkLikely`: true if we can see a LAN interface other than Docker's bridge.
 * With `--network host` the container sees the host's real NICs; on the default bridge it only has eth0 172.17.x.
 */
export function hostNetworkLikely(ifaces?: InterfaceMap, containerized?: boolean): boolean {
  return lanIPv4Addresses(ifaces, containerized).length > 0;
}

/** The /24 prefixes ("192.168.8") of the LAN interfaces, deduplicated, for MAC discovery sweeps. */
export function lanSubnets24(ifaces?: InterfaceMap, containerized?: boolean): { prefix: string; self: string }[] {
  const seen = new Map<string, string>();
  for (const a of lanIPv4Addresses(ifaces, containerized)) {
    const prefix = a.address.split('.').slice(0, 3).join('.');
    if (!seen.has(prefix)) seen.set(prefix, a.address);
  }
  return [...seen].map(([prefix, self]) => ({ prefix, self }));
}
