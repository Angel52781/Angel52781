/**
 * SOS Inventory Work Order Integration Adapter (Synthetic Proof-of-Concept)
 *
 * Designed for Make.com / Webhook HTTP middleware reliability.
 * Implements:
 * 1. Schema & business validation (rejecting invalid IDs, non-positive quantities)
 * 2. Transformation of Sales Orders + Inventory snapshots into Work Order payloads
 * 3. Deduplication by source + batch ID + content hash
 * 4. Concurrency lock / double-update protection
 * 5. Ambiguous HTTP response handling (timeouts/504) with idempotent reconciliation
 *
 * Zero external dependencies — pure Node.js standard runtime.
 */

import crypto from 'node:crypto';

/**
 * Status constants for work order processing lifecycle
 */
export const BATCH_STATUS = {
  PENDING: 'PENDING',
  PROCESSING: 'PROCESSING',
  COMPLETED: 'COMPLETED',
  REJECTED: 'REJECTED',
  AMBIGUOUS: 'AMBIGUOUS_RECONCILIATION_REQUIRED',
  FAILED: 'FAILED'
};

/**
 * Deterministic JSON stringifier to ensure consistent payload hashes
 */
export function deterministicStringify(obj) {
  if (obj === null || typeof obj !== 'object') {
    return JSON.stringify(obj);
  }
  if (Array.isArray(obj)) {
    return `[${obj.map(deterministicStringify).join(',')}]`;
  }
  const keys = Object.keys(obj).sort();
  const entries = keys.map(k => `${JSON.stringify(k)}:${deterministicStringify(obj[k])}`);
  return `{${entries.join(',')}}`;
}

/**
 * Calculate deterministic SHA-256 hash of payload
 */
export function computePayloadHash(payload) {
  const normalized = deterministicStringify(payload);
  return crypto.createHash('sha256').update(normalized).digest('hex');
}

/**
 * Validate input sales orders and inventory payload
 * @throws {ValidationError} if payload contains invalid IDs or quantities
 */
export class ValidationError extends Error {
  constructor(message, details = []) {
    super(message);
    this.name = 'ValidationError';
    this.details = details;
  }
}

export function validateInputPayload(payload) {
  const errors = [];

  if (!payload || typeof payload !== 'object') {
    throw new ValidationError('Invalid payload: must be a non-null object', ['payload:root']);
  }

  // Source & Batch identification
  if (!payload.source || typeof payload.source !== 'string' || payload.source.trim() === '') {
    errors.push('source must be a non-empty string');
  }

  if (!payload.batchId || typeof payload.batchId !== 'string' || payload.batchId.trim() === '') {
    errors.push('batchId must be a non-empty string');
  }

  // Sales Orders validation
  if (!Array.isArray(payload.salesOrders) || payload.salesOrders.length === 0) {
    errors.push('salesOrders must be a non-empty array');
  } else {
    payload.salesOrders.forEach((so, soIndex) => {
      const prefix = `salesOrders[${soIndex}]`;
      if (!so.orderId || typeof so.orderId !== 'string' || so.orderId.trim() === '') {
        errors.push(`${prefix}.orderId must be a non-empty string`);
      }

      if (!Array.isArray(so.lines) || so.lines.length === 0) {
        errors.push(`${prefix}.lines must be a non-empty array of items`);
      } else {
        so.lines.forEach((line, lineIndex) => {
          const linePrefix = `${prefix}.lines[${lineIndex}]`;
          if (!line.sku || typeof line.sku !== 'string' || line.sku.trim() === '') {
            errors.push(`${linePrefix}.sku must be a valid non-empty string`);
          }

          if (
            typeof line.quantity !== 'number' ||
            Number.isNaN(line.quantity) ||
            !Number.isFinite(line.quantity) ||
            line.quantity <= 0
          ) {
            errors.push(`${linePrefix}.quantity must be a positive finite number (> 0). Received: ${line.quantity}`);
          }
        });
      }
    });
  }

  // Inventory snapshot validation (optional but if present must be valid)
  if (payload.inventorySnapshot) {
    if (typeof payload.inventorySnapshot !== 'object' || Array.isArray(payload.inventorySnapshot)) {
      errors.push('inventorySnapshot must be a key-value mapping of SKU to available quantity');
    } else {
      for (const [sku, qty] of Object.entries(payload.inventorySnapshot)) {
        if (typeof qty !== 'number' || Number.isNaN(qty) || !Number.isFinite(qty) || qty < 0) {
          errors.push(`inventorySnapshot.${sku} must be a non-negative finite number. Received: ${qty}`);
        }
      }
    }
  }

  if (errors.length > 0) {
    throw new ValidationError(`Payload validation failed with ${errors.length} error(s)`, errors);
  }

  return true;
}

