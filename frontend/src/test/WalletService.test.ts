/**
 * WalletService.test.ts — Issue #85 / #1539
 *
 * Unit tests for the wallet connection and signing service layer extracted in
 * issue #22.  The suite covers:
 *
 * 1. freighterAdapter  — isInstalled, connect, getAddress, getNetwork, watch
 * 2. WalletSigningProvider — signTransaction, signMessage
 * 3. transactionBuilderService — simulateTransaction, template CRUD, share codes
 * 4. WalletConnectionProvider — connect, disconnect, switchWallet, switchAccount,
 *    refreshWallets, session restore
 *
 * All @stellar/stellar-sdk and wallet-kit calls are replaced with vi.fn() stubs
 * so no network traffic ever occurs.
 *
 * Target: 90%+ branch/line coverage on
 *   - src/wallet/freighterAdapter.ts
 *   - src/wallet/WalletSigningProvider.tsx
 *   - src/wallet/WalletConnectionProvider.tsx
 *   - src/services/transactionBuilderService.ts
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { render, act, renderHook } from '@testing-library/react';
import React from 'react';

// ─── Use vi.hoisted for variables used in vi.mock factories ──────────────────
const {
  mockFreighterIsConnected,
  mockFreighterIsAllowed,
  mockFreighterSetAllowed,
  mockFreighterGetAddress,
  mockFreighterGetNetwork,
  mockFreighterWatchWalletChanges,
  mockStellarWalletsKit,
  mockSorobanRpcServer,
  mockOperationPayment,
  mockOperationManageData,
  mockOperationManageSellOffer,
} = vi.hoisted(() => {
  const mockSorobanRpcServer = {
    getAccount: vi.fn().mockResolvedValue({
      accountId: () => 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN',
      sequenceNumber: () => '0',
      incrementSequenceNumber: vi.fn(),
    }),
    simulateTransaction: vi.fn().mockResolvedValue({
      result: null,
      minResourceFee: '100',
      footprint: null,
    }),
  };

  const mockStellarWalletsKit = {
    init: vi.fn(),
    setWallet: vi.fn(),
    getAddress: vi.fn().mockResolvedValue({ address: 'GFAKE_ADDRESS' }),
    getNetwork: vi.fn().mockResolvedValue({ networkPassphrase: 'Test SDF Network ; September 2015' }),
    disconnect: vi.fn().mockResolvedValue(undefined),
    signTransaction: vi.fn().mockResolvedValue({ signedTxXdr: 'SIGNED_XDR==' }),
    signMessage: vi.fn().mockResolvedValue({ signedMessage: 'signed_msg' }),
    refreshSupportedWallets: vi.fn().mockResolvedValue([]),
  };

  return {
    mockFreighterIsConnected: vi.fn(),
    mockFreighterIsAllowed: vi.fn(),
    mockFreighterSetAllowed: vi.fn(),
    mockFreighterGetAddress: vi.fn(),
    mockFreighterGetNetwork: vi.fn(),
    mockFreighterWatchWalletChanges: vi.fn(),
    mockStellarWalletsKit,
    mockSorobanRpcServer,
    mockOperationPayment: vi.fn().mockReturnValue({ type: 'payment' }),
    mockOperationManageData: vi.fn().mockReturnValue({ type: 'manageData' }),
    mockOperationManageSellOffer: vi.fn().mockReturnValue({ type: 'manageSellOffer' }),
  };
});

// ─── Mock @stellar/freighter-api ──────────────────────────────────────────────
vi.mock('@stellar/freighter-api', () => ({
  isConnected: mockFreighterIsConnected,
  isAllowed: mockFreighterIsAllowed,
  setAllowed: mockFreighterSetAllowed,
  getAddress: mockFreighterGetAddress,
  getNetwork: mockFreighterGetNetwork,
  WatchWalletChanges: mockFreighterWatchWalletChanges,
}));

// ─── Mock @stellar/stellar-sdk (with full shape the service expects) ─────────
vi.mock('@stellar/stellar-sdk', () => {
  const FAKE_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

  class FakeAsset {
    constructor(
      public readonly code: string = 'XLM',
      public readonly issuer?: string,
    ) {}
    static native() { return new FakeAsset('XLM'); }
    isNative() { return this.code === 'XLM' && !this.issuer; }
  }

  class FakeContract {
    constructor(public readonly contractId: string) {}
    call(_method: string, ..._args: unknown[]) { return { type: 'invokeHostFunction' }; }
  }

  class FakeTransactionBuilder {
    constructor(_src: unknown, _opts?: unknown) {}
    addOperation(_op: unknown): this { return this; }
    setTimeout(_s: number): this { return this; }
    build() {
      return {
        toXDR: () => 'AAAAAAA==',
        toEnvelope: () => ({ toXDR: () => 'AAAAAAA==' }),
      };
    }
  }

  const isSimulationErrorMock = vi.fn((r: unknown) => {
    return !!r && typeof r === 'object' && 'error' in (r as object) &&
      (r as Record<string, unknown>)['error'] !== undefined;
  });
  const isSimulationSuccessMock = vi.fn((r: unknown) => {
    return !!r && typeof r === 'object' && !('error' in (r as object));
  });

  return {
    FAKE_ACCOUNT_ID,
    Networks: {
      PUBLIC: 'Public Global Stellar Network ; September 2015',
      TESTNET: 'Test SDF Network ; September 2015',
    },
    BASE_FEE: '100',
    Asset: FakeAsset,
    Contract: FakeContract,
    TransactionBuilder: FakeTransactionBuilder,
    Keypair: {
      random: vi.fn(),
      fromSecret: vi.fn(),
      fromPublicKey: vi.fn(),
    },
    Operation: {
      payment: mockOperationPayment,
      manageData: mockOperationManageData,
      manageSellOffer: mockOperationManageSellOffer,
      changeTrust: vi.fn().mockReturnValue({ type: 'changeTrust' }),
      setOptions: vi.fn().mockReturnValue({ type: 'setOptions' }),
    },
    SorobanRpc: {
      Server: vi.fn().mockImplementation(() => mockSorobanRpcServer),
      Api: {
        isSimulationError: isSimulationErrorMock,
        isSimulationSuccess: isSimulationSuccessMock,
      },
    },
    nativeToScVal: vi.fn().mockReturnValue({}),
    scValToNative: vi.fn().mockReturnValue(null),
    xdr: {
      ScVal: {
        scvVoid: vi.fn().mockReturnValue({}),
      },
    },
  };
});

// ─── Mock @creit.tech/stellar-wallets-kit ─────────────────────────────────────
vi.mock('@creit.tech/stellar-wallets-kit', () => ({
  StellarWalletsKit: mockStellarWalletsKit,
  Networks: {
    TESTNET: 'Test SDF Network ; September 2015',
    PUBLIC: 'Public Global Stellar Network ; September 2015',
  },
}));

vi.mock('@creit.tech/stellar-wallets-kit/modules/freighter', () => ({
  FreighterModule: vi.fn(() => ({})),
  FREIGHTER_ID: 'freighter',
}));

vi.mock('@creit.tech/stellar-wallets-kit/modules/albedo', () => ({
  AlbedoModule: vi.fn(() => ({})),
}));

vi.mock('@creit.tech/stellar-wallets-kit/modules/lobstr', () => ({
  LobstrModule: vi.fn(() => ({})),
}));

// ─── Imports (after mocks are declared) ──────────────────────────────────────
import { freighterAdapter } from '../wallet/freighterAdapter';
import {
  simulateTransaction,
  createStep,
  generateId,
  saveTemplate,
  loadTemplates,
  deleteTemplate,
  generateShareCode,
  decodeShareCode,
} from '../services/transactionBuilderService';
import type { TransactionBuilderStep, TransactionTemplate } from '../types/transactionBuilder';
import {
  WalletConnectionProvider,
  useWalletConnection,
} from '../wallet/WalletConnectionProvider';
import {
  WalletSigningProvider,
  useWalletSigning,
} from '../wallet/WalletSigningProvider';

// We need to get at the SorobanRpc mock to configure it per test
import * as StellarSdk from '@stellar/stellar-sdk';

const FAKE_ACCOUNT_ID = 'GAAZI4TCR3TY5OJHCTJC2A4QSY6CJWJH5IAJTGKIN2ER7LBNVKOCCWN';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function setupConnectedFreighter(address = 'GABC', network = 'TESTNET') {
  mockFreighterIsConnected.mockResolvedValue({ data: true });
  mockFreighterIsAllowed.mockResolvedValue({ data: true });
  mockFreighterGetAddress.mockResolvedValue({ data: address });
  mockFreighterGetNetwork.mockResolvedValue({ data: network });
}

function makeStep(
  type: TransactionBuilderStep['type'] = 'payment',
  overrides: Partial<TransactionBuilderStep> = {},
): TransactionBuilderStep {
  return {
    id: 'step-1',
    type,
    label: 'Test Step',
    params: {},
    enabled: true,
    ...overrides,
  };
}

function makeTemplate(overrides: Partial<TransactionTemplate> = {}): TransactionTemplate {
  return {
    id: `tpl-${Math.random().toString(36).slice(2)}`,
    name: 'My Template',
    description: 'desc',
    steps: [makeStep()],
    createdAt: 1000,
    updatedAt: 1000,
    ...overrides,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// 1.  freighterAdapter — isInstalled
// ═════════════════════════════════════════════════════════════════════════════

describe('freighterAdapter — isInstalled', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns true when freighter is connected', async () => {
    mockFreighterIsConnected.mockResolvedValue({ data: true });
    expect(await freighterAdapter.isInstalled()).toBe(true);
  });

  it('returns false when isConnected returns { data: false }', async () => {
    mockFreighterIsConnected.mockResolvedValue({ data: false });
    expect(await freighterAdapter.isInstalled()).toBe(false);
  });

  it('returns false when isConnected returns an error payload', async () => {
    mockFreighterIsConnected.mockResolvedValue({ error: 'not installed' });
    expect(await freighterAdapter.isInstalled()).toBe(false);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 2.  freighterAdapter — connect
// ═════════════════════════════════════════════════════════════════════════════

describe('freighterAdapter — connect', () => {
  beforeEach(() => vi.clearAllMocks());

  it('returns address and network when already allowed', async () => {
    setupConnectedFreighter('GABC', 'TESTNET');
    const result = await freighterAdapter.connect();
    expect(result.address).toBe('GABC');
    expect(result.network).toBe('TESTNET');
  });

  it('calls setAllowed when wallet is not yet allowed', async () => {
    mockFreighterIsConnected.mockResolvedValue({ data: true });
    mockFreighterIsAllowed.mockResolvedValue({ data: false });
    mockFreighterSetAllowed.mockResolvedValue({ data: true });
    mockFreighterGetAddress.mockResolvedValue({ data: 'GXYZ' });
    mockFreighterGetNetwork.mockResolvedValue({ data: 'PUBLIC' });

    const result = await freighterAdapter.connect();
    expect(mockFreighterSetAllowed).toHaveBeenCalledTimes(1);
    expect(result.address).toBe('GXYZ');
    expect(result.network).toBe('PUBLIC');
  });

  it('throws when freighter is not installed', async () => {
    mockFreighterIsConnected.mockResolvedValue({ data: false });
    await expect(freighterAdapter.connect()).rejects.toThrow(
      'Freighter wallet is not installed.',
    );
  });

  it('throws when getAddress returns an error payload', async () => {
    mockFreighterIsConnected.mockResolvedValue({ data: true });
    mockFreighterIsAllowed.mockResolvedValue({ data: true });
    mockFreighterGetAddress.mockResolvedValue({ error: 'user rejected' });
    await expect(freighterAdapter.connect()).rejects.toThrow('user rejected');
  });

  it('throws when getNetwork returns an error payload', async () => {
    mockFreighterIsConnected.mockResolvedValue({ data: true });
    mockFreighterIsAllowed.mockResolvedValue({ data: true });
    mockFreighterGetAddress.mockResolvedValue({ data: 'GABC' });
    mockFreighterGetNetwork.mockResolvedValue({ error: 'network unavailable' });
    await expect(freighterAdapter.connect()).rejects.toThrow('network unavailable');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 3.  freighterAdapter — getAddress / getNetwork
// ═════════════════════════════════════════════════════════════════════════════

describe('freighterAdapter — getAddress / getNetwork', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    setupConnectedFreighter('GABC', 'TESTNET');
  });

  it('getAddress returns the account public key', async () => {
    expect(await freighterAdapter.getAddress()).toBe('GABC');
  });

  it('getNetwork returns the network name', async () => {
    expect(await freighterAdapter.getNetwork()).toBe('TESTNET');
  });

  it('getAddress throws when freighter returns an error', async () => {
    mockFreighterGetAddress.mockResolvedValue({ error: 'locked' });
    await expect(freighterAdapter.getAddress()).rejects.toThrow('locked');
  });

  it('getNetwork throws when freighter returns an error', async () => {
    mockFreighterGetNetwork.mockResolvedValue({ error: 'unavailable' });
    await expect(freighterAdapter.getNetwork()).rejects.toThrow('unavailable');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4a. freighterAdapter — canUseFreighter "not a function" path
// ═════════════════════════════════════════════════════════════════════════════

describe('freighterAdapter — canUseFreighter (isConnected not a function)', () => {
  it('returns false when isConnected is not a function', async () => {
    // Replace the module export with a non-function value so getFunction returns undefined
    const freighterApiModule = await import('@stellar/freighter-api') as Record<string, unknown>;
    const origValue = freighterApiModule['isConnected'];
    freighterApiModule['isConnected'] = null; // not a function
    expect(await freighterAdapter.isInstalled()).toBe(false);
    freighterApiModule['isConnected'] = origValue;
  });
});

// ─── Additional edge-case tests for helper functions ─────────────────────────

describe('freighterAdapter — getError / getResultData edge cases', () => {
  // These edge cases are exercised via the public API by providing unusual return values

  it('getAddress handles null result (getResultData fallback)', async () => {
    // When result is null, getResultData returns the result as-is (null)
    mockFreighterGetAddress.mockResolvedValue(null);
    // callFreighter<string>("getAddress") will return null as string
    const result = await freighterAdapter.getAddress().catch((e) => e.message);
    // Should not throw since null has no .error property
    expect(result).toBeNull();
  });

  it('getAddress handles non-object result (plain string)', async () => {
    // When isConnected returns a plain boolean (not wrapped in {data: ...})
    // getResultData returns it directly
    mockFreighterGetAddress.mockResolvedValue('GDIRECT_RESULT');
    const result = await freighterAdapter.getAddress();
    expect(result).toBe('GDIRECT_RESULT');
  });

  it('callFreighter throws when the function is not on the API', async () => {
    // isAllowed is not in the mock, so this tests the "function not found" throw
    const freighterApiModule = await import('@stellar/freighter-api') as Record<string, unknown>;
    const origValue = freighterApiModule['isAllowed'];
    freighterApiModule['isAllowed'] = null; // not a function

    // Connect calls isAllowed → should throw "isAllowed is not available..."
    mockFreighterIsConnected.mockResolvedValue({ data: true });
    await expect(freighterAdapter.connect()).rejects.toThrow('isAllowed is not available');

    freighterApiModule['isAllowed'] = origValue;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4b. freighterAdapter — watch "no WatchWalletChanges" path
// ═════════════════════════════════════════════════════════════════════════════

describe('freighterAdapter — watch (WatchWalletChanges not a function)', () => {
  it('returns a no-op when WatchWalletChanges is not a function', async () => {
    const freighterApiModule = await import('@stellar/freighter-api') as Record<string, unknown>;
    const origValue = freighterApiModule['WatchWalletChanges'];
    freighterApiModule['WatchWalletChanges'] = null; // not a function
    const stop = freighterAdapter.watch(vi.fn());
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
    freighterApiModule['WatchWalletChanges'] = origValue;
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 4.  freighterAdapter — watch
// ═════════════════════════════════════════════════════════════════════════════

describe('freighterAdapter — watch', () => {
  beforeEach(() => vi.clearAllMocks());

  it('calls WatchWalletChanges and returns the unsubscribe function directly', () => {
    const unsubscribe = vi.fn();
    mockFreighterWatchWalletChanges.mockReturnValue(unsubscribe);

    const onChange = vi.fn();
    const stop = freighterAdapter.watch(onChange);
    expect(mockFreighterWatchWalletChanges).toHaveBeenCalled();
    expect(typeof stop).toBe('function');
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('handles watcher objects with an unsubscribe method', () => {
    const unsubscribe = vi.fn();
    mockFreighterWatchWalletChanges.mockReturnValue({ unsubscribe });
    const stop = freighterAdapter.watch(vi.fn());
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('handles watcher objects with a stop method', () => {
    const stopFn = vi.fn();
    mockFreighterWatchWalletChanges.mockReturnValue({ stop: stopFn });
    const stop = freighterAdapter.watch(vi.fn());
    stop();
    expect(stopFn).toHaveBeenCalledTimes(1);
  });

  it('handles watcher objects with a removeListener method', () => {
    const removeListener = vi.fn();
    mockFreighterWatchWalletChanges.mockReturnValue({ removeListener });
    const stop = freighterAdapter.watch(vi.fn());
    stop();
    expect(removeListener).toHaveBeenCalledTimes(1);
  });

  it('returns a no-op () => undefined for unknown watcher objects', () => {
    mockFreighterWatchWalletChanges.mockReturnValue({ somethingElse: true });
    const stop = freighterAdapter.watch(vi.fn());
    expect(typeof stop).toBe('function');
    expect(() => stop()).not.toThrow();
  });

  it('falls back to second arg order when first call throws', () => {
    const unsubscribe = vi.fn();
    mockFreighterWatchWalletChanges
      .mockImplementationOnce(() => { throw new Error('wrong arg order'); })
      .mockReturnValue(unsubscribe);
    const onChange = vi.fn();
    const stop = freighterAdapter.watch(onChange);
    stop();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 5.  generateId / createStep
// ═════════════════════════════════════════════════════════════════════════════

describe('generateId', () => {
  it('returns a non-empty string', () => {
    expect(typeof generateId()).toBe('string');
    expect(generateId().length).toBeGreaterThan(0);
  });

  it('returns unique values on successive calls', () => {
    const ids = new Set(Array.from({ length: 100 }, generateId));
    expect(ids.size).toBe(100);
  });
});

describe('createStep', () => {
  it('creates a payment step with enabled=true and empty params', () => {
    const step = createStep('payment', 0);
    expect(step.type).toBe('payment');
    expect(step.enabled).toBe(true);
    expect(step.label).toContain('Payment');
    expect(step.params).toEqual({});
    expect(typeof step.id).toBe('string');
  });

  it('creates a contract_call step with correct label', () => {
    const step = createStep('contract_call', 1);
    expect(step.type).toBe('contract_call');
    expect(step.label).toContain('Contract Call');
  });

  it('creates a create_group step', () => {
    expect(createStep('create_group', 0).label).toContain('Create Group');
  });

  it('creates a join_group step', () => {
    expect(createStep('join_group', 0).label).toContain('Join Group');
  });

  it('creates a contribute step', () => {
    expect(createStep('contribute', 0).label).toContain('Contribute');
  });

  it('creates an execute_payout step', () => {
    expect(createStep('execute_payout', 0).label).toContain('Execute Payout');
  });

  it('creates a manage_data step', () => {
    expect(createStep('manage_data', 0).label).toContain('Manage Data');
  });

  it('creates a manage_sell_offer step', () => {
    expect(createStep('manage_sell_offer', 0).label).toContain('Sell Offer');
  });

  it('includes the 1-based index in the label', () => {
    const step = createStep('payment', 2);
    expect(step.label).toContain('#3');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 6.  simulateTransaction
// ═════════════════════════════════════════════════════════════════════════════

describe('simulateTransaction', () => {
  // Get the SorobanRpc mock from the mocked module
  const SorobanRpc = (StellarSdk as unknown as Record<string, unknown>).SorobanRpc as {
    Server: ReturnType<typeof vi.fn>;
    Api: {
      isSimulationError: ReturnType<typeof vi.fn>;
      isSimulationSuccess: ReturnType<typeof vi.fn>;
    };
  };

  beforeEach(() => {
    // Reset the specific mocks we need — don't clearAllMocks as that would
    // remove mockImplementations from vi.mock factories
    mockSorobanRpcServer.getAccount.mockReset();
    mockSorobanRpcServer.simulateTransaction.mockReset();
    mockOperationPayment.mockReset();
    mockOperationManageData.mockReset();
    mockOperationManageSellOffer.mockReset();

    // Restore default implementations
    mockSorobanRpcServer.getAccount.mockResolvedValue({
      accountId: () => FAKE_ACCOUNT_ID,
      sequenceNumber: () => '0',
      incrementSequenceNumber: vi.fn(),
    });
    mockSorobanRpcServer.simulateTransaction.mockResolvedValue({
      result: null,
      minResourceFee: '100',
      footprint: null,
    });
    mockOperationPayment.mockReturnValue({ type: 'payment' });
    mockOperationManageData.mockReturnValue({ type: 'manageData' });
    mockOperationManageSellOffer.mockReturnValue({ type: 'manageSellOffer' });

    SorobanRpc.Server.mockImplementation(() => mockSorobanRpcServer);
    SorobanRpc.Api.isSimulationError.mockReturnValue(false);
    SorobanRpc.Api.isSimulationSuccess.mockReturnValue(true);
  });

  it('returns failure when the step list is empty', async () => {
    const result = await simulateTransaction([]);
    expect(result.success).toBe(false);
    expect(result.warnings[0]).toMatch(/no enabled operations/i);
  });

  it('returns failure when no steps are enabled', async () => {
    const result = await simulateTransaction([makeStep('payment', { enabled: false })]);
    expect(result.success).toBe(false);
    expect(result.warnings).toContain('No enabled operations to simulate');
  });

  it('builds a payment operation and returns success', async () => {
    const step = makeStep('payment', {
      params: { destination: FAKE_ACCOUNT_ID, amount: '10' },
    });
    const result = await simulateTransaction([step]);
    expect(mockOperationPayment).toHaveBeenCalledWith(
      expect.objectContaining({ destination: FAKE_ACCOUNT_ID, amount: '10' }),
    );
    expect(result.success).toBe(true);
    expect(result.operationsCount).toBe(1);
  });

  it('builds a payment operation with default params when missing', async () => {
    const step = makeStep('payment', { params: {} });
    const result = await simulateTransaction([step]);
    expect(mockOperationPayment).toHaveBeenCalledWith(
      expect.objectContaining({ destination: FAKE_ACCOUNT_ID, amount: '0' }),
    );
    expect(result.success).toBe(true);
  });

  it('builds a manage_data operation', async () => {
    const step = makeStep('manage_data', {
      params: { key: 'my_key', value: 'my_value' },
    });
    const result = await simulateTransaction([step]);
    expect(mockOperationManageData).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'my_key', value: 'my_value' }),
    );
    expect(result.success).toBe(true);
  });

  it('builds a manage_data operation with null value when value param absent', async () => {
    const step = makeStep('manage_data', { params: { key: 'k' } });
    await simulateTransaction([step]);
    expect(mockOperationManageData).toHaveBeenCalledWith(
      expect.objectContaining({ name: 'k', value: null }),
    );
  });

  it('builds a manage_sell_offer operation', async () => {
    const step = makeStep('manage_sell_offer', {
      params: { selling: 'XLM', buying: 'USDC', amount: '100', price: '1.5' },
    });
    const result = await simulateTransaction([step]);
    expect(mockOperationManageSellOffer).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('builds a manage_sell_offer with default asset params when omitted', async () => {
    const step = makeStep('manage_sell_offer', { params: {} });
    const result = await simulateTransaction([step]);
    expect(mockOperationManageSellOffer).toHaveBeenCalled();
    expect(result.success).toBe(true);
  });

  it('builds a contract_call operation when contractId is provided', async () => {
    const step = makeStep('contract_call', {
      params: { contractId: 'CABC123', method: 'contribute' },
    });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(true);
    expect(result.operationsCount).toBe(1);
  });

  it('skips contract_call when contractId is absent → no ops → failure', async () => {
    const step = makeStep('contract_call', { params: {} });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(false);
    expect(result.warnings).toContain('No enabled operations to simulate');
  });

  it('handles create_group / join_group / contribute / execute_payout like contract_call', async () => {
    for (const type of ['create_group', 'join_group', 'contribute', 'execute_payout'] as const) {
      mockSorobanRpcServer.getAccount.mockResolvedValue({
        accountId: () => FAKE_ACCOUNT_ID,
        sequenceNumber: () => '0',
        incrementSequenceNumber: vi.fn(),
      });
      mockSorobanRpcServer.simulateTransaction.mockResolvedValue({
        result: null,
        minResourceFee: '100',
        footprint: null,
      });
      SorobanRpc.Api.isSimulationError.mockReturnValue(false);
      SorobanRpc.Api.isSimulationSuccess.mockReturnValue(true);

      const step = makeStep(type, { params: { contractId: 'CTEST', method: 'do_thing' } });
      const result = await simulateTransaction([step]);
      expect(result.operationsCount).toBe(1);
      expect(result.success).toBe(true);
    }
  });

  it('uses the DUMMY_ADDRESS when sourceAddress is not provided', async () => {
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    await simulateTransaction([step]);
    expect(mockSorobanRpcServer.getAccount).toHaveBeenCalledWith(FAKE_ACCOUNT_ID);
  });

  it('uses the provided sourceAddress', async () => {
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    await simulateTransaction([step], 'GCUSTOM_ADDRESS');
    expect(mockSorobanRpcServer.getAccount).toHaveBeenCalledWith('GCUSTOM_ADDRESS');
  });

  it('falls back to dummy account object when getAccount rejects', async () => {
    mockSorobanRpcServer.getAccount.mockRejectedValue(new Error('account not found'));
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.operationsCount).toBe(1);
  });

  it('returns simulation error with Error message when isSimulationError is true', async () => {
    SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSorobanRpcServer.simulateTransaction.mockResolvedValue({
      error: new Error('sim error from RPC'),
    });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/sim error from RPC/i);
  });

  it('returns simulation error string when error field is a plain string', async () => {
    SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSorobanRpcServer.simulateTransaction.mockResolvedValue({
      error: 'plain string error',
    });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(false);
    expect(result.error).toBe('plain string error');
  });

  it('uses "Simulation failed" when error field is undefined', async () => {
    SorobanRpc.Api.isSimulationError.mockReturnValue(true);
    mockSorobanRpcServer.simulateTransaction.mockResolvedValue({ error: undefined });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Simulation failed');
  });

  it('includes high-fee warning when fee exceeds 0.1 XLM', async () => {
    mockSorobanRpcServer.simulateTransaction.mockResolvedValue({
      minResourceFee: String(0.5 * 1e7), // 0.5 XLM in stroops
      footprint: null,
    });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('High estimated fee'))).toBe(true);
  });

  it('includes many-operations warning when more than 5 steps', async () => {
    const steps = Array.from({ length: 6 }, () =>
      makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } }),
    );
    const result = await simulateTransaction(steps);
    expect(result.success).toBe(true);
    expect(result.warnings.some((w) => w.includes('6 operations'))).toBe(true);
  });

  it('computes footprint bytes from readWrite and readOnly data', async () => {
    mockSorobanRpcServer.simulateTransaction.mockResolvedValue({
      minResourceFee: '100',
      footprint: {
        readWrite: () => ({ length: () => 2 }),
        readOnly: () => ({ length: () => 3 }),
      },
    });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.footprintBytes).toBe((2 + 3) * 64);
  });

  it('catches unexpected errors and returns failure result', async () => {
    SorobanRpc.Server.mockImplementation(() => {
      throw new Error('network failure');
    });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(false);
    expect(result.error).toBe('network failure');
  });

  it('returns "Unknown simulation error" for non-Error throws', async () => {
    SorobanRpc.Server.mockImplementation(() => {
      // eslint-disable-next-line @typescript-eslint/no-throw-literal
      throw 'string-based error';
    });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(false);
    expect(result.error).toBe('Unknown simulation error');
  });

  it('uses fallback fee of 0 when minResourceFee is absent from simulation result', async () => {
    mockSorobanRpcServer.simulateTransaction.mockResolvedValue({
      // minResourceFee absent — triggers the ternary fallback to 0
      result: null,
      footprint: null,
    });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.success).toBe(true);
    // feeInXlm = max(0.00001*1, 0) = 0.00001
    expect(result.feeInXlm).toBeCloseTo(0.00001);
  });

  it('skips footprint computation when readWrite is absent', async () => {
    mockSorobanRpcServer.simulateTransaction.mockResolvedValue({
      minResourceFee: '100',
      footprint: {
        // readWrite absent, only readOnly
        readOnly: () => ({ length: () => 4 }),
      },
    });
    const step = makeStep('payment', { params: { destination: FAKE_ACCOUNT_ID, amount: '1' } });
    const result = await simulateTransaction([step]);
    expect(result.footprintBytes).toBe(4 * 64);
  });

  it('skips disabled steps in a mixed list', async () => {
    const enabledStep = makeStep('payment', {
      params: { destination: FAKE_ACCOUNT_ID, amount: '5' },
    });
    const disabledStep = makeStep('payment', {
      enabled: false,
      params: { destination: FAKE_ACCOUNT_ID, amount: '99' },
    });
    const result = await simulateTransaction([enabledStep, disabledStep]);
    expect(result.operationsCount).toBe(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 7.  saveTemplate / loadTemplates / deleteTemplate
// ═════════════════════════════════════════════════════════════════════════════

describe('saveTemplate / loadTemplates / deleteTemplate', () => {
  beforeEach(() => {
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('saves a new template and loads it back', () => {
    const tpl = makeTemplate({ name: 'Alpha' });
    saveTemplate(tpl);
    const loaded = loadTemplates();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('Alpha');
  });

  it('updates an existing template by id without adding a duplicate', () => {
    const tpl = makeTemplate({ name: 'Original' });
    saveTemplate(tpl);
    // Get the actual persisted id (saveTemplate assigns a new id for new entries)
    const persisted = loadTemplates()[0];
    saveTemplate({ ...persisted, name: 'Updated' });
    const loaded = loadTemplates();
    expect(loaded).toHaveLength(1);
    expect(loaded[0].name).toBe('Updated');
  });

  it('saves multiple distinct templates', () => {
    saveTemplate(makeTemplate({ name: 'A' }));
    saveTemplate(makeTemplate({ name: 'B' }));
    expect(loadTemplates()).toHaveLength(2);
  });

  it('loadTemplates returns empty array when storage is empty', () => {
    expect(loadTemplates()).toEqual([]);
  });

  it('loadTemplates returns empty array when storage contains corrupt JSON', () => {
    localStorage.setItem('stellar-save:tx-templates', 'NOT_JSON{{');
    expect(loadTemplates()).toEqual([]);
  });

  it('deleteTemplate removes the matching template', () => {
    saveTemplate(makeTemplate({ name: 'Keep' }));
    const first = loadTemplates()[0];
    saveTemplate(makeTemplate({ name: 'Remove' }));
    const second = loadTemplates().find((t) => t.name === 'Remove')!;
    deleteTemplate(second.id);
    const remaining = loadTemplates();
    expect(remaining).toHaveLength(1);
    expect(remaining[0].id).toBe(first.id);
  });

  it('deleteTemplate is a no-op when id is not found', () => {
    saveTemplate(makeTemplate({ name: 'Keep' }));
    deleteTemplate('nonexistent-id');
    expect(loadTemplates()).toHaveLength(1);
  });

  it('deleteTemplate is a no-op when storage is empty', () => {
    expect(() => deleteTemplate('anything')).not.toThrow();
    expect(loadTemplates()).toEqual([]);
  });

  it('saveTemplate assigns id, createdAt, and updatedAt on new entry', () => {
    const tpl = makeTemplate();
    saveTemplate(tpl);
    const loaded = loadTemplates();
    expect(typeof loaded[0].id).toBe('string');
    expect(typeof loaded[0].createdAt).toBe('number');
    expect(typeof loaded[0].updatedAt).toBe('number');
  });

  it('saveTemplate updates updatedAt but preserves createdAt on update', () => {
    const tpl = makeTemplate();
    saveTemplate(tpl);
    const persisted = loadTemplates()[0];
    const originalCreatedAt = persisted.createdAt;

    vi.useFakeTimers();
    vi.setSystemTime(new Date(originalCreatedAt + 5000));
    saveTemplate({ ...persisted, name: 'Renamed' });
    vi.useRealTimers();

    const updated = loadTemplates()[0];
    expect(updated.createdAt).toBe(originalCreatedAt);
    expect(updated.updatedAt).toBeGreaterThan(originalCreatedAt);
  });

  it('saveTemplate survives localStorage.setItem throwing (catch path)', () => {
    const spy = vi.spyOn(Storage.prototype, 'setItem').mockImplementationOnce(() => {
      throw new Error('quota exceeded');
    });
    expect(() => saveTemplate(makeTemplate())).not.toThrow();
    spy.mockRestore();
  });

  it('deleteTemplate survives localStorage errors (catch path)', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementationOnce(() => {
      throw new Error('storage error');
    });
    expect(() => deleteTemplate('any-id')).not.toThrow();
    spy.mockRestore();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 8.  generateShareCode / decodeShareCode
// ═════════════════════════════════════════════════════════════════════════════

describe('generateShareCode / decodeShareCode', () => {
  it('generates a non-empty base64 string', () => {
    const code = generateShareCode(makeTemplate());
    expect(typeof code).toBe('string');
    expect(code.length).toBeGreaterThan(0);
  });

  it('round-trips name and description through the share code', () => {
    const tpl = makeTemplate({ name: 'My ROSCA Plan', description: 'monthly' });
    const code = generateShareCode(tpl);
    const decoded = decodeShareCode(code);
    expect(decoded?.name).toBe('My ROSCA Plan');
    expect(decoded?.description).toBe('monthly');
  });

  it('decoded steps contain type and enabled fields', () => {
    const tpl = makeTemplate({
      steps: [makeStep('payment', { params: { destination: 'GABC', amount: '5' } })],
    });
    const code = generateShareCode(tpl);
    const decoded = decodeShareCode(code);
    expect(decoded?.steps[0].type).toBe('payment');
    expect(decoded?.steps[0].enabled).toBe(true);
  });

  it('decoded steps each have a fresh unique id different from original', () => {
    const tpl = makeTemplate();
    const code = generateShareCode(tpl);
    const decoded = decodeShareCode(code);
    expect(typeof decoded?.steps[0].id).toBe('string');
    expect(decoded?.steps[0].id).not.toBe(tpl.steps[0].id);
  });

  it('returns null for an invalid base64 string', () => {
    expect(decodeShareCode('not_valid_base64!!!')).toBeNull();
  });

  it('returns null for valid base64 that is not JSON', () => {
    const garbage = btoa('not json at all');
    expect(decodeShareCode(garbage)).toBeNull();
  });

  it('falls back to "Shared Template" name when n field is absent', () => {
    const code = btoa(JSON.stringify({ d: 'desc', s: [] }));
    const decoded = decodeShareCode(code);
    expect(decoded?.name).toBe('Shared Template');
  });

  it('falls back to empty description when d field is absent', () => {
    const code = btoa(JSON.stringify({ n: 'Test', s: [] }));
    const decoded = decodeShareCode(code);
    expect(decoded?.description).toBe('');
  });

  it('handles empty steps array gracefully', () => {
    const tpl = makeTemplate({ steps: [] });
    const code = generateShareCode(tpl);
    const decoded = decodeShareCode(code);
    expect(decoded?.steps).toEqual([]);
  });

  it('generates share code that omits step ids from the encoded payload', () => {
    const tpl = makeTemplate({ steps: [makeStep('payment', { id: 'ORIGINAL_ID' })] });
    const code = generateShareCode(tpl);
    const raw = JSON.parse(atob(code));
    expect(JSON.stringify(raw.s)).not.toContain('ORIGINAL_ID');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 9.  WalletSigningProvider — signTransaction and signMessage
// ═════════════════════════════════════════════════════════════════════════════

describe('WalletSigningProvider — signTransaction', () => {
  beforeEach(() => {
    mockStellarWalletsKit.signTransaction.mockReset();
    mockStellarWalletsKit.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED_XDR==' });
  });

  function renderSigningProvider() {
    let signingCtx: ReturnType<typeof useWalletSigning> | undefined;
    const TestConsumer: React.FC = () => {
      signingCtx = useWalletSigning();
      return null;
    };
    render(
      React.createElement(WalletSigningProvider, null,
        React.createElement(TestConsumer),
      ),
    );
    return () => signingCtx!;
  }

  it('returns signed XDR from StellarWalletsKit', async () => {
    mockStellarWalletsKit.signTransaction.mockResolvedValue({ signedTxXdr: 'MY_SIGNED_XDR==' });
    const getCtx = renderSigningProvider();
    const result = await getCtx().signTransaction('UNSIGNED_XDR==', {
      networkPassphrase: 'Test SDF Network ; September 2015',
    });
    expect(result).toBe('MY_SIGNED_XDR==');
    expect(mockStellarWalletsKit.signTransaction).toHaveBeenCalledWith(
      'UNSIGNED_XDR==',
      { networkPassphrase: 'Test SDF Network ; September 2015' },
    );
  });

  it('propagates errors thrown by StellarWalletsKit.signTransaction', async () => {
    mockStellarWalletsKit.signTransaction.mockRejectedValue(new Error('user rejected'));
    const getCtx = renderSigningProvider();
    await expect(getCtx().signTransaction('XDR==', {})).rejects.toThrow('user rejected');
  });

  it('accepts address and networkPassphrase options', async () => {
    mockStellarWalletsKit.signTransaction.mockResolvedValue({ signedTxXdr: 'SIGNED==' });
    const getCtx = renderSigningProvider();
    const opts = {
      networkPassphrase: 'Public Global Stellar Network ; September 2015',
      address: 'GPUBLIC',
    };
    await getCtx().signTransaction('XDR==', opts);
    expect(mockStellarWalletsKit.signTransaction).toHaveBeenCalledWith('XDR==', opts);
  });
});

describe('WalletSigningProvider — signMessage', () => {
  beforeEach(() => {
    mockStellarWalletsKit.signMessage.mockReset();
    mockStellarWalletsKit.signMessage.mockResolvedValue({ signedMessage: 'signed_msg' });
  });

  function renderSigningProvider() {
    let signingCtx: ReturnType<typeof useWalletSigning> | undefined;
    const TestConsumer: React.FC = () => {
      signingCtx = useWalletSigning();
      return null;
    };
    render(
      React.createElement(WalletSigningProvider, null,
        React.createElement(TestConsumer),
      ),
    );
    return () => signingCtx!;
  }

  it('returns signedMessage when the kit supports it', async () => {
    mockStellarWalletsKit.signMessage.mockResolvedValue({ signedMessage: 'base64sig==' });
    const getCtx = renderSigningProvider();
    const result = await getCtx().signMessage('hello', { address: 'GABC' });
    expect(result).toBe('base64sig==');
  });

  it('falls back to signature field when signedMessage is absent', async () => {
    mockStellarWalletsKit.signMessage.mockResolvedValue({ signature: 'raw_sig' });
    const getCtx = renderSigningProvider();
    const result = await getCtx().signMessage('msg');
    expect(result).toBe('raw_sig');
  });

  it('returns empty string when both signedMessage and signature are absent', async () => {
    mockStellarWalletsKit.signMessage.mockResolvedValue({});
    const getCtx = renderSigningProvider();
    const result = await getCtx().signMessage('msg');
    expect(result).toBe('');
  });

  it('throws when kit does not expose signMessage function', async () => {
    const orig = mockStellarWalletsKit.signMessage;
    // @ts-expect-error testing undefined path
    mockStellarWalletsKit.signMessage = undefined;
    const getCtx = renderSigningProvider();
    await expect(getCtx().signMessage('hello')).rejects.toThrow(
      'Message signing is not supported by the current wallet.',
    );
    mockStellarWalletsKit.signMessage = orig;
  });
});

describe('useWalletSigning — throws when used outside provider', () => {
  it('throws when called outside WalletSigningProvider', () => {
    expect(() => {
      renderHook(() => useWalletSigning());
    }).toThrow('useWalletSigning must be used within WalletSigningProvider.');
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// 10.  WalletConnectionProvider
// ═════════════════════════════════════════════════════════════════════════════

describe('WalletConnectionProvider — initial state', () => {
  beforeEach(() => {
    mockStellarWalletsKit.getAddress.mockReset();
    mockStellarWalletsKit.getNetwork.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockReset();
    mockStellarWalletsKit.getAddress.mockResolvedValue({ address: 'GFAKE_ADDRESS' });
    mockStellarWalletsKit.getNetwork.mockResolvedValue({ networkPassphrase: 'Test SDF Network ; September 2015' });
    mockStellarWalletsKit.refreshSupportedWallets.mockResolvedValue([]);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('renders children and exposes idle status by default', async () => {
    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    expect(ctx!.status).toBe('idle');
    expect(ctx!.activeAddress).toBeNull();
    expect(ctx!.network).toBeNull();
    expect(ctx!.error).toBeNull();
    expect(ctx!.connectedAccounts).toEqual([]);
  });

  it('restores persisted session from localStorage on mount', async () => {
    localStorage.setItem('swk_address', 'GSAVED_ADDR');
    localStorage.setItem('swk_wallet', 'freighter');

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    expect(ctx!.status).toBe('connected');
    expect(ctx!.activeAddress).toBe('GSAVED_ADDR');
  });

  it('exposes wallets from initial state', async () => {
    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    // Initial state has 3 wallets (Freighter, Albedo, Lobstr) with installed: false
    // After refreshWallets() called in useEffect, it may change
    expect(Array.isArray(ctx!.wallets)).toBe(true);
  });
});

describe('WalletConnectionProvider — connect', () => {
  beforeEach(() => {
    mockStellarWalletsKit.getAddress.mockReset();
    mockStellarWalletsKit.getNetwork.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockResolvedValue([]);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('sets status to connected and stores address on successful connect', async () => {
    mockStellarWalletsKit.getAddress.mockResolvedValue({ address: 'GCONNECTED' });
    mockStellarWalletsKit.getNetwork.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.connect();
    });

    expect(ctx!.status).toBe('connected');
    expect(ctx!.activeAddress).toBe('GCONNECTED');
    expect(ctx!.network).toBe('Test SDF Network ; September 2015');
    expect(localStorage.getItem('swk_address')).toBe('GCONNECTED');
  });

  it('sets status to error when connect throws an Error', async () => {
    mockStellarWalletsKit.getAddress.mockRejectedValue(new Error('connection refused'));
    mockStellarWalletsKit.getNetwork.mockResolvedValue({ networkPassphrase: 'test' });

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.connect();
    });

    expect(ctx!.status).toBe('error');
    expect(ctx!.error).toBe('connection refused');
  });

  it('sets generic error message when a non-Error is thrown', async () => {
    mockStellarWalletsKit.getAddress.mockRejectedValue('some string error');
    mockStellarWalletsKit.getNetwork.mockResolvedValue({ networkPassphrase: 'test' });

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.connect();
    });

    expect(ctx!.status).toBe('error');
    expect(ctx!.error).toBe('Failed to connect');
  });
});

describe('WalletConnectionProvider — disconnect', () => {
  beforeEach(() => {
    mockStellarWalletsKit.getAddress.mockReset();
    mockStellarWalletsKit.getNetwork.mockReset();
    mockStellarWalletsKit.disconnect.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockReset();
    mockStellarWalletsKit.disconnect.mockResolvedValue(undefined);
    mockStellarWalletsKit.refreshSupportedWallets.mockResolvedValue([]);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('resets state and clears localStorage on disconnect', async () => {
    mockStellarWalletsKit.getAddress.mockResolvedValue({ address: 'GADDR' });
    mockStellarWalletsKit.getNetwork.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.connect();
    });

    expect(ctx!.status).toBe('connected');

    await act(async () => {
      await ctx!.disconnect();
    });

    expect(ctx!.status).toBe('idle');
    expect(ctx!.activeAddress).toBeNull();
    expect(ctx!.network).toBeNull();
    expect(localStorage.getItem('swk_address')).toBeNull();
    expect(localStorage.getItem('swk_wallet')).toBeNull();
  });
});

describe('WalletConnectionProvider — switchWallet', () => {
  beforeEach(() => {
    mockStellarWalletsKit.getAddress.mockReset();
    mockStellarWalletsKit.getNetwork.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockResolvedValue([]);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('switches wallet and updates connected address', async () => {
    mockStellarWalletsKit.getAddress.mockResolvedValue({ address: 'GNEW_WALLET' });
    mockStellarWalletsKit.getNetwork.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.switchWallet('albedo');
    });

    expect(mockStellarWalletsKit.setWallet).toHaveBeenCalledWith('albedo');
    expect(ctx!.activeAddress).toBe('GNEW_WALLET');
    expect(ctx!.status).toBe('connected');
    expect(localStorage.getItem('swk_wallet')).toBe('albedo');
  });

  it('sets error status when switchWallet fails', async () => {
    mockStellarWalletsKit.getAddress.mockRejectedValue(new Error('wallet unavailable'));
    mockStellarWalletsKit.getNetwork.mockResolvedValue({ networkPassphrase: 'test' });

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.switchWallet('lobstr');
    });

    expect(ctx!.status).toBe('error');
    expect(ctx!.error).toBe('wallet unavailable');
  });

  it('sets generic error when switchWallet throws non-Error', async () => {
    mockStellarWalletsKit.getAddress.mockRejectedValue('oops');
    mockStellarWalletsKit.getNetwork.mockResolvedValue({ networkPassphrase: 'test' });

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.switchWallet('lobstr');
    });

    expect(ctx!.status).toBe('error');
    expect(ctx!.error).toBe('Failed to connect');
  });
});

describe('WalletConnectionProvider — switchAccount', () => {
  beforeEach(() => {
    mockStellarWalletsKit.refreshSupportedWallets.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockResolvedValue([]);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('updates active address and persists to localStorage', async () => {
    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    act(() => {
      ctx!.switchAccount('GNEW_ADDRESS');
    });

    expect(ctx!.activeAddress).toBe('GNEW_ADDRESS');
    expect(localStorage.getItem('swk_address')).toBe('GNEW_ADDRESS');
  });
});

describe('WalletConnectionProvider — refreshWallets', () => {
  beforeEach(() => {
    mockStellarWalletsKit.refreshSupportedWallets.mockReset();
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('updates wallet list from refreshSupportedWallets', async () => {
    mockStellarWalletsKit.refreshSupportedWallets.mockResolvedValue([
      { id: 'freighter', name: 'Freighter', isAvailable: true },
      { id: 'albedo', name: 'Albedo', isAvailable: false },
    ]);

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.refreshWallets();
    });

    const freighterWallet = ctx!.wallets.find((w) => w.id === 'freighter');
    expect(freighterWallet?.installed).toBe(true);
    const albedoWallet = ctx!.wallets.find((w) => w.id === 'albedo');
    expect(albedoWallet?.installed).toBe(false);
  });
});

describe('WalletConnectionProvider — connectedAccounts derived state', () => {
  beforeEach(() => {
    mockStellarWalletsKit.getAddress.mockReset();
    mockStellarWalletsKit.getNetwork.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockReset();
    mockStellarWalletsKit.refreshSupportedWallets.mockResolvedValue([]);
    localStorage.clear();
  });

  afterEach(() => {
    localStorage.clear();
  });

  it('connectedAccounts contains the active address when connected', async () => {
    mockStellarWalletsKit.getAddress.mockResolvedValue({ address: 'GACTIVE' });
    mockStellarWalletsKit.getNetwork.mockResolvedValue({
      networkPassphrase: 'Test SDF Network ; September 2015',
    });

    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    await act(async () => {
      await ctx!.connect();
    });

    expect(ctx!.connectedAccounts).toEqual(['GACTIVE']);
  });

  it('connectedAccounts is empty when not connected', async () => {
    let ctx: ReturnType<typeof useWalletConnection> | undefined;
    const Consumer: React.FC = () => {
      ctx = useWalletConnection();
      return null;
    };

    await act(async () => {
      render(
        React.createElement(WalletConnectionProvider, null,
          React.createElement(Consumer),
        ),
      );
    });

    expect(ctx!.connectedAccounts).toEqual([]);
  });
});

describe('useWalletConnection — throws when used outside provider', () => {
  it('throws when called outside WalletConnectionProvider', () => {
    expect(() => {
      renderHook(() => useWalletConnection());
    }).toThrow('useWalletConnection must be used within WalletConnectionProvider.');
  });
});
