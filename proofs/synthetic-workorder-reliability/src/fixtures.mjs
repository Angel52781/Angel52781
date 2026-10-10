/**
 * Synthetic Test Fixtures for SOS Work Order Integration
 *
 * All datasets are strictly synthetic and contain no real client names,
 * secrets, or production data.
 */

export const validBatchPayload = {
  source: 'shopify-webhook',
  batchId: 'BATCH-20261010-001',
  timestamp: '2026-10-10T14:30:00Z',
  salesOrders: [
    {
      orderId: 'SO-1001',
      customerRef: 'Cust-Alpha',
      lines: [
        { sku: 'SKU-WIDGET-PRO', description: 'Widget Pro Model A', quantity: 5 },
        { sku: 'SKU-GEAR-STEEL', description: 'Hardened Steel Gear', quantity: 10 }
      ]
    },
    {
      orderId: 'SO-1002',
      customerRef: 'Cust-Beta',
      lines: [
        { sku: 'SKU-WIDGET-PRO', description: 'Widget Pro Model A', quantity: 3 },
        { sku: 'SKU-BOLT-M8', description: 'M8 Metric Bolt 20mm', quantity: 50 }
      ]
    }
  ],
  inventorySnapshot: {
    'SKU-WIDGET-PRO': 2,    // 8 needed, 2 on hand -> 6 build required
    'SKU-GEAR-STEEL': 15,   // 10 needed, 15 on hand -> 0 net shortage (build 10 to allocate or satisfy)
    'SKU-BOLT-M8': 20       // 50 needed, 20 on hand -> 30 build/replenish required
  }
};

export const invalidQuantityPayload = {
  source: 'shopify-webhook',
  batchId: 'BATCH-20261010-BADQTY',
  salesOrders: [
    {
      orderId: 'SO-1003',
      lines: [
        { sku: 'SKU-WIDGET-PRO', quantity: -4 } // Invalid negative quantity!
      ]
    }
  ]
};

export const missingIdPayload = {
  source: 'shopify-webhook',
  batchId: '', // Invalid empty batchId!
  salesOrders: [
    {
      orderId: 'SO-1004',
      lines: [
        { sku: '', quantity: 10 } // Invalid empty sku!
      ]
    }
  ]
};

export const timeoutSimulationPayload = {
  source: 'shopify-webhook',
  batchId: 'BATCH-20261010-TIMEOUT-001',
  timestamp: '2026-10-10T14:35:00Z',
  salesOrders: [
    {
      orderId: 'SO-1005',
      lines: [
        { sku: 'SKU-MOTOR-DC24V', description: '24V DC Stepper Motor', quantity: 2 }
      ]
    }
  ],
  inventorySnapshot: {
    'SKU-MOTOR-DC24V': 0
  }
};
