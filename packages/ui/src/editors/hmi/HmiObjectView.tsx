import { useTranslation } from 'react-i18next';
import type { HmiObject, HmiScreen } from '@baaportal/project';

/** Aspetto di un oggetto nell'editor (senza valori): la variabile al posto del valore. */
export function HmiObjectView({ o, screens }: { o: HmiObject; screens: HmiScreen[] }) {
  const { t } = useTranslation();
  switch (o.kind) {
    case 'text':
      return <span className="baa-hmi-text">{o.text}</span>;
    case 'ioField':
      return <span className={`baa-hmi-io${o.input ? ' is-input' : ''}`}>{o.tag || o.format}</span>;
    case 'button':
      return <span className="baa-hmi-button">{o.text}</span>;
    case 'lamp':
      return (
        <span className="baa-hmi-lamp-wrap">
          <span className="baa-hmi-lamp" style={{ background: o.offColor }} />
          {o.text ? <span className="baa-hmi-text">{o.text}</span> : null}
        </span>
      );
    case 'bar':
      return (
        <span className="baa-hmi-bar-frame">
          <span
            className="baa-hmi-bar-fill"
            style={o.h >= o.w ? { height: '50%' } : { width: '50%' }}
          />
        </span>
      );
    case 'screenButton': {
      const target = screens.find((s) => s.id === o.screen);
      return (
        <span className="baa-hmi-button" title={target?.name ?? t('hmi.noTarget')}>
          {o.text}
        </span>
      );
    }
  }
}
