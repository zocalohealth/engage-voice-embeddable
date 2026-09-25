import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('@ringcentral-integration/next-core', () => ({
  injectable: () => (target: any) => target,
  optional: () => () => undefined,
  RcViewModule: class {},
  useConnector: (select: () => unknown) => select(),
}));
jest.mock('@ringcentral-integration/micro-core/src/app/hooks', () => ({
  useLocale: () => ({ t: (key: string) => key }),
}));
jest.mock('@ringcentral/spring-ui', () => ({
  Button: ({ children, disabled, onClick }: any) => React.createElement('button', { disabled, onClick }, children),
  List: ({ children }: any) => React.createElement('div', {}, children),
  EmptyState: ({ description }: any) => React.createElement('p', {}, description),
}));
jest.mock('@ringcentral/spring-icon', () => ({ OutgoingCallMd: () => null, MissedCallMd: () => null }));
jest.mock('src/app/services/EvLeads', () => ({
  ALLOW_DIAL_STATES: ['PENDING'], DISABLE_MANUAL_PASS_STATES: [], PHONE_DELIMETER: '|',
}));
jest.mock('src/app/components/LeadItem', () => ({ LeadItem: () => null }));
jest.mock('src/app/views/LeadsView/i18n', () => ({ default: {} }));

import { LeadsView } from 'src/app/views/LeadsView/LeadsView.view';
import { Button } from '@ringcentral/spring-ui';

function setup() {
  const progressive = { enabled: true, running: false, phase: 'stopped', secondsUntilNextCall: 3, canStart: true, start: jest.fn(), stop: jest.fn() };
  const working = { agentState: { agentState: 'AVAILABLE' }, isPendingDisposition: false };
  const view = new LeadsView(
    { filteredLeads: [], loading: false } as any, progressive as any,
    { isDialing: false } as any, working as any, {} as any,
    { agentConfig: {}, authenticateResponse: {} } as any, {} as any, {} as any,
    { leadViewerEnabled: false } as any,
  );
  const render = () => renderToStaticMarkup(React.createElement(() => view.component()));
  function findButton(node: any): any {
    if (!node || typeof node !== 'object') return undefined;
    if (node.type === Button) return node;
    return React.Children.toArray(node.props?.children).map(findButton).find(Boolean);
  }
  return { progressive, working, render, button: () => findButton(view.component()) };
}

describe('progressive controls in the lead panel', () => {
  it('starts the progressive service from the enabled group controls', () => {
    const d = setup();
    expect(d.render()).toContain('startProgressive');
    expect(d.render()).not.toContain('getLeads</button>');
    d.button().props.onClick();
    expect(d.progressive.start).toHaveBeenCalledTimes(1);
  });

  it('keeps Stop enabled during a call or disposition', () => {
    const d = setup();
    d.progressive.running = true;
    d.progressive.canStart = false;
    d.progressive.phase = 'waiting';
    d.working.isPendingDisposition = true;
    d.working.agentState.agentState = 'ENGAGED';
    expect(d.render()).toContain('stopProgressive');
    expect(d.button().props.disabled).toBe(false);
    d.button().props.onClick();
    expect(d.progressive.stop).toHaveBeenCalledTimes(1);
  });

  it('disables Start when agent readiness requirements are unmet', () => {
    const d = setup();
    d.progressive.canStart = false;
    expect(d.button().props.disabled).toBe(true);
  });

  it('preserves the manual preview controls for non-progressive groups', () => {
    const d = setup();
    d.progressive.enabled = false;
    expect(d.render()).toContain('getLeads</button>');
    expect(d.render()).not.toContain('startProgressive');
  });
});
