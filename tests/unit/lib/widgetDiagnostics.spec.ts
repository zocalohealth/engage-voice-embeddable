import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { WidgetBuildInfo } from 'src/app/views/SettingsView/WidgetBuildInfo';
import { diagnosticAgentState, diagnosticLeadState } from 'src/lib/widgetDiagnostics';

it('shows the bundle revision in Settings, including the full hash in a title', () => {
  const build = { version: '1.0.0-beta', commit: '43161e0f85d0e69c2c02cb3ba0714ec46daeb932', builtAt: '2026-09-29T12:00:00.000Z' };
  const html = renderToStaticMarkup(React.createElement(WidgetBuildInfo, { build }));
  expect(html).toContain('43161e0');
  expect(html).toContain(`title="${build.commit}"`);
  expect(html).toContain(build.version);
  expect(html).toContain(build.builtAt);
});

it('cannot leak free text from SDK state values', () => {
  expect(diagnosticAgentState('AVAILABLE')).toBe('AVAILABLE');
  expect(diagnosticAgentState('sensitive')).toBe('unknown');
  expect(diagnosticLeadState('HANGUP')).toBe('HANGUP');
  expect(diagnosticLeadState('sensitive')).toBe('unknown');
});
