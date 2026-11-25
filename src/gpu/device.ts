let devicePromise: Promise<GPUDevice | null> | null = null;
let adapterInfo: GPUAdapterInfo | null = null;

export function webgpuAvailable(): boolean {
  return typeof navigator !== 'undefined' && 'gpu' in navigator && !!navigator.gpu;
}

export async function getGpuDevice(): Promise<GPUDevice | null> {
  if (devicePromise) return devicePromise;
  devicePromise = (async () => {
    if (!webgpuAvailable()) return null;
    try {
      const adapter = await navigator.gpu.requestAdapter({ powerPreference: 'high-performance' });
      if (!adapter) return null;
      adapterInfo = adapter.info ?? null;
      const device = await adapter.requestDevice();
      device.lost.then((info) => {
        console.error('WebGPU device lost:', info.message, info.reason);
        devicePromise = null;
      });
      return device;
    } catch (err) {
      console.warn('WebGPU initialization failed, CPU reference backend will be used:', err);
      return null;
    }
  })();
  return devicePromise;
}

export function getAdapterInfo(): GPUAdapterInfo | null {
  return adapterInfo;
}
