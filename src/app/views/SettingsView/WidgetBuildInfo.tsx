import React from 'react';
import { WIDGET_BUILD } from '../../../lib/widgetDiagnostics';

export function WidgetBuildInfo({ build = WIDGET_BUILD }: { build?: typeof WIDGET_BUILD }) {
  return (
    <span className="typography-mainText text-neutral-b2 text-right" data-sign="widgetBuild">
      <span>{build.version}</span>
      <span className="block" title={build.commit}>{build.commit === 'local' ? 'local' : build.commit.slice(0, 7)}</span>
      {build.builtAt && <span className="block text-xs">{build.builtAt}</span>}
    </span>
  );
}
