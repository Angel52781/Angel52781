/**
 * Simulated SOS Inventory API Client
 *
 * NOTE: This is an explicit synthetic simulator created to demonstrate idempotent
 * middleware resilience. It does NOT claim to represent certified SOS Inventory or
 * Make.com proprietary internal endpoints. In a production deployment, this client
 * is replaced by an authenticated HTTPS client targeting the customer's actual
 * sandbox account.
 */

export class AmbiguousTimeoutError extends Error {
  constructor(message, code = 'GATEWAY_TIMEOUT_504') {
    super(message);
    this.name = 'AmbiguousTimeoutError';
    this.code = code;
    this.isAmbiguousTimeout = true;
  }
}

export class SimulatedSosClient {
  constructor({ simulateTimeout = false, simulateTimeoutDidSucceedRemotely = true } = {}) {
    this.simulateTimeout = simulateTimeout;
    this.simulateTimeoutDidSucceedRemotely = simulateTimeoutDidSucceedRemotely;
    this.database = new Map(); // Keyed by correlationKey
    this.callLog = [];
  }

  /**
   * Simulate POST /workorders creation endpoint
   */
  async createWorkOrder(workOrderDraft) {
    this.callLog.push({ action: 'createWorkOrder', key: workOrderDraft.correlationKey, timestamp: new Date().toISOString() });

    if (this.database.has(workOrderDraft.correlationKey)) {
      const existing = this.database.get(workOrderDraft.correlationKey);
      const error = new Error(`HTTP 409 Conflict: Work Order already exists for correlationKey: ${workOrderDraft.correlationKey}`);
      error.statusCode = 409;
      error.existingId = existing.id;
      throw error;
    }

    if (this.simulateTimeout) {
      // Simulate timeout where either server committed before dropping connection or never received it
      if (this.simulateTimeoutDidSucceedRemotely) {
        const generatedId = `SOS-WO-${Math.floor(100000 + Math.random() * 900000)}`;
        this.database.set(workOrderDraft.correlationKey, {
          id: generatedId,
          correlationKey: workOrderDraft.correlationKey,
          data: workOrderDraft,
          remoteStatus: 'OPEN'
        });
      }
      // Turn off timeout simulation for subsequent retry calls
      this.simulateTimeout = false;
      throw new AmbiguousTimeoutError('HTTP 504 Gateway Timeout while awaiting SOS Inventory response');
    }

    const generatedId = `SOS-WO-${Math.floor(100000 + Math.random() * 900000)}`;
    const remoteRecord = {
      id: generatedId,
      correlationKey: workOrderDraft.correlationKey,
      data: workOrderDraft,
      remoteStatus: 'OPEN'
    };
    this.database.set(workOrderDraft.correlationKey, remoteRecord);

    return {
      statusCode: 201,
      workOrderId: generatedId,
      status: 'CREATED',
      correlationKey: workOrderDraft.correlationKey
    };
  }

  /**
   * Simulate GET /workorders?correlationKey=... lookup endpoint
   */
  async findByCorrelationKey(correlationKey) {
    this.callLog.push({ action: 'findByCorrelationKey', key: correlationKey, timestamp: new Date().toISOString() });
    if (this.database.has(correlationKey)) {
      const record = this.database.get(correlationKey);
      return {
        found: true,
        workOrderId: record.id,
        workOrder: record.data,
        remoteStatus: record.remoteStatus
      };
    }
    return {
      found: false,
      workOrderId: null
    };
  }
}
