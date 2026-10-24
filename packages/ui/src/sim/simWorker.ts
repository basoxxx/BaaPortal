/// Solo collegamento: tutta la logica è in `SimHost`, che qui riceve l'orologio e i timer del Worker.
import { SimHost } from './host';
import type { SimWireMessage, SimWireRequest } from './protocol';

const scope = self as unknown as {
  onmessage: ((e: { data: SimWireRequest }) => void) | null;
  postMessage(m: SimWireMessage, transfer?: Transferable[]): void;
};

const send = (m: SimWireMessage): void => {
  const buffers: Transferable[] = [];
  if (m.type === 'notice' && m.notice.kind === 'status')
    buffers.push(m.notice.inputs.buffer, m.notice.outputs.buffer); // copie già staccate dalla memoria
  scope.postMessage(m, buffers);
};

const host = new SimHost({
  post: (notice) => send({ type: 'notice', notice }),
  now: () => performance.now(),
  schedule: (fn, ms) => {
    const h = setTimeout(fn, ms);
    return () => clearTimeout(h);
  },
});

scope.onmessage = (e) => {
  const { id, req } = e.data;
  host.handle(req).then(
    (value) => send({ type: 'response', id, ok: true, value }),
    (err: unknown) =>
      send({
        type: 'response',
        id,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
  );
};
