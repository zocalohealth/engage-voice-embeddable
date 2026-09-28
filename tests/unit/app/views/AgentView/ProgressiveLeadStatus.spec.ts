import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import messages from 'src/app/views/AgentView/i18n/en-US';
jest.mock('@ringcentral-integration/micro-core/src/app/hooks', () => ({
  useLocale: () => ({ t: (key: keyof typeof messages, values?: { seconds: number }) =>
    messages[key].replace('{seconds}', String(values?.seconds)) }),
}));
import { ProgressiveLeadStatus } from 'src/app/views/AgentView/ProgressiveLeadStatus';

describe('progressive status outside the Leads tab', () => {
  it('announces no available leads and the automatic retry while still running', () => {
    const html = renderToStaticMarkup(React.createElement(ProgressiveLeadStatus, { running: true, phase: 'empty', secondsUntilNextCall: 5 }));
    expect(html).toContain('role="status"');
    expect(html).toContain('No leads available. Checking again in 5s. Progressive dialing is still running.');
  });
  it('shows a pending lookup separately from an empty result', () => {
    const html = renderToStaticMarkup(React.createElement(ProgressiveLeadStatus, { running: true, phase: 'fetching', secondsUntilNextCall: 0 }));
    expect(html).toContain('Checking for the next lead');
    expect(html).not.toContain('No leads available');
  });
  it('does not announce a stale empty result after Stop', () => {
    expect(renderToStaticMarkup(React.createElement(ProgressiveLeadStatus, { running: false, phase: 'empty', secondsUntilNextCall: 5 }))).toBe('');
  });
});
