import React from 'react';
import { useLocale } from '@ringcentral-integration/micro-core/src/app/hooks';
import type { EvProgressiveDialer } from '../../services/EvProgressiveDialer';
import i18n from './i18n';

export function ProgressiveLeadStatus({ running, phase, secondsUntilNextCall }: Pick<EvProgressiveDialer, 'running' | 'phase' | 'secondsUntilNextCall'>) {
  const { t } = useLocale(i18n);
  if (!running || (phase !== 'empty' && phase !== 'fetching')) return null;
  return (
    <div role="status" aria-live="polite" className="flex-shrink-0 p-3 text-sm text-center border-b border-neutral-b4 bg-neutral-base" data-sign="progressiveLeadStatus">
      {phase === 'empty'
        ? t('noProgressiveLeads', { seconds: secondsUntilNextCall })
        : t('checkingProgressiveLeads')}
    </div>
  );
}
