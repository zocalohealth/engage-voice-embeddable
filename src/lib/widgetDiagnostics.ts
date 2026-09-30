export const WIDGET_BUILD = {
  version: process.env.WIDGET_BUILD_VERSION || 'local',
  commit: process.env.WIDGET_BUILD_COMMIT || 'local',
  builtAt: process.env.WIDGET_BUILD_AT || null,
};

export const DIAGNOSTIC_AGENT_STATES = ['AVAILABLE', 'AWAY', 'ON-BREAK', 'WORKING', 'ENGAGED', 'TRANSITION', 'PREVIEWING', 'RNA-STATE', 'unknown'] as const;
export function diagnosticAgentState(value: unknown): typeof DIAGNOSTIC_AGENT_STATES[number] {
  return DIAGNOSTIC_AGENT_STATES.find((state) => state === value) || 'unknown';
}
export const DIAGNOSTIC_LEAD_STATES = ['PENDING', 'DIALING', 'RINGING', 'NOANSWER', 'BUSY', 'MACHINE', 'HANGUP', 'INTERCEPT', 'DISCONNECT', 'ABANDON', 'CONGESTION', 'APP-DNC', 'OTHER', 'unknown'] as const;
export function diagnosticLeadState(value: unknown): typeof DIAGNOSTIC_LEAD_STATES[number] {
  return DIAGNOSTIC_LEAD_STATES.find((state) => state === value) || 'unknown';
}
export const DIAGNOSTIC_EVENTS = ['widget_loaded', 'state_changed', 'agent_state', 'progressive_error', 'hangup_clicked', 'progressive_start_clicked', 'progressive_stop_clicked', 'command_requested', 'command_dispatched', 'command_failed', 'command_ack', 'call_started', 'call_ended', 'session_added', 'session_dropped', 'lead_state', 'socket_opened', 'socket_closed', 'offhook_ended'] as const;
export const DIAGNOSTIC_COMMANDS = ['hangup', 'manual_cancel', 'offhook_term', 'preview_dial', 'agent_state'] as const;
export type WidgetDiagnosticAction = {
  event: typeof DIAGNOSTIC_EVENTS[number];
  command?: typeof DIAGNOSTIC_COMMANDS[number];
  ackStatus?: 'OK' | 'FAIL' | 'unknown';
  reason?: 'phone_unavailable' | 'offhook_timeout' | 'lead_fetch_failed' | 'dial_send_failed' | 'call_start_timeout' | 'available_timeout' | 'available_request_failed';
  hasCallIdentifier?: boolean;
  leadState?: typeof DIAGNOSTIC_LEAD_STATES[number];
};
