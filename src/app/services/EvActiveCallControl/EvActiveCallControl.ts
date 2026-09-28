import {
  action,
  injectable,
  optional,
  PortManager,
  RcModule,
  state,
  storage,
  StoragePlugin,
  delegate,
} from '@ringcentral-integration/next-core';

import { Toast } from '@ringcentral-integration/micro-core/src/app/services';

import { EvClient } from '../EvClient';
import { EvCallbackTypes, evStatus } from '../EvClient/enums';
import type { EvHoldResponse } from '../EvClient/interfaces';
import { EvPresence } from '../EvPresence';
import { EvSubscription } from '../EvSubscription';
import { EvIntegratedSoftphone } from '../EvIntegratedSoftphone';
import { EvAgentSession } from '../EvAgentSession';
import type {
  EvActiveCallControlOptions,
  EvClientHangUpParams,
  EvClientHoldSessionParams,
} from './EvActiveCallControl.interface';

/**
 * Session id of the main call leg. Every other session reports its own hold
 * state through the same response, so a general hold is only confirmed by this
 * one -- the same filter eag applies in `CallService.holdCallback`.
 */
const MAIN_SESSION_ID = '1';

/** How long to wait for the server to confirm a hold before giving up. */
const HOLD_RESPONSE_TIMEOUT = 10 * 1000;
const HANGUP_RESPONSE_TIMEOUT = 10 * 1000;

/**
 * EvActiveCallControl module - Active call control operations
 * Handles call recording, mute, hold, hangup, and DTMF operations
 */
@injectable({
  name: 'EvActiveCallControl',
})
class EvActiveCallControl extends RcModule {
  private hangups = new Map<string, Promise<boolean>>();
  constructor(
    private evClient: EvClient,
    private evPresence: EvPresence,
    private evSubscription: EvSubscription,
    private evIntegratedSoftphone: EvIntegratedSoftphone,
    private evAgentSession: EvAgentSession,
    private storagePlugin: StoragePlugin,
    private toast: Toast,
    @optional('EvActiveCallControlOptions')
    private evActiveCallControlOptions?: EvActiveCallControlOptions,
  ) {
    super();
    this.storagePlugin.enable(this);
  }

  @storage
  @state
  isRecording: boolean | null = null;

  @storage
  @state
  timeStamp: number | null = null;

  /**
   * Set by EvTransferCall after a warm transfer that held the customer, so
   * hanging up the consult leg brings them back off hold. Not persisted: it
   * only describes the call leg the agent is on right now.
   */
  @state
  unholdOnHangup = false;

  @action
  setIsRecording(isRecording: boolean) {
    this.isRecording = isRecording;
  }

  @action
  setUnholdOnHangup(unholdOnHangup: boolean) {
    this.unholdOnHangup = unholdOnHangup;
  }

  @action
  pauseRecordAction() {
    this.isRecording = false;
    this.timeStamp = Date.now();
  }

  @action
  resumeRecordAction() {
    this.isRecording = true;
    this.timeStamp = null;
  }

  /**
   * Start recording the current call
   */
  @delegate('server')
  async record(): Promise<void> {
    const { state, message } = await this.evClient.record(true);
    if (state === 'RECORDING') {
      this.setIsRecording(true);
    } else {
      throw new Error(message);
    }
  }

  /**
   * Stop recording the current call
   */
  @delegate('server')
  async stopRecord(): Promise<void> {
    const { state, message } = await this.evClient.record(false);
    if (state === 'STOPPED') {
      this.setIsRecording(false);
    } else {
      throw new Error(message);
    }
  }

  /**
   * Pause recording the current call
   */
  @delegate('server')
  async pauseRecord(): Promise<void> {
    const { state, message } = await this.evClient.pauseRecord(false);
    if (state === 'PAUSED') {
      this.pauseRecordAction();
    } else {
      throw new Error(message);
    }
  }

  /**
   * Resume recording the current call
   */
  @delegate('server')
  async resumeRecord(): Promise<void> {
    this.resumeRecordAction();
  }

