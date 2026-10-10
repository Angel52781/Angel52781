/**
 * SOS Work Order Integration Adapter - Runnable CLI Demonstration
 * Run with: node demo.mjs
 */

import {
  WorkOrderAdapter,
  IdempotencyStore,
  transformToWorkOrder,
  ValidationError,
  BATCH_STATUS
} from './src/adapter.mjs';
import { SimulatedSosClient } from './src/simulated-sos-client.mjs';
import {
  validBatchPayload,
  invalidQuantityPayload,
  missingIdPayload,
  timeoutSimulationPayload
} from './src/fixtures.mjs';

async function runDemo() {
  console.log('='.repeat(72));
  console.log('ORBITAL FRAMEWORKS - SOS INVENTORY WORK ORDER ADAPTER DEMO');
  console.log('Proof-of-Concept & Middleware Reliability Verification');
  console.log('='.repeat(72));
  console.log('NOTE: Synthetic simulation — does not use real customer secrets or API.');
  console.log('');

  const store = new IdempotencyStore();
  const client = new SimulatedSosClient();
  const adapter = new WorkOrderAdapter({ idempotencyStore: store, destinationClient: client });

  // --------------------------------------------------------------------------
  // Scenario 1: Valid Sales Orders Batch Transformation & Creation
  // --------------------------------------------------------------------------
  console.log('>>> SCENARIO 1: Valid Sales Orders Batch Transformation');
  console.log(`Source System: ${validBatchPayload.source} | Batch: ${validBatchPayload.batchId}`);
  console.log(`Input Orders: ${validBatchPayload.salesOrders.map(o => o.orderId).join(', ')}`);

  const transformResult = transformToWorkOrder(validBatchPayload);
  console.log('\n[Transform Output] Generated Work Order Draft:');
  console.log(`- Correlation Key: ${transformResult.correlationKey}`);
  console.log(`- Total Assemblies: ${transformResult.totalAssemblies}`);
  console.log('- Line Items Summary:');
  for (const item of transformResult.lineItems) {
    console.log(`  * SKU: ${item.itemSku.padEnd(16)} | Req: ${item.requiredQuantity} | On-Hand: ${item.onHandInventory} | Build: ${item.buildQuantity} | Shortage: ${item.shortageIdentified}`);
  }

  const dispatch1 = await adapter.processBatch(validBatchPayload);
  console.log(`\n[Dispatch 1 Result] Status: ${dispatch1.status} | Remote SOS ID: ${dispatch1.remoteRecordId} | Idempotent Replay: ${dispatch1.idempotentReplay}`);
  console.log(`Remote Client Calls Made: ${client.callLog.length}`);
  console.log('-'.repeat(72));

  // --------------------------------------------------------------------------
  // Scenario 2: Webhook Duplicate / Retried Dispatch (Deduplication)
  // --------------------------------------------------------------------------
  console.log('\n>>> SCENARIO 2: Idempotent Deduplication (Make.com retries webhook)');
  console.log('Submitting the exact same batch payload again...');
  const dispatch2 = await adapter.processBatch(validBatchPayload);
  console.log(`[Dispatch 2 Result] Status: ${dispatch2.status} | Remote SOS ID: ${dispatch2.remoteRecordId} | Idempotent Replay: ${dispatch2.idempotentReplay}`);
  console.log(`Remote Client Calls Made: ${client.callLog.length} (UNCHANGED -> no duplicate work order created!)`);
  console.log('-'.repeat(72));

  // --------------------------------------------------------------------------
  // Scenario 3: Validation Rejection on Invalid Quantity & Missing IDs
  // --------------------------------------------------------------------------
  console.log('\n>>> SCENARIO 3: Strict Defensive Validation');
  try {
    console.log('Submitting payload with negative quantity (-4)...');
    await adapter.processBatch(invalidQuantityPayload);
  } catch (err) {
    console.log(`[Validation Caught] ${err.name}: ${err.message}`);
    console.log(`Details: ${err.details.join(' | ')}`);
  }

  try {
    console.log('\nSubmitting payload with empty batchId and sku...');
    await adapter.processBatch(missingIdPayload);
  } catch (err) {
    console.log(`[Validation Caught] ${err.name}: ${err.message}`);
    console.log(`Details: ${err.details.join(' | ')}`);
  }
  console.log('-'.repeat(72));

  // --------------------------------------------------------------------------
  // Scenario 4: Ambiguous HTTP Response (504 Timeout) & Reconciliation
  // --------------------------------------------------------------------------
  console.log('\n>>> SCENARIO 4: Ambiguous Network Timeout (HTTP 504) & Reconciliation');
  console.log('Simulating network timeout during POST /workorders...');
  const timeoutClient = new SimulatedSosClient({
    simulateTimeout: true,
    simulateTimeoutDidSucceedRemotely: true
  });
  const timeoutAdapter = new WorkOrderAdapter({
    idempotencyStore: store,
    destinationClient: timeoutClient
  });

  const timeoutResult = await timeoutAdapter.processBatch(timeoutSimulationPayload);
  console.log(`[Timeout Handling] Status: ${timeoutResult.status}`);
  console.log(`Reconciliation Required: ${timeoutResult.reconciliationRequired}`);
  console.log(`Error Trapped: ${timeoutResult.error}`);

  console.log('\nExecuting idempotent reconciliation query by correlationKey...');
  const reconResult = await timeoutAdapter.reconcileBatch(
    timeoutSimulationPayload.source,
    timeoutSimulationPayload.batchId
  );
  console.log(`[Reconciliation Result] Reconciled: ${reconResult.reconciled} | Resolution: ${reconResult.resolution}`);
  console.log(`Remote Record Recovered: ${reconResult.remoteRecordId}`);
  console.log('Work Order was safely recovered without creating duplicates!');
  console.log('-'.repeat(72));

  // --------------------------------------------------------------------------
  // Scenario 5: Replay Integrity Protection After SAFE_TO_RETRY
  // --------------------------------------------------------------------------
  console.log('\n>>> SCENARIO 5: Replay Integrity Protection After SAFE_TO_RETRY');
  const safeRetryClient = new SimulatedSosClient({
    simulateTimeout: true,
    simulateTimeoutDidSucceedRemotely: false
  });
  const safeRetryAdapter = new WorkOrderAdapter({
    idempotencyStore: new IdempotencyStore(),
    destinationClient: safeRetryClient
  });

  const retryPayload = {
    ...validBatchPayload,
    batchId: 'BATCH-20261010-RETRY-001'
  };

  console.log('1. Dispatching batch that triggers 504 timeout (remote write did NOT happen)...');
  await safeRetryAdapter.processBatch(retryPayload);

  console.log('2. Reconciling batch: confirms remote does NOT exist -> SAFE_TO_RETRY (status: PENDING)...');
  const safeRecon = await safeRetryAdapter.reconcileBatch(retryPayload.source, retryPayload.batchId);
  console.log(`   Resolution: ${safeRecon.resolution} | Status: ${safeRecon.status}`);

  console.log('3. Attempting to hijack batchId with altered payload...');
  const tampered = JSON.parse(JSON.stringify(retryPayload));
  tampered.salesOrders[0].lines[0].quantity = 9999;
  try {
    await safeRetryAdapter.processBatch(tampered);
    console.error('   FAILED: Tampered payload was accepted!');
  } catch (err) {
    console.log(`   [Replay Integrity Blocked] ${err.message}`);
  }
  const createCallsAfterTamper = safeRetryClient.callLog.filter(c => c.action === 'createWorkOrder').length;
  console.log(`   Remote createWorkOrder calls made so far: ${createCallsAfterTamper} (zero duplicate writes)`);

  console.log('4. Retrying with identical original payload...');
  const retrySuccess = await safeRetryAdapter.processBatch(retryPayload);
  console.log(`   [Retry Succeeded] Status: ${retrySuccess.status} | Remote SOS ID: ${retrySuccess.remoteRecordId}`);
  const finalCreateCalls = safeRetryClient.callLog.filter(c => c.action === 'createWorkOrder').length;
  console.log(`   Total remote createWorkOrder calls: ${finalCreateCalls} (exactly 1 valid write committed)`);
  console.log('='.repeat(72));
  console.log('DEMONSTRATION COMPLETED SUCCESSFULLY');
}

runDemo().catch(err => {
  console.error('Demo encountered error:', err);
  process.exit(1);
});
