/**
 * Provider registry — aggregates every provider's device list and routes a
 * device id to the provider that owns it.
 *
 * Device ids are `"<kind>:<native id>"` (ARCHITECTURE.md), so routing is a prefix
 * lookup; providers never see ids belonging to another provider.
 */

import type { Device, DeviceHandle, DeviceKind, Provider } from "./types.ts";

export function kindOfDeviceId(deviceId: string): string {
  const i = deviceId.indexOf(":");
  if (i <= 0) throw new Error(`malformed device id: "${deviceId}"`);
  return deviceId.slice(0, i);
}

export class DeviceRegistry {
  private readonly providers = new Map<DeviceKind, Provider>();
  private readonly cache = new Map<DeviceKind, Device[]>();
  private readonly listeners = new Set<(devices: Device[]) => void>();
  private readonly unwatchers: Array<() => void> = [];

  register(provider: Provider): void {
    if (this.providers.has(provider.kind)) {
      throw new Error(`provider already registered for kind ${provider.kind}`);
    }
    this.providers.set(provider.kind, provider);
    this.cache.set(provider.kind, []);
    this.unwatchers.push(
      provider.watch((devices) => {
        this.cache.set(provider.kind, devices);
        this.emit();
      }),
    );
  }

  get(kind: string): Provider | undefined {
    return this.providers.get(kind as DeviceKind);
  }

  /** Live view assembled from the per-provider watch caches. */
  devices(): Device[] {
    return [...this.cache.values()].flat();
  }

  /** Authoritative list — asks every provider. */
  async list(): Promise<Device[]> {
    const results = await Promise.all(
      [...this.providers.values()].map(async (p) => {
        try {
          const devices = await p.list();
          this.cache.set(p.kind, devices);
          return devices;
        } catch (err) {
          this.onProviderError?.(p.kind, err);
          return this.cache.get(p.kind) ?? [];
        }
      }),
    );
    return results.flat();
  }

  async open(deviceId: string): Promise<DeviceHandle> {
    return this.providerFor(deviceId).open(deviceId);
  }

  providerFor(deviceId: string): Provider {
    const kind = kindOfDeviceId(deviceId);
    const provider = this.get(kind);
    if (!provider) throw new Error(`no provider for device "${deviceId}"`);
    return provider;
  }

  /** Subscribe to aggregated device-list changes. @returns unsubscribe */
  watch(cb: (devices: Device[]) => void): () => void {
    this.listeners.add(cb);
    return () => this.listeners.delete(cb);
  }

  onProviderError?: (kind: DeviceKind, err: unknown) => void;

  async dispose(): Promise<void> {
    for (const un of this.unwatchers.splice(0)) un();
    for (const p of this.providers.values()) await p.dispose?.();
    this.listeners.clear();
  }

  private emit(): void {
    const devices = this.devices();
    for (const cb of this.listeners) {
      try {
        cb(devices);
      } catch (err) {
        this.onProviderError?.("mock", err);
      }
    }
  }
}
