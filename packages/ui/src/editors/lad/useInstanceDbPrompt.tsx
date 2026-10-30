// Rilascio di un FC/FB dall'albero in KOP/FUP: l'istanza del box CALL. Per un FB senza DB di
// istanza chiede di crearlo (`InstanceDbDialog`) e inserisce il box solo dopo OK.
import { useState } from 'react';
import { createInstanceDb, findDevice, type PlcDevice } from '@baaportal/project';
import { useServices } from '../../state/AppContext';
import { callInstanceOf } from '../block/callInstance';
import { InstanceDbDialog } from './InstanceDbDialog';

type Ask = { fb: string; done: (instance: string | undefined) => void };

export function useInstanceDbPrompt(dev: PlcDevice | undefined) {
  const { store } = useServices();
  const [ask, setAsk] = useState<Ask | null>(null);
  const callOfDrop = (raw: string): string | Promise<string | undefined> | undefined => {
    const inst = callInstanceOf(dev, raw);
    const fb = inst && /^"(.*)", $/.exec(inst)?.[1];
    if (!fb) return inst;
    return new Promise((done) => setAsk({ fb, done }));
  };
  const close = (instance: string | undefined) => {
    ask?.done(instance);
    setAsk(null);
  };
  const dialog =
    ask && dev ? (
      <InstanceDbDialog
        device={dev}
        fb={ask.fb}
        onCancel={() => close(undefined)}
        onOk={(name, number) => {
          const db = createInstanceDb({ number, name, instanceOf: ask.fb });
          store.getState().edit('history.addBlock', (p) => {
            findDevice(p, dev.id)?.blocks.push(db);
          });
          close(`"${ask.fb}", "${name}"`);
        }}
      />
    ) : null;
  return { callOfDrop, dialog };
}
