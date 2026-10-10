# SOS Inventory Work Order Integration Adapter (Reliability Proof)

> **Orbital Frameworks Proof Asset**  
> **Status:** Executable Technical Proof (Zero External Dependencies)  
> **Target Problem:** Make.com / HTTP Webhook to SOS Inventory Work Order write-back failures, duplicate work order creation, and unhandled timeout recovery.  
> **Technical Example Reference:** [TECHNICAL_EXAMPLE.md](./TECHNICAL_EXAMPLE.md) | [PUBLIC_PROOF_DRAFT.md](./PUBLIC_PROOF_DRAFT.md) (Unpublished Draft)  
> **Contact / Lead Engineer:** Angel Reaño | [Orbital Frameworks](https://orbitalframeworks.qzz.io/) (`contact.orbitalframeworks@gmail.com`)

---

## 1. Scope & Transparency Statement (Demo vs. Production)

- **Explicit Synthetic Simulation:** This codebase is an independent proof-of-concept and middleware reliability adapter built using pure standard Node.js (`node:test`, `node:crypto`).
- **Simulated Client Boundary:** All tests and demonstrations run exclusively against `SimulatedSosClient` (a synthetic local mock). They do **not** represent validation of the actual SOS Inventory® REST API, live HTTP endpoints, or official partner certification.
- **In-Memory Storage Limitations:** The included `IdempotencyStore` stores locks and records in an in-memory `Map`. It does **not** persist across process restarts, crashes, or across multiple worker processes/containers. Real production integration requires a durable transactional backing store (e.g. PostgreSQL with transaction locks or Redis with atomic keys).
- **Separation of Demo (14 Tests) from Real Contractual Integration:** The 14 automated unit tests and interactive CLI demo establish architectural proof of correctness within a controlled, synthetic local harness. They do **not** constitute an operational integration or substitute for testing against the real SOS Inventory API under contract. Real-world contract delivery requires: (1) client-provisioned SOS sandbox/trial credentials under an explicit diagnostic contract, (2) official API schema compliance verification against live SOS endpoints, (3) durable transactional persistence (PostgreSQL / Redis) replacing the in-memory Map, and (4) operational monitoring of network boundaries and webhook retries.
- **No Absolute Zero Duplicates Guarantee in Production:** Within the lifecycle of a single Node.js process, the adapter prevents duplicate work order dispatches. However, real-world production environments involve out-of-band network retries, multi-worker clustering, and external system restarts; we do **not** claim or promise an absolute guarantee of 0 duplicates in live production without end-to-end transactional locking and native destination idempotency support.
- **No Fictitious Claims:** Orbital Frameworks does **not** claim certified partner status with SOS Inventory® or Make.com®, access to proprietary private APIs, a pre-verified sandbox, or prior client Make.com case studies.
- **No SLA Guarantees:** Orbital Frameworks does **not** offer or commit to any Service Level Agreement (SLA), guaranteed response time, or round-the-clock availability.
- **Sandbox Validation Requirement:** Live validation strictly requires testing inside the client's dedicated SOS Inventory trial or sandbox environment using client-provisioned API credentials under an authorized single-step engagement.

---

## 2. Commercial Pilot Offering

### Single-Step Diagnostic & Triage Pilot ($125–$150 USD Fixed)
* **Scope:** Triage and isolate the failing Make.com-to-SOS write-back step for a single core workflow (Sales Orders batch to Work Order creation) in the client's dedicated sandbox.
* **Deliverables:**
  1. Reproduction and diagnosis of the write-back failure inside the client's provisioned SOS trial/sandbox.
  2. Implementation of idempotent middleware adapter logic to reject mutated payloads on retried batches and handle gateway timeouts via correlation lookup.
  3. Actionable recovery runbook and triage checklist for the customer's operations team.
* **Explicit Limits:** Fixed single-step diagnostic scope. No SLA promises, no multi-worker persistence without external database, and no claims of pre-verified past client builds.
* **Timeline:** 48 to 72 business hours from provision of client sandbox access.

---

## 3. Five-Minute Quickstart

### Prerequisites
* Node.js v18.0.0 or higher (Tested on Node.js v24.18.0).
* Zero external package installations required (`npm install` is NOT needed).

### Run the Automated Unit Tests
```bash
node --test test/adapter.test.mjs
# or
npm test
```
*Expected Result:* 14 tests pass across 6 suites in < 200ms.

### Run the Interactive CLI Demonstration
```bash
node demo.mjs
# or
npm start
```
*Expected Result:* Visual step-by-step execution through valid transformation, webhook deduplication replay, validation rejection, and 504 timeout reconciliation.

---

## 4. Architecture & Reliability Invariants

```
               [ Incoming Webhook / Batch ]
               (Shopify, CRM, or Make.com)
                           │
                           ▼
             ┌───────────────────────────┐
             │ 1. Schema & Data Check    │ ──(Invalid Qty / IDs)──► [ Reject 400 ]
             └───────────────────────────┘
                           │
                           ▼
             ┌───────────────────────────┐
             │ 2. Deduplication & Lock   │ ──(Duplicate Batch)────► [ Cached Replay (No Write) ]
             └───────────────────────────┘ ──(Concurrent Active)─► [ 409 Conflict ]
                           │
                           ▼
             ┌───────────────────────────┐
             │ 3. BOM & Shortage Calc    │
             └───────────────────────────┘
                           │
                           ▼
             ┌───────────────────────────┐
             │ 4. Dispatch to Destination│
             └───────────────────────────┘
               │                       │
         (201 Created)           (504 Timeout)
               │                       │
               ▼                       ▼
      [ Work Order Saved ]   [ Ambiguous Lock State ]
                                       │
                                       ▼
                             ┌───────────────────────────┐
                             │ 5. Correlation Reconcile  │
                             └───────────────────────────┘
                               │                       │
                        (Record Exists)        (Record Missing)
                               │                       │
                               ▼                       ▼
                     [ Recover Remote ID ]     [ Safe to Retry ]
```

### Invariant Details
1. **Defensive Validation:** Rejects non-positive or malformed quantities (`<= 0`, `NaN`, strings) and empty identification keys before any outbound network call is initiated.
2. **Deterministic Idempotency Hash:** Computes a canonical SHA-256 hash over payload keys. If Make.com or an upstream system triggers a retry with the identical payload, the adapter returns the stored result without making a secondary POST call.
3. **Double-Update Lock Guard:** Rejects concurrent attempts to process the same active batch to prevent race conditions during network latency spikes.
4. **Ambiguous HTTP Response Handling (504 / ECONNRESET):** When an outbound request to create a Work Order times out, traditional automations blindly retry, frequently producing duplicate physical work orders. This adapter marks the state as `AMBIGUOUS_RECONCILIATION_REQUIRED` and uses a deterministic correlation key (`WO-{source}-{batchId}`) to query the destination before deciding whether to recover the existing record or execute a safe retry.
5. **Replay Integrity & Batch Reuse Protection (Defect Correction):** Fixes the batch reuse vulnerability where, following an ambiguous timeout and `SAFE_TO_RETRY` reconciliation, an altered or tampered payload reusing the same `source + batchId` could overwrite state. In `IdempotencyStore.acquireLock`, `payloadHash` is strictly immutable once initialized in `PENDING` state: any subsequent request with mismatched payload hash is rejected immediately (400/409 Idempotency Violation) without dispatching any remote POST call. Only the identical original payload can be safely retried following reconciliation.

---

## 5. Verifiable Inputs and Outputs

### Input Payload Example (`validBatchPayload`)
```json
{
  "source": "shopify-webhook",
  "batchId": "BATCH-20261010-001",
  "timestamp": "2026-10-10T14:30:00Z",
  "salesOrders": [
    {
      "orderId": "SO-1001",
      "lines": [
        { "sku": "SKU-WIDGET-PRO", "description": "Widget Pro Model A", "quantity": 5 },
        { "sku": "SKU-GEAR-STEEL", "description": "Hardened Steel Gear", "quantity": 10 }
      ]
    },
    {
      "orderId": "SO-1002",
      "lines": [
        { "sku": "SKU-WIDGET-PRO", "description": "Widget Pro Model A", "quantity": 3 },
        { "sku": "SKU-BOLT-M8", "description": "M8 Metric Bolt 20mm", "quantity": 50 }
      ]
    }
  ],
  "inventorySnapshot": {
    "SKU-WIDGET-PRO": 2,
    "SKU-GEAR-STEEL": 15,
    "SKU-BOLT-M8": 20
  }
}
```

### Transformed Work Order Output
```json
{
  "correlationKey": "WO-shopify-webhook-BATCH-20261010-001",
  "sourceBatchId": "BATCH-20261010-001",
  "sourceSystem": "shopify-webhook",
  "status": "DRAFT",
  "totalAssemblies": 46,
  "lineItems": [
    {
      "itemSku": "SKU-WIDGET-PRO",
      "description": "Widget Pro Model A",
      "requiredQuantity": 8,
      "onHandInventory": 2,
      "buildQuantity": 6,
      "shortageIdentified": true,
      "sourceOrders": ["SO-1001", "SO-1002"]
    },
    {
      "itemSku": "SKU-GEAR-STEEL",
      "description": "Hardened Steel Gear",
      "requiredQuantity": 10,
      "onHandInventory": 15,
      "buildQuantity": 10,
      "shortageIdentified": false,
      "sourceOrders": ["SO-1001"]
    },
    {
      "itemSku": "SKU-BOLT-M8",
      "description": "M8 Metric Bolt 20mm",
      "requiredQuantity": 50,
      "onHandInventory": 20,
      "buildQuantity": 30,
      "shortageIdentified": true,
      "sourceOrders": ["SO-1002"]
    }
  ],
  "metadata": {
    "generatedBy": "OrbitalLeads-SosAdapter/v1.0.0-synthetic",
    "batchHash": "57b686d11f7c10d32bb5e9ef74e64f89d81d222e964172f3e8035ea6f3e1cb02"
  }
}
```

---

## 6. Observed Test Output

```
▶ SOS Work Order Integration Adapter
  ▶ Validation & Payload Integrity
    ✔ accepts valid sales orders and inventory snapshot (3.54ms)
    ✔ rejects negative or zero quantities with detailed error (0.88ms)
    ✔ rejects empty batchId and empty sku (0.46ms)
    ✔ rejects null or non-object payloads (0.49ms)
  ✔ Validation & Payload Integrity (6.78ms)
  ▶ Transformation Logic
    ✔ correctly aggregates multiple sales orders and calculates build quantities (2.79ms)
  ✔ Transformation Logic (2.99ms)
  ▶ Deduplication & Idempotent Execution
    ✔ creates work order successfully on first dispatch (1.46ms)
    ✔ replaying identical batch returns cached result without duplicate write to SOS (0.80ms)
    ✔ rejects batch if identical key is submitted with modified payload (hash mismatch) (0.91ms)
  ✔ Deduplication & Idempotent Execution (3.57ms)
  ▶ Double-Update Concurrency Lock Protection
    ✔ prevents concurrent double-execution of the same in-flight batch (0.36ms)
  ✔ Double-Update Concurrency Lock Protection (0.47ms)
  ▶ Ambiguous HTTP Response & Reconciliation Recovery
    ✔ handles 504 timeout safely: flags batch for reconciliation without crashing or duplicate write (1.08ms)
    ✔ reconciles batch when timeout occurred and remote record was NOT created -> marks safe to retry (0.62ms)
    ✔ rejects tampered payload for same source+batchId after SAFE_TO_RETRY without making additional createWorkOrder call (1.17ms)
    ✔ IdempotencyStore.acquireLock preserves payloadHash and rejects modification when status is PENDING (0.37ms)
  ✔ Ambiguous HTTP Response & Reconciliation Recovery (4.03ms)
✔ SOS Work Order Integration Adapter (42.12ms)
ℹ tests 14
ℹ suites 6
ℹ pass 14
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
```
