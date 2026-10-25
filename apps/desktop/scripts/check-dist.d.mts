export function checkDist(
  dir: string,
  platform: 'win32' | 'darwin',
  version: string,
): Promise<string[]>;
export function mergeMac(dir: string): void;
