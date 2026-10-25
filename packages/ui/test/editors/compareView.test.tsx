import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { blockToMc7File, findDevice, type CodeBlock } from '@baaportal/project';
import { diffNetworks } from '../../src/editors/compare/lineDiff';
import { PLC, setupOnline } from '../online/downloadHelpers';

/** Il file MC7 del blocco dopo `change` (il blocco originale non si tocca). */
function cpuFile(
  app: Awaited<ReturnType<typeof setupOnline>>['app'],
  b: CodeBlock,
  change: (c: CodeBlock) => void,
) {
  const dev = findDevice(app.store.getState().doc!.project, PLC)!;
  const copy = structuredClone(b);
  change(copy);
  return blockToMc7File(
    copy,
    { ...dev, blocks: [...dev.blocks.filter((x) => x.id !== b.id), copy] },
    dev.cpu.model as never,
  ).file!;
}

async function openCompare(app: Awaited<ReturnType<typeof setupOnline>>['app'], b: CodeBlock) {
  act(() => app.store.getState().openEditor({ kind: 'compare', deviceId: PLC, objectId: b.id }));
  await screen.findByTestId('compare-view');
}

describe('editor di confronto', () => {
  it('le righe diverse sono evidenziate', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    const b = blocks[0]!;
    const file = cpuFile(app, b, (c) => {
      c.networks[0]!.source = 'A %I0.0\n= %Q0.1';
    });
    app.bridge.plcUploadBlockResults.set('FC1', { ok: true, bytes: file });
    await openCompare(app, b);
    await waitFor(() => expect(screen.getByTestId('compare-net-0')).toBeInTheDocument());
    const net = screen.getByTestId('compare-net-0');
    const rows = [...net.querySelectorAll('tr')];
    expect(rows.map((r) => r.getAttribute('data-diff'))).toEqual(['same', 'changed']);
    expect(rows[1]!.textContent).toContain('%Q0.0');
    expect(rows[1]!.textContent).toContain('%Q0.1');
    expect(app.bridge.plcUploadBlockCalls).toEqual(['FC1']);
  }, 30_000);

  it('reti in più su un lato', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    const b = blocks[0]!;
    const file = cpuFile(app, b, (c) => {
      c.networks.push({ id: 'n2', title: 'Extra', comment: '', source: 'A %I0.1\n= %Q0.2' });
    });
    app.bridge.plcUploadBlockResults.set('FC1', { ok: true, bytes: file });
    await openCompare(app, b);
    await waitFor(() => expect(screen.getByTestId('compare-net-1')).toBeInTheDocument());
    expect(screen.getByTestId('compare-net-0').getAttribute('data-presence')).toBe('both');
    expect(screen.getByTestId('compare-net-1').getAttribute('data-presence')).toBe('right');
    expect(
      [...screen.getByTestId('compare-net-1').querySelectorAll('tr')].every(
        (r) => r.getAttribute('data-diff') === 'added',
      ),
    ).toBe(true);
  }, 30_000);

  it('blocco online non decodificabile → si mostra in esadecimale con la nota', async () => {
    const { app, blocks } = await setupOnline([['FC', 1]]);
    app.bridge.plcUploadBlockResults.set('FC1', {
      ok: true,
      bytes: Uint8Array.from([0xde, 0xad, 0xbe, 0xef]),
    });
    await openCompare(app, blocks[0]!);
    expect(await screen.findByTestId('compare-undecodable')).toBeInTheDocument();
    expect(screen.getByTestId('compare-hex').textContent).toContain('de ad be ef');
  }, 30_000);

  it('diff per righe: reti allineate per posizione', () => {
    const d = diffNetworks([{ title: 'a', lines: ['x'] }], []);
    expect(d[0]!.presence).toBe('left');
    expect(d[0]!.rows[0]!.kind).toBe('missing');
  });
});
