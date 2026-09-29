import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';

jest.mock('@ringcentral/spring-ui', () => {
  const React = require('react');
  return {
    Autocomplete: ({ options, renderOption, renderTags, value }: any) => React.createElement('div', null,
      renderTags(value, (item: any) => ({ label: item.label })),
      options.map((option: any, index: number) => renderOption(option, { index }))),
    Chip: ({ label }: any) => React.createElement('span', null, label),
    ListItemText: ({ primary, secondary }: any) => React.createElement('span', null, primary, ': ', secondary),
    StatusIndicator: ({ variant }: any) => React.createElement('i', { 'data-status': variant }),
  };
});

import { InternalTransferTab } from 'src/app/components/TransferPanel/InternalTransferTab';
const agents = [
  { agentId: 'busy', firstName: 'Busy', lastName: 'Agent', username: 'busy', available: false },
  { agentId: 'ready', firstName: 'Ready', lastName: 'Agent', username: 'ready', available: true },
];
const props = {
  isActive: true, agentList: agents, selectedAgentId: 'ready',
  updatedAt: 100000, failed: false, onSelectAgent: jest.fn(), fetchAgentList: jest.fn(),
  labels: { searchAgents: 'Search', noAgents: 'No agents', available: 'Available',
    unavailable: 'Unavailable', unknown: 'Unknown', refreshFailed: 'Refresh failed',
    checking: 'Checking', checked: (seconds: number) => `Checked ${seconds}s ago` },
};

describe('transfer availability display', () => {
  beforeEach(() => jest.spyOn(Date, 'now').mockReturnValue(100000));
  afterEach(() => jest.restoreAllMocks());
  it('sorts available recipients first and labels the selected recipient', () => {
    const html = renderToStaticMarkup(React.createElement(InternalTransferTab, props));
    expect(html.indexOf('Ready Agent: Available')).toBeLessThan(html.indexOf('Busy Agent: Unavailable'));
    expect(html).toContain('Ready Agent · Available');
    expect(html).toContain('Checked 0s ago');
  });
  it.each([{ failed: true }, { updatedAt: 89999 }])('never shows cached availability as fresh for %j', (override) => {
    const html = renderToStaticMarkup(React.createElement(InternalTransferTab, { ...props, ...override }));
    expect(html).toContain('Ready Agent · Unknown');
    expect(html).not.toContain('data-status="available"');
  });
  it('distinguishes a confirmed empty list from a loading list', () => {
    const empty = renderToStaticMarkup(React.createElement(InternalTransferTab, { ...props, agentList: [] }));
    const loading = renderToStaticMarkup(React.createElement(InternalTransferTab, { ...props, agentList: [], updatedAt: 0 }));
    expect(empty).toContain('No agents');
    expect(loading).toContain('Checking');
    expect(loading).not.toContain('No agents');
  });
});
