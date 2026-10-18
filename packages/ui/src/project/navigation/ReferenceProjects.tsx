import { useTranslation } from 'react-i18next';

/** In 1A non esistono progetti di riferimento: la sezione è vuota. */
export function ReferenceProjects() {
  const { t } = useTranslation();
  return <p className="baa-placeholder">{t('navigation.referenceEmpty')}</p>;
}
