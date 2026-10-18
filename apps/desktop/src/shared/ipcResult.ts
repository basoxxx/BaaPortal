// ipcMain.handle -> ipcRenderer.invoke perde le proprietà custom degli Error (es. `code`):
// gli errori vengono quindi trasportati come dati e ricostruiti nel preload.
export type IpcResult<T> = { ok: true; value: T } | { ok: false; message: string; code?: string };

export async function toIpcResult<T>(fn: () => Promise<T>): Promise<IpcResult<T>> {
  try {
    return { ok: true, value: await fn() };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    const code = (err as { code?: unknown } | null)?.code;
    return typeof code === 'string' ? { ok: false, message, code } : { ok: false, message };
  }
}

export function fromIpcResult<T>(result: IpcResult<T>): T {
  if (result.ok) return result.value;
  throw Object.assign(new Error(result.message), result.code ? { code: result.code } : {});
}