/**
 * Transforms sales orders batch and inventory levels into a synthesized SOS Work Order draft
 */
export function transformToWorkOrder(payload) {
  validateInputPayload(payload);

  const inventory = payload.inventorySnapshot || {};
  const aggregatedDemands = new Map();

  // Aggregate quantity per SKU across all sales orders in batch
  for (const so of payload.salesOrders) {
    for (const line of so.lines) {
      const existing = aggregatedDemands.get(line.sku) || {
        sku: line.sku,
        description: line.description || `Item ${line.sku}`,
        orderedQuantity: 0,
        salesOrderRefs: new Set()
      };
      existing.orderedQuantity += line.quantity;
      existing.salesOrderRefs.add(so.orderId);
      aggregatedDemands.set(line.sku, existing);
    }
  }

  // Generate Work Order line items calculating shortage & build requirements
  const workOrderLines = [];
  for (const [sku, demand] of aggregatedDemands.entries()) {
    const available = inventory[sku] ?? 0;
    const netShortage = Math.max(0, demand.orderedQuantity - available);
    const buildQuantity = netShortage > 0 ? netShortage : demand.orderedQuantity;

    workOrderLines.push({
      itemSku: sku,
      description: demand.description,
      requiredQuantity: demand.orderedQuantity,
      onHandInventory: available,
      buildQuantity: buildQuantity,
      shortageIdentified: netShortage > 0,
      sourceOrders: Array.from(demand.salesOrderRefs).sort()
    });
  }

  // Generate deterministic correlation key for SOS remote tracking
  const correlationKey = `WO-${payload.source}-${payload.batchId}`;

  return {
    correlationKey,
    sourceBatchId: payload.batchId,
    sourceSystem: payload.source,
    createdAt: new Date().toISOString(),
    status: 'DRAFT',
    totalAssemblies: workOrderLines.reduce((acc, l) => acc + l.buildQuantity, 0),
    lineItems: workOrderLines,
    metadata: {
      generatedBy: 'OrbitalLeads-SosAdapter/v1.0.0-synthetic',
      batchHash: computePayloadHash(payload)
    }
  };
}

/**
 * Memory-backed Idempotency Ledger and Concurrency Guard
 */
export class IdempotencyStore {
  constructor() {
    this.records = new Map();
  }

  get(key) {
    return this.records.get(key) || null;
  }

  acquireLock(key, payloadHash) {
    const existing = this.records.get(key);
    if (existing) {
      if (existing.payloadHash !== payloadHash) {
        throw new Error(
          `Idempotency violation: Batch ${key} was already submitted with a different payload hash.`
        );
      }
      if (existing.status === BATCH_STATUS.PROCESSING) {
        throw new Error(`Double-update conflict: Batch ${key} is currently being processed by another worker.`);
      }
      if (existing.status === BATCH_STATUS.PENDING) {
        existing.status = BATCH_STATUS.PROCESSING;
        existing.updatedAt = new Date().toISOString();
        existing.attempts += 1;
        return { acquired: true, record: existing };
      }
      return { acquired: false, record: existing };
    }

    const record = {
      key,
      payloadHash,
      status: BATCH_STATUS.PROCESSING,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      attempts: 1,
      result: null,
      remoteRecordId: null
    };
    this.records.set(key, record);
    return { acquired: true, record };
  }

  markCompleted(key, result, remoteRecordId) {
    const record = this.records.get(key);
    if (record) {
      record.status = BATCH_STATUS.COMPLETED;
      record.result = result;
      record.remoteRecordId = remoteRecordId;
      record.updatedAt = new Date().toISOString();
    }
  }

  markAmbiguous(key, errorDetails) {
    const record = this.records.get(key);
    if (record) {
      record.status = BATCH_STATUS.AMBIGUOUS;
      record.errorDetails = errorDetails;
      record.updatedAt = new Date().toISOString();
    }
  }

  markFailed(key, errorDetails) {
    const record = this.records.get(key);
    if (record) {
      record.status = BATCH_STATUS.FAILED;
      record.errorDetails = errorDetails;
      record.updatedAt = new Date().toISOString();
    }
  }
}

/**
 * Work Order Integration Adapter Service
 */