  /**
   * Send DTMF tone via keypad
   */
  @delegate('server')
  async onKeypadClick(value: string): Promise<void> {
    this.evClient.sipSendDTMF(value);
  }

  /**
   * Mute the current call
   */
  @delegate('server')
  async mute(): Promise<void> {
    await this._sipToggleMute(true);
  }

  /**
   * Unmute the current call
   */
  @delegate('server')
  async unmute(): Promise<void> {
    await this._sipToggleMute(false);
  }

  /**
   * Hang up a call by session ID
   */
  @delegate('server')
  async hangUp(sessionId: string): Promise<void> {
    const uii = this.liveCalls.find((call) => call.session?.sessionId === sessionId)?.uii;
    if (!await this.hangupSession({ sessionId })) return;
    // Leaving the consult leg of a warm transfer that held the customer: take
    // them off hold instead of leaving the agent talking to a held call.
    if (this.unholdOnHangup && this.liveCalls.some((call) => call.uii === uii)) {
      this.setUnholdOnHangup(false);
      try {
        await this.evClient.hold(false);
      } catch {
        this.setUnholdOnHangup(true);
        this.toast.danger({ message: 'The transfer leg ended, but the customer is still on hold. Press Unhold to reconnect.', ttl: 0 });
      }
    }
  }

  /**
   * Reject an incoming call
   */
  @delegate('server')
  async reject(): Promise<void> {
    this.logger.info('reject call');
  }

  /**
   * Put the current call on hold
   */
  @delegate('server')
  async hold(): Promise<void> {
    await this._changeOnHoldState(true);
  }

  /**
   * Take the current call off hold
   */
  @delegate('server')
  async unhold(): Promise<void> {
    await this._changeOnHoldState(false);
  }

  /**
   * Hold the current call and resolve only once the server has confirmed it,
   * rejecting if it does not. `hold()` cannot be used where the ordering
   * matters -- a warm transfer must not open the consult leg before the
   * customer is actually on hold -- because it only posts the request.
   *
   * The confirmation comes from the shared HOLD subscription rather than a
   * callback passed to `evClient.hold`: the agent library keeps a single
   * callback per response type, so passing one here would replace the handler
   * EvPresence uses to track hold state.
   */
  @delegate('server')
  async holdAndConfirm(): Promise<void> {
    const confirmed = this._waitForHoldResponse(true);
    await this.evClient.hold(true);
    await confirmed;
  }

  private _waitForHoldResponse(holdState: boolean): Promise<void> {
    return new Promise<void>((resolve, reject) => {
      const stopWaiting = () => {
        clearTimeout(timeoutId);
        this.evSubscription.off(EvCallbackTypes.HOLD, onHoldResponse);
      };
      const onHoldResponse = (data?: EvHoldResponse) => {
        if (data?.sessionId !== MAIN_SESSION_ID) return;
        // A hold toggle we did not ask for: keep waiting for ours.
        if (data.status === 'OK' && data.holdState !== holdState) return;
        stopWaiting();
        if (data.status === 'OK') {
          resolve();
        } else {
          reject(new Error(data.message || 'Hold request was rejected'));
        }
      };
      const timeoutId = setTimeout(() => {
        stopWaiting();
        reject(new Error('Hold request timed out'));
      }, HOLD_RESPONSE_TIMEOUT);
      this.evSubscription.subscribe(EvCallbackTypes.HOLD, onHoldResponse);
    });
  }

  /**
   * Resolve true only after the targeted live session disappears from presence.
   * Failed or unconfirmed requests show a persistent error and resolve false.
   */
  @delegate('server')
  async hangupSession({ sessionId }: EvClientHangUpParams): Promise<boolean> {
    const call = this.liveCalls.find((item) => item.session?.sessionId === sessionId);
    if (!call) {
      this.toast.danger({ message: 'This call is no longer active. Reopen the current call before trying Hang up again.', ttl: 0 });
      return false;
    }
    return this.confirmHangup(`${call.uii}:${sessionId}`,
      () => this.evClient.hangup({ sessionId }),
      () => !this.liveCalls.some((item) => item.uii === call.uii && item.session?.sessionId === sessionId));
  }

