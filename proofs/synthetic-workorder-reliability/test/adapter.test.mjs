/**
 * Unit Tests for SOS Inventory Work Order Integration Adapter
 * Run with: node --test test/adapter.test.mjs
 */

import { test, describe, beforeEach } from 'node:test';
import assert from 'node:assert/strict';

import {
  WorkOrderAdapter,
  IdempotencyStore,
  transformToWorkOrder,
  validateInputPayload,
  ValidationError,
  BATCH_STATUS
} from '../src/adapter.mjs';

import { SimulatedSosClient } from '../src/simulated-sos-client.mjs';
import {
  validBatchPayload,
  invalidQuantityPayload,
  missingIdPayload,
  timeoutSimulationPayload
} from '../src/fixtures.mjs';

describe('SOS Work Order Integration Adapter', () => {
  let store;
  let client;
  let adapter;

  beforeEach(() => {
    store = new IdempotencyStore();
    client = new SimulatedSosClient();
    adapter = new WorkOrderAdapter({ idempotencyStore: store, destinationClient: client });
  });

  describe('Validation & Payload Integrity', () => {
    test('accepts valid sales orders and inventory snapshot', () => {
      assert.doesNotThrow(() => validateInputPayload(validBatchPayload));
    });

    test('rejects negative or zero quantities with detailed error', () => {
      assert.throws(
        () => validateInputPayload(invalidQuantityPayload),
        (err) => {
          assert(err instanceof ValidationError);
          assert(err.details.some(d => d.includes('positive finite number')));
          return true;
        }
      );
    });

    test('rejects empty batchId and empty sku', () => {
      assert.throws(
        () => validateInputPayload(missingIdPayload),
        (err) => {
          assert(err instanceof ValidationError);
          assert(err.details.some(d => d.includes('batchId')));
          assert(err.details.some(d => d.includes('sku')));
          return true;
        }
      );
    });

    test('rejects null or non-object payloads', () => {
      assert.throws(() => validateInputPayload(null), ValidationError);
      assert.throws(() => validateInputPayload('string'), ValidationError);
    });
  });

  describe('Transformation Logic', () => {
    test('correctly aggregates multiple sales orders and calculates build quantities', () => {
      const workOrder = transformToWorkOrder(validBatchPayload);

      assert.equal(workOrder.correlationKey, 'WO-shopify-webhook-BATCH-20261010-001');
      assert.equal(workOrder.sourceBatchId, 'BATCH-20261010-001');
      assert.equal(workOrder.status, 'DRAFT');

      // SKU-WIDGET-PRO appears in SO-1001 (5) and SO-1002 (3) -> total 8
      const widgetLine = workOrder.lineItems.find(l => l.itemSku === 'SKU-WIDGET-PRO');
      assert(widgetLine, 'SKU-WIDGET-PRO must exist');
      assert.equal(widgetLine.requiredQuantity, 8);
      assert.equal(widgetLine.onHandInventory, 2);
      assert.equal(widgetLine.buildQuantity, 6); // 8 - 2
      assert.equal(widgetLine.shortageIdentified, true);
      assert.deepEqual(widgetLine.sourceOrders, ['SO-1001', 'SO-1002']);

      // SKU-GEAR-STEEL appears in SO-1001 (10), onHand is 15 -> buildQuantity 10, shortage false
      const gearLine = workOrder.lineItems.find(l => l.itemSku === 'SKU-GEAR-STEEL');
      assert(gearLine, 'SKU-GEAR-STEEL must exist');
      assert.equal(gearLine.requiredQuantity, 10);
      assert.equal(gearLine.onHandInventory, 15);
      assert.equal(gearLine.buildQuantity, 10);
      assert.equal(gearLine.shortageIdentified, false);
    });
  });

  describe('Deduplication & Idempotent Execution', () => {
    test('creates work order successfully on first dispatch', async () => {
      const result = await adapter.processBatch(validBatchPayload);

      assert.equal(result.idempotentReplay, false);
      assert.equal(result.status, BATCH_STATUS.COMPLETED);
      assert.match(result.remoteRecordId, /^SOS-WO-\d+$/);
      assert.equal(client.callLog.length, 1);
    });

    test('replaying identical batch returns cached result without duplicate write to SOS', async () => {
      const firstResult = await adapter.processBatch(validBatchPayload);
      const secondResult = await adapter.processBatch(validBatchPayload);

      assert.equal(secondResult.idempotentReplay, true);
      assert.equal(secondResult.status, BATCH_STATUS.COMPLETED);
      assert.equal(secondResult.remoteRecordId, firstResult.remoteRecordId);
      // Destination client must only have been invoked ONCE
      assert.equal(client.callLog.length, 1);
    });

    test('rejects batch if identical key is submitted with modified payload (hash mismatch)', async () => {
      await adapter.processBatch(validBatchPayload);

      const modifiedPayload = JSON.parse(JSON.stringify(validBatchPayload));
      modifiedPayload.salesOrders[0].lines[0].quantity = 999; // tampered payload

      await assert.rejects(
        async () => adapter.processBatch(modifiedPayload),
        /Idempotency violation: Batch .* was already submitted with a different payload hash/
      );
    });
  });

  describe('Double-Update Concurrency Lock Protection', () => {
    test('prevents concurrent double-execution of the same in-flight batch', () => {
      const key = 'shopify-webhook:BATCH-CONCURRENT-001';
      const hash = 'hash-abc-123';

      const lock1 = store.acquireLock(key, hash);
      assert.equal(lock1.acquired, true);

      // Attempting to acquire lock while still PROCESSING must throw
      assert.throws(
        () => store.acquireLock(key, hash),
        /Double-update conflict/
      );
    });

    test('concurrent processBatch dispatches guarantee zero duplicate work orders in destination', async () => {
      const slowClient = new SimulatedSosClient();
      const origCreate = slowClient.createWorkOrder.bind(slowClient);
      slowClient.createWorkOrder = async (draft) => {
        await new Promise(resolve => setTimeout(resolve, 20));
        return origCreate(draft);
      };

      const concurrentAdapter = new WorkOrderAdapter({
        idempotencyStore: store,
        destinationClient: slowClient
      });

      // Dispatch 3 concurrent requests with the identical batch payload
      const [res1, res2, res3] = await Promise.allSettled([
        concurrentAdapter.processBatch(validBatchPayload),
        concurrentAdapter.processBatch(validBatchPayload),
        concurrentAdapter.processBatch(validBatchPayload)
      ]);

      // Exactly one must acquire lock and succeed; other two must reject with double-update conflict
      const fulfilled = [res1, res2, res3].filter(r => r.status === 'fulfilled');
      const rejected = [res1, res2, res3].filter(r => r.status === 'rejected');

      assert.equal(fulfilled.length, 1);
      assert.equal(fulfilled[0].value.status, BATCH_STATUS.COMPLETED);
      assert.equal(rejected.length, 2);
      for (const rej of rejected) {
        assert.match(rej.reason.message, /Double-update conflict/);
      }

      // Exactly 1 work order created in destination, zero duplicates
      const createCalls = slowClient.callLog.filter(c => c.action === 'createWorkOrder');
      assert.equal(createCalls.length, 1);
      assert.equal(slowClient.database.size, 1);
    });
  });

  describe('Ambiguous HTTP Response & Reconciliation Recovery', () => {
    test('handles 504 timeout safely: flags batch for reconciliation without crashing or duplicate write', async () => {
      // Configure client to simulate timeout where server DID commit remotely
      const timeoutClient = new SimulatedSosClient({
        simulateTimeout: true,
        simulateTimeoutDidSucceedRemotely: true
      });
      const timeoutAdapter = new WorkOrderAdapter({
        idempotencyStore: store,
        destinationClient: timeoutClient
      });

      // 1. Process batch - triggers 504 Gateway Timeout
      const result = await timeoutAdapter.processBatch(timeoutSimulationPayload);

      assert.equal(result.status, BATCH_STATUS.AMBIGUOUS);
      assert.equal(result.reconciliationRequired, true);

      // 2. Immediate replay is blocked / protected while in ambiguous state
      // Run reconciliation query against remote
      const reconResult = await timeoutAdapter.reconcileBatch(
        timeoutSimulationPayload.source,
        timeoutSimulationPayload.batchId
      );

      assert.equal(reconResult.reconciled, true);
      assert.equal(reconResult.resolution, 'REMOTE_EXISTS');
      assert.match(reconResult.remoteRecordId, /^SOS-WO-\d+$/);

      // Verify that batch is now completed with recovered ID
      const record = store.get(`${timeoutSimulationPayload.source}:${timeoutSimulationPayload.batchId}`);
      assert.equal(record.status, BATCH_STATUS.COMPLETED);
      assert.equal(record.remoteRecordId, reconResult.remoteRecordId);
    });

    test('reconciles batch when timeout occurred and remote record was NOT created -> marks safe to retry', async () => {
      // Configure client to simulate timeout where server did NOT commit remotely
      const timeoutClient = new SimulatedSosClient({
        simulateTimeout: true,
        simulateTimeoutDidSucceedRemotely: false
      });
      const timeoutAdapter = new WorkOrderAdapter({
        idempotencyStore: store,
        destinationClient: timeoutClient
      });

      // 1. Process batch - triggers 504 Gateway Timeout
      const result = await timeoutAdapter.processBatch(timeoutSimulationPayload);
      assert.equal(result.status, BATCH_STATUS.AMBIGUOUS);

      // 2. Reconcile
      const reconResult = await timeoutAdapter.reconcileBatch(
        timeoutSimulationPayload.source,
        timeoutSimulationPayload.batchId
      );

      assert.equal(reconResult.reconciled, true);
      assert.equal(reconResult.resolution, 'SAFE_TO_RETRY');
      assert.equal(reconResult.status, BATCH_STATUS.PENDING);

      // 3. Retry dispatch now succeeds cleanly
      const retryResult = await timeoutAdapter.processBatch(timeoutSimulationPayload);
      assert.equal(retryResult.status, BATCH_STATUS.COMPLETED);
      assert.match(retryResult.remoteRecordId, /^SOS-WO-\d+$/);
    });

    test('rejects tampered payload for same source+batchId after SAFE_TO_RETRY without making additional createWorkOrder call', async () => {
      const timeoutClient = new SimulatedSosClient({
        simulateTimeout: true,
        simulateTimeoutDidSucceedRemotely: false
      });
      const timeoutAdapter = new WorkOrderAdapter({
        idempotencyStore: store,
        destinationClient: timeoutClient
      });

      // 1. Initial attempt fails with timeout
      await timeoutAdapter.processBatch(timeoutSimulationPayload);
      assert.equal(timeoutClient.callLog.length, 1);

      // 2. Reconcile confirms remote entity does not exist -> SAFE_TO_RETRY / PENDING
      const reconResult = await timeoutAdapter.reconcileBatch(
        timeoutSimulationPayload.source,
        timeoutSimulationPayload.batchId
      );
      assert.equal(reconResult.resolution, 'SAFE_TO_RETRY');
      assert.equal(reconResult.status, BATCH_STATUS.PENDING);

      // 3. Attempt to submit modified payload with identical source + batchId
      const tamperedPayload = JSON.parse(JSON.stringify(timeoutSimulationPayload));
      tamperedPayload.salesOrders[0].lines[0].quantity = 9999;

      // MUST reject before any remote dispatch
      await assert.rejects(
        async () => timeoutAdapter.processBatch(tamperedPayload),
        /Idempotency violation: Batch .* was already submitted with a different payload hash/
      );

      // Verification: destinationClient.createWorkOrder was NOT called again
      const createCallsAfterTamper = timeoutClient.callLog.filter(c => c.action === 'createWorkOrder');
      assert.equal(createCallsAfterTamper.length, 1);

      // 4. Legitimate retry with original payload succeeds and makes exactly 1 additional createWorkOrder call
      const legitimateRetry = await timeoutAdapter.processBatch(timeoutSimulationPayload);
      assert.equal(legitimateRetry.status, BATCH_STATUS.COMPLETED);
      const createCallsAfterRetry = timeoutClient.callLog.filter(c => c.action === 'createWorkOrder');
      assert.equal(createCallsAfterRetry.length, 2);
    });

    test('IdempotencyStore.acquireLock preserves payloadHash and rejects modification when status is PENDING', () => {
      const key = 'test-source:batch-123';
      const initialHash = 'hash-initial';
      const alteredHash = 'hash-altered';

      // Lock initially acquired
      const initialLock = store.acquireLock(key, initialHash);
      assert.equal(initialLock.acquired, true);

      // Transition to PENDING (e.g. after SAFE_TO_RETRY reconciliation)
      initialLock.record.status = BATCH_STATUS.PENDING;

      // Attempting acquireLock with altered hash MUST throw Idempotency violation
      assert.throws(
        () => store.acquireLock(key, alteredHash),
        /Idempotency violation/
      );

      // Stored payloadHash must remain intact and immutable
      const stored = store.get(key);
      assert.equal(stored.payloadHash, initialHash);
      assert.equal(stored.status, BATCH_STATUS.PENDING);

      // Attempting acquireLock with original hash succeeds
      const retryLock = store.acquireLock(key, initialHash);
      assert.equal(retryLock.acquired, true);
      assert.equal(retryLock.record.payloadHash, initialHash);
      assert.equal(retryLock.record.status, BATCH_STATUS.PROCESSING);
    });
  });
});
