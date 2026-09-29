import React, { useCallback, useEffect, useMemo, useRef, useState, type FunctionComponent } from 'react';
import { Autocomplete, Chip, ListItemText, StatusIndicator } from '@ringcentral/spring-ui';
import type { AutocompleteRef, SuggestionListItemData } from '@ringcentral/spring-ui';

import type { EvDirectAgentListItem } from '../../services/EvTransferCall/EvTransferCall.interface';
import { filterByContains } from './filterOptions';

const AGENT_LIST_POLL_INTERVAL = 3000;

interface AgentOption extends SuggestionListItemData {
  agentId: string;
  available: boolean;
}

interface InternalTransferTabProps {
  isActive: boolean;
  agentList: EvDirectAgentListItem[];
  updatedAt: number;
  failed: boolean;
  selectedAgentId: string | null;
  onSelectAgent: (agentId: string) => void;
  fetchAgentList: () => void;
  labels: {
    searchAgents: string;
    noAgents: string;
    available: string;
    unavailable: string;
    unknown: string;
    refreshFailed: string;
    checking: string;
    checked: (seconds: number) => string;
  };
}

/**
 * Internal transfer tab content with agent autocomplete and periodic polling.
 */
export const InternalTransferTab: FunctionComponent<InternalTransferTabProps> = ({
  isActive,
  agentList,
  updatedAt,
  failed,
  selectedAgentId,
  onSelectAgent,
  fetchAgentList,
  labels,
}) => {
  const actionRef = useRef<AutocompleteRef>(null);
  const [now, setNow] = useState(Date.now());
  const fresh = !failed && updatedAt > 0 && now - updatedAt < 10000;
  const statusLabel = (available: boolean) => fresh ? (available ? labels.available : labels.unavailable) : labels.unknown;

  useEffect(() => {
    if (!isActive) return;
    setNow(Date.now());
    const clock = setInterval(() => setNow(Date.now()), 1000);
    fetchAgentList();
    const timerId = setInterval(fetchAgentList, AGENT_LIST_POLL_INTERVAL);
    return () => { clearInterval(timerId); clearInterval(clock); };
  }, [fetchAgentList, isActive]);

  useEffect(() => {
    if (isActive) {
      actionRef.current?.focus();
    }
  }, [isActive]);

  const options: AgentOption[] = useMemo(
    () =>
      [...agentList].sort((a, b) => Number(b.available === true) - Number(a.available === true)).map((agent) => ({
        id: agent.agentId,
        label: (agent.firstName || agent.lastName)
          ? `${agent.firstName} ${agent.lastName}`.trim()
          : agent.username,
        agentId: agent.agentId,
        available: agent.available === true,
        disabled: !fresh || agent.available !== true,
      })),
    [agentList, fresh],
  );

  const selectedValue = useMemo(() => {
    if (!selectedAgentId) return [];
    const found = options.find((o) => o.agentId === selectedAgentId);
    return found ? [found] : [];
  }, [options, selectedAgentId]);

  const handleChange = useCallback(
    (selectedItems: SuggestionListItemData[]) => {
      const selected = selectedItems.length > 0
        ? (selectedItems[selectedItems.length - 1] as AgentOption)
        : null;
      onSelectAgent(selected?.agentId ?? '');
    },
    [onSelectAgent],
  );

  return (
    <div className="flex-1 overflow-hidden" data-sign="internalTransferTab">
      <p role="status" className="typography-subText mb-2">
        {failed ? labels.refreshFailed : !updatedAt ? labels.checking : fresh ? labels.checked(Math.max(0, Math.floor((now - updatedAt) / 1000))) : labels.unknown}
      </p>
      {fresh && agentList.length === 0 && <p>{labels.noAgents}</p>}
      <Autocomplete
        action={actionRef}
        data-sign="agentAutocomplete"
        variant="tags"
        inputVariant="outlined"
        options={options}
        value={selectedValue}
        onChange={handleChange}
        placeholder={labels.searchAgents}
        openOnFocus
        toggleButton
        size="medium"
        filterOptions={filterByContains}
        renderTags={(selectedItems, getTagProps) =>
          selectedItems.map((item, index) => {
            const agent = item as AgentOption;
            const { label, ...itemChipProps } = getTagProps(item, index);
            const { id, ...rest } = agent;
            return (
              <Chip
                key={id}
                aria-label={`${label}, press Backspace to remove`}
                {...rest}
                {...itemChipProps}
                label={`${label} · ${statusLabel(agent.available)}`}
                size="small"
                startSlot={
                  <StatusIndicator
                    variant={fresh && agent.available ? 'available' : 'unavailable'}
                    size="medium"
                  />
                }
              />
            );
          })
        }
        renderOption={(option, state) => {
          const { agentId, available, label, id, error, disabled, className, ...restProps } = option as AgentOption & Record<string, unknown>;
          const itemClassName = [
            'sui-suggestion-list-item',
            state.highlighted && 'sui-suggestion-list-highlighted',
            className,
          ].filter(Boolean).join(' ');
          return (
            <div
              id={`${id}`}
              aria-disabled={disabled || undefined}
              className={itemClassName}
              {...(restProps as React.HTMLAttributes<HTMLDivElement>)}
              key={`${id || label}-${state.index}`}
            >
              <StatusIndicator
                variant={fresh && available ? 'available' : 'unavailable'}
                size="medium"
              />
              <ListItemText
                primary={label}
                secondary={statusLabel(available)}
              />
            </div>
          );
        }}
      />
    </div>
  );
};