  @delegate('server')
  async hangUpDialer(): Promise<void> {
    const pending = this.hangups.get('pending');
    if (pending) { await pending; return; }
    const sessionId = this.evPresence.calls[0]?.session?.sessionId;
    if (sessionId) {
      await this.hangUp(sessionId);
      return;
    }
    const wasOffhook = this.evPresence.isOffhook;
    let offhookEnded = false;
    const onOffhookTerm = () => { offhookEnded = true; };
    this.evSubscription.subscribe(EvCallbackTypes.OFFHOOK_TERM, onOffhookTerm);
    let ended = () => offhookEnded || (wasOffhook && !this.evPresence.isOffhook);
    try {
      await this.confirmHangup('pending', async (canSend) => {
        try {
          await this.evClient.manualOutdialCancel(this.evPresence.currentCallUii);
        } catch {
          // Preview requests can reject manual cancellation; closing offhook
          // still cancels the pending attempt.
          this.logger.warn('hangup', { event: 'manualCancelFailed' });
        }
        if (!canSend() || this.evClient.appStatus !== evStatus.CONNECTED) throw new Error('Disconnected');
        const call = this.evPresence.calls[0];
        if (call?.session?.sessionId) {
          const id = call.session.sessionId;
          ended = () => !this.liveCalls.some((item) => item.uii === call.uii && item.session?.sessionId === id);
          await this.evClient.hangup({ sessionId: id });
        } else {
          await this.evClient.offhookTerm();
        }
      }, () => ended());
    } finally {
      this.evSubscription.off(EvCallbackTypes.OFFHOOK_TERM, onOffhookTerm);
    }
  }

  private get liveCalls() {
    return [...this.evPresence.calls, ...this.evPresence.otherCalls].filter(Boolean);
  }

  private confirmHangup(key: string, send: (canSend: () => boolean) => Promise<unknown>, ended: () => boolean): Promise<boolean> {
    const existing = this.hangups.get(key);
    if (existing) return existing;
    let active = true;
    let cleanup = () => {};
    const operation = new Promise<void>((resolve, reject) => {
      let sent = false;
      const check = () => {
        if (this.evClient.appStatus !== evStatus.CONNECTED) reject(new Error('Disconnected'));
        else if (sent && ended()) resolve();
      };
      const interval = setInterval(check, 250);
      const timeout = setTimeout(() => reject(new Error('Hangup not confirmed')), HANGUP_RESPONSE_TIMEOUT);
      // Install cleanup before sending: the SDK can confirm synchronously.
      cleanup = () => { active = false; clearInterval(interval); clearTimeout(timeout); };
      Promise.resolve().then(async () => {
        if (this.evClient.appStatus !== evStatus.CONNECTED) throw new Error('Disconnected');
        await send(() => active);
        sent = true;
        check();
      }).catch(reject);
    });
    const result = operation.then(() => {
      this.logger.info('hangup', { event: 'confirmed' });
      return true;
    }).catch(() => {
      this.logger.warn('hangup', { event: 'unconfirmed' });
      this.toast.danger({ message: 'Hang up could not be confirmed. The call may still be active. Check your connection and press Hang up to retry.', ttl: 0 });
      return false;
    }).finally(() => {
      cleanup();
      this.hangups.delete(key);
    });
    this.hangups.set(key, result);
    return result;
  }

  /**
   * Hold or unhold a session
   */
  @delegate('server')
  async holdSession({ sessionId, state }: EvClientHoldSessionParams): Promise<void> {
    await this.evClient.holdSession({ state, sessionId });
  }

  /**
   * Get main call by UII
   */
  getMainCall(uii: string) {
    const id = this.evClient.getMainId(uii);
    return this.evPresence.callsMapping[id];
  }

  private _changeOnHoldState(state: boolean): void {
    this.evClient.hold(state);
  }

  private async _sipToggleMute(state: boolean): Promise<void> {
    if (this.evAgentSession.isIntegratedSoftphone) {
      await this.evIntegratedSoftphone.sipToggleMute(state);
    }
  }
}

export { EvActiveCallControl };
