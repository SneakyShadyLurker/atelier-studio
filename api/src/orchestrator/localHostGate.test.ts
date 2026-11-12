import { afterEach, describe, expect, test } from 'bun:test';
import { PrivacyRequestError } from '../providers/comfyui/privacy';
import { isHostLevelProbeCode } from '../providers/types';
import {
  configureLocalHostGate, isHostTransportError, localHostUnavailable, noteLocalGenerationFailure,
  noteLocalHostAvailability, resetLocalHostGateForTests,
} from './localHostGate';
import { configureUpstreamGate, isPaused, resetUpstreamGateForTests } from './upstreamGate';

function refused(): Error {
  return Object.assign(new TypeError('Unable to connect. Is the computer able to access the url?'), { code: 'ECONNREFUSED' });
}

function wireGate(kicks: string[]): void {
  configureUpstreamGate({
    kickPool: (pool) => { kicks.push(pool); },
    failQueued: () => undefined,
    halfOpenAfterMs: 60_000,
    maxPauseMs: 600_000,
    threshold: 5,
  });
}

afterEach(() => {
  resetLocalHostGateForTests();
  resetUpstreamGateForTests();
});

describe('isHostLevelProbeCode', () => {
  test('transport, readiness and unreadable inventory are host-level; missing row assets are not', () => {
    for (const code of ['privacy_transport', 'privacy_not_ready', 'host_transport', 'inventory_transport', 'inventory_invalid'] as const) {
      expect(isHostLevelProbeCode(code)).toBe(true);
    }
    for (const code of ['missing_file', 'missing_clip_type', 'missing_node_class', 'privacy_row_incompatible'] as const) {
      expect(isHostLevelProbeCode(code)).toBe(false);
    }
    expect(isHostLevelProbeCode(undefined)).toBe(false);
  });
});

describe('isHostTransportError', () => {
  test('connection-level failures and gateway statuses prove the host is unreachable', () => {
    expect(isHostTransportError(refused())).toBe(true);
    expect(isHostTransportError(Object.assign(new Error('reset'), { code: 'ECONNRESET' }))).toBe(true);
    expect(isHostTransportError(new PrivacyRequestError(503))).toBe(true);
    expect(isHostTransportError(new PrivacyRequestError(502))).toBe(true);
  });

  test('job-level failures, client errors and timeouts do not', () => {
    expect(isHostTransportError('test terminal')).toBe(false);
    expect(isHostTransportError(new Error('comfyui returned non-PNG bytes'))).toBe(false);
    expect(isHostTransportError(new PrivacyRequestError(400))).toBe(false);
    expect(isHostTransportError(new PrivacyRequestError(429, 1_000, true))).toBe(false);
    expect(isHostTransportError(new DOMException('The operation timed out.', 'TimeoutError'))).toBe(false);
    expect(isHostTransportError(null)).toBe(false);
  });
});

describe('local host gate', () => {
  test('a transport failure pauses the local pool, requests a probe, and a healthy probe resumes it', async () => {
    const kicks: string[] = [];
    wireGate(kicks);
    const probed: string[] = [];
    let finishProbe: () => void = () => undefined;
    configureLocalHostGate({
      hostUnavailable: () => false,
      probeNow: (modelId) => {
        probed.push(modelId);
        return new Promise<undefined>((resolve) => { finishProbe = () => { resolve(undefined); }; });
      },
    });

    noteLocalGenerationFailure('moss-base', refused());

    expect(isPaused('local')).toBe(true);
    expect(isPaused('shared')).toBe(false);
    expect(probed).toEqual(['moss-base']);
    finishProbe();
    await Promise.resolve();
    await Promise.resolve();
    expect(isPaused('local')).toBe(false);
    expect(kicks).toEqual(['local']);
  });

  test('a probe that finds the host down at host level keeps the pool paused', async () => {
    wireGate([]);
    configureLocalHostGate({ hostUnavailable: () => true, probeNow: () => Promise.resolve(undefined) });

    noteLocalGenerationFailure('moss-base', refused());
    await Promise.resolve();
    await Promise.resolve();

    expect(isPaused('local')).toBe(true);
    expect(localHostUnavailable('moss-base')).toBe(true);
  });

  test('a non-transport failure neither pauses nor probes', () => {
    wireGate([]);
    const probed: string[] = [];
    configureLocalHostGate({
      hostUnavailable: () => false,
      probeNow: (modelId) => { probed.push(modelId); return Promise.resolve(undefined); },
    });

    noteLocalGenerationFailure('moss-base', new Error('comfyui invalid memory output batch'));

    expect(isPaused('local')).toBe(false);
    expect(probed).toEqual([]);
  });

  test('host availability transitions open and close only the local pool', () => {
    const kicks: string[] = [];
    wireGate(kicks);
    noteLocalHostAvailability(false);
    expect(isPaused('local')).toBe(true);
    expect(isPaused('shared')).toBe(false);
    noteLocalHostAvailability(true);
    expect(isPaused('local')).toBe(false);
    expect(kicks).toEqual(['local']);
  });

  test('an unwired gate never reports the host unavailable', () => {
    expect(localHostUnavailable('moss-base')).toBe(false);
    noteLocalGenerationFailure('moss-base', refused());
    expect(isPaused('local')).toBe(false);
  });
});