export class WorkOrderAdapter {
  constructor({ idempotencyStore = new IdempotencyStore(), destinationClient } = {}) {
    this.store = idempotencyStore;
    this.destinationClient = destinationClient;
  }

  /**
   * Process a sales orders batch and dispatch to destination system
   */
  async processBatch(payload) {
    // 1. Validation
    validateInputPayload(payload);

    const idempotencyKey = `${payload.source}:${payload.batchId}`;
    const payloadHash = computePayloadHash(payload);

    // 2. Idempotency Check & Concurrency Lock
    const { acquired, record } = this.store.acquireLock(idempotencyKey, payloadHash);

    if (!acquired) {
      // Duplicate detection
      if (record.payloadHash !== payloadHash) {
        throw new Error(
          `Idempotency violation: Batch ${idempotencyKey} was already submitted with a different payload hash.`
        );
      }
      return {
        idempotentReplay: true,
        status: record.status,
        batchKey: idempotencyKey,
        remoteRecordId: record.remoteRecordId,
        data: record.result
      };
    }

    // 3. Transformation
    const workOrderDraft = transformToWorkOrder(payload);

    // 4. Remote Dispatch (SOS Inventory or Mock)
    try {
      if (!this.destinationClient) {
        // Standalone dry-run mode
        this.store.markCompleted(idempotencyKey, workOrderDraft, `SYNTHETIC-WO-${payload.batchId}`);
        return {
          idempotentReplay: false,
          status: BATCH_STATUS.COMPLETED,
          batchKey: idempotencyKey,
          remoteRecordId: `SYNTHETIC-WO-${payload.batchId}`,
          data: workOrderDraft
        };
      }

      const response = await this.destinationClient.createWorkOrder(workOrderDraft);

      this.store.markCompleted(idempotencyKey, workOrderDraft, response.workOrderId);
      return {
        idempotentReplay: false,
        status: BATCH_STATUS.COMPLETED,
        batchKey: idempotencyKey,
        remoteRecordId: response.workOrderId,
        data: workOrderDraft
      };
    } catch (err) {
      if (err.isAmbiguousTimeout) {
        // Network timeout / 504: The server might or might not have processed the creation.
        // DO NOT blindly retry POST. Mark as ambiguous and trigger reconciliation.
        this.store.markAmbiguous(idempotencyKey, {
          message: err.message,
          code: err.code || 'TIMEOUT_504'
        });

        return {
          idempotentReplay: false,
          status: BATCH_STATUS.AMBIGUOUS,
          batchKey: idempotencyKey,
          reconciliationRequired: true,
          error: err.message
        };
      }

      this.store.markFailed(idempotencyKey, { message: err.message });
      throw err;
    }
  }

  /**
   * Reconcile a batch trapped in AMBIGUOUS state
   */
  async reconcileBatch(source, batchId) {
    const idempotencyKey = `${source}:${batchId}`;
    const record = this.store.get(idempotencyKey);

    if (!record) {
      throw new Error(`Batch ${idempotencyKey} not found in store.`);
    }

    if (record.status !== BATCH_STATUS.AMBIGUOUS) {
      return {
        batchKey: idempotencyKey,
        status: record.status,
        remoteRecordId: record.remoteRecordId,
        message: 'Batch is not in ambiguous state.'
      };
    }

    if (!this.destinationClient) {
      throw new Error('Destination client required for reconciliation.');
    }

    // Query destination by correlation key to check if remote record actually exists
    const correlationKey = `WO-${source}-${batchId}`;
    const remoteLookup = await this.destinationClient.findByCorrelationKey(correlationKey);

    if (remoteLookup && remoteLookup.found) {
      // The previous ambiguous call succeeded on remote server!
      this.store.markCompleted(idempotencyKey, remoteLookup.workOrder, remoteLookup.workOrderId);
      return {
        batchKey: idempotencyKey,
        status: BATCH_STATUS.COMPLETED,
        reconciled: true,
        resolution: 'REMOTE_EXISTS',
        remoteRecordId: remoteLookup.workOrderId
      };
    }

    // Remote server did NOT receive or process the request. It is safe to retry now.
    record.status = BATCH_STATUS.PENDING; // release lock for re-attempt
    return {
      batchKey: idempotencyKey,
      status: BATCH_STATUS.PENDING,
      reconciled: true,
      resolution: 'SAFE_TO_RETRY',
      message: 'Verified remote entity does not exist. Safe to re-trigger batch.'
    };
  }
}
