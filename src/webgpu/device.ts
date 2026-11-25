let devicePromise: Promise<GPUDevice | null> | null = null;
let adapterInfo: { vendor?: string; architecture?: string; device?: string; description?: string } | null = null;

export async function getWebGPUDevice(): Promise<GPUDevice | null> {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    if (typeof navigator === 'undefined' || !navigator.gpu) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      adapterInfo = (adapter as unknown as { info?: typeof adapterInfo }).info
        ? { ...(adapter as unknown as { info: Record<string, string> }).info }
        : null;
      const device = await adapter.requestDevice();
      device.lost.then((info) => {
        console.error('WebGPU device lost:', info.message);
        devicePromise = null;
      });
      return device;
    } catch (err) {
      console.warn('WebGPU initialization failed, using CPU fallback:', err);
      return null;
    }
  })();
  return devicePromise;
}

export function getAdapterInfo() {
  return adapterInfo;
}

export function webgpuAvailableSync(): boolean {
  return typeof navigator !== 'undefined' && !!navigator.gpu;
}
