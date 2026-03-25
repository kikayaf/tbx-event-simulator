// ---------------------------------------------------------------------------
// AT&T TBX Order Event Simulator
// ---------------------------------------------------------------------------
// Generates realistic TBX Oracle order lifecycle events and publishes them
// to RabbitMQ, mirroring the event types confirmed by Barry Hammon and the
// AT&T architecture / discovery documentation.
//
// Happy path:  BOOKED -> SHIPPED -> RECEIVED
// Branches:    PARTIALLY_RECEIVED (partial fulfilment)
//              DATE_CHANGE        (6-hour digest batch, before SHIPPED)
// Exceptions:  PAYMENT_FAILED | OUT_OF_STOCK | SHIPPING_DELAYED
//              ADDRESS_INVALID   | SYSTEM_ERROR
// ---------------------------------------------------------------------------

import "dotenv/config";
import { v4 as uuid } from "uuid";
import { connect, publishEvent, disconnect } from "./rabbitmq";
import {
  OrderStatus,
  HAPPY_PATH,
  EXCEPTION_STATUSES,
  OrderEvent,
  LineItem,
} from "./types";

// --- Configuration ---------------------------------------------------------

const ORDER_COUNT          = parseInt(process.env.SIMULATOR_ORDER_COUNT          ?? "10",   10);
const INTERVAL_MS          = parseInt(process.env.SIMULATOR_INTERVAL_MS          ?? "3000", 10);
const EXCEPTION_RATE       = parseFloat(process.env.SIMULATOR_EXCEPTION_RATE     ?? "0.10");
const DATE_CHANGE_RATE     = parseFloat(process.env.SIMULATOR_DATE_CHANGE_RATE   ?? "0.20");
const PARTIAL_RECEIVE_RATE = parseFloat(process.env.SIMULATOR_PARTIAL_RECEIVE_RATE ?? "0.15");

// --- Sample data pools -----------------------------------------------------

const CUSTOMERS = [
  { id: "CUST-1001", name: "AT&T Corporate HQ" },
  { id: "CUST-1002", name: "AT&T Southwest Region" },
  { id: "CUST-1003", name: "AT&T Northeast Division" },
  { id: "CUST-1004", name: "AT&T Mobility Services" },
  { id: "CUST-1005", name: "AT&T Enterprise Solutions" },
  { id: "CUST-1006", name: "AT&T FirstNet" },
  { id: "CUST-1007", name: "AT&T Fiber Ops" },
  { id: "CUST-1008", name: "AT&T Business Direct" },
];

const PRODUCTS: LineItem[] = [
  { sku: "CSC-C9300-48P",  description: "Cisco Catalyst 9300 48-port PoE+",   quantity: 1,  unitPrice: 8750.00  },
  { sku: "CSC-ISR4451",    description: "Cisco ISR 4451-X Router",             quantity: 1,  unitPrice: 12400.00 },
  { sku: "CSC-C9200L-24T", description: "Cisco Catalyst 9200L 24-port",        quantity: 2,  unitPrice: 3200.00  },
  { sku: "MRK-MS250-48",   description: "Meraki MS250-48 Switch",              quantity: 1,  unitPrice: 6900.00  },
  { sku: "CSC-FPR2130",    description: "Cisco Firepower 2130 NGFW",           quantity: 1,  unitPrice: 18500.00 },
  { sku: "PAN-PA-3260",    description: "Palo Alto PA-3260 Firewall",          quantity: 1,  unitPrice: 22000.00 },
  { sku: "ARB-AP-535",     description: "Aruba AP-535 Wireless Access Point",  quantity: 5,  unitPrice: 1150.00  },
  { sku: "CSC-DNA-LIC-3Y", description: "Cisco DNA Advantage 3-Year License",  quantity: 10, unitPrice: 450.00   },
  { sku: "JNP-EX4400-48T", description: "Juniper EX4400-48T Switch",           quantity: 2,  unitPrice: 5800.00  },
  { sku: "CSC-ASR1001-HX", description: "Cisco ASR 1001-HX Router",            quantity: 1,  unitPrice: 28000.00 },
];

const CARRIERS = ["FedEx", "UPS", "DHL Express", "OnTrac", "XPO Logistics"];
const REGIONS  = ["US-EAST", "US-WEST", "US-CENTRAL", "US-SOUTH"];
const SOURCE   = "TBX-Oracle";

/** Exception messages and codes keyed by exception status. */
const EXCEPTION_MESSAGES: Record<string, { detail: string; code: string }[]> = {
  [OrderStatus.PAYMENT_FAILED]: [
    { detail: "Payment gateway timeout after 30s",         code: "PAY-001" },
    { detail: "Credit limit exceeded for account",          code: "PAY-002" },
    { detail: "Invalid payment method on file",             code: "PAY-003" },
  ],
  [OrderStatus.OUT_OF_STOCK]: [
    { detail: "Inventory sync mismatch - stock unavailable", code: "INV-001" },
    { detail: "Item discontinued in TBX catalog",            code: "INV-002" },
    { detail: "Warehouse allocation failed - zero stock",    code: "INV-003" },
  ],
  [OrderStatus.SHIPPING_DELAYED]: [
    { detail: "Carrier pickup missed - rescheduled",         code: "SHP-001" },
    { detail: "Weather delay at origin hub",                 code: "SHP-002" },
    { detail: "Fulfillment center capacity exceeded",        code: "SHP-003" },
  ],
  [OrderStatus.ADDRESS_INVALID]: [
    { detail: "Delivery address failed USPS validation",     code: "ADDR-001" },
    { detail: "Missing suite/floor in address",              code: "ADDR-002" },
    { detail: "Address not serviceable by carrier",          code: "ADDR-003" },
  ],
  [OrderStatus.SYSTEM_ERROR]: [
    { detail: "Oracle ERP connectivity timeout after 30s",   code: "SYS-001" },
    { detail: "TBX gateway returned 503",                    code: "SYS-002" },
    { detail: "Oracle fulfillment API rate limit exceeded",  code: "SYS-003" },
    { detail: "RabbitMQ message broker connection lost",     code: "SYS-004" },
  ],
};

// --- Helpers ---------------------------------------------------------------

function pick<T>(arr: T[]): T {
  return arr[Math.floor(Math.random() * arr.length)];
}

function pickItems(): LineItem[] {
  const count = Math.floor(Math.random() * 3) + 1;
  const items: LineItem[] = [];
  const used = new Set<number>();
  for (let i = 0; i < count; i++) {
    let idx: number;
    do { idx = Math.floor(Math.random() * PRODUCTS.length); } while (used.has(idx));
    used.add(idx);
    const base = PRODUCTS[idx];
    items.push({ ...base, quantity: Math.floor(Math.random() * base.quantity) + 1 });
  }
  return items;
}

function totalQuantity(items: LineItem[]): number {
  return items.reduce((sum, item) => sum + item.quantity, 0);
}

function futureDate(daysAhead: number): string {
  const d = new Date();
  d.setDate(d.getDate() + daysAhead);
  return d.toISOString();
}

function generateTrackingNumber(): string {
  return `1Z${uuid().replace(/-/g, "").substring(0, 16).toUpperCase()}`;
}

function generateSerialNumber(): string {
  return `SN-${uuid().replace(/-/g, "").substring(0, 10).toUpperCase()}`;
}

function baseEvent(
  orderId: string,
  status: OrderStatus,
  customer: { id: string; name: string },
  lineItems: LineItem[]
): OrderEvent {
  return {
    eventId:      uuid(),
    orderId,
    status,
    timestamp:    new Date().toISOString(),
    source:       SOURCE,
    customerId:   customer.id,
    customerName: customer.name,
    lineItems,
    metadata: {
      simulatedAt: new Date().toISOString(),
      region:      pick(REGIONS),
    },
  };
}

/** Build a milestone event with status-specific payload fields. */
function buildMilestoneEvent(
  orderId: string,
  status: OrderStatus,
  customer: { id: string; name: string },
  lineItems: LineItem[]
): OrderEvent {
  const base = baseEvent(orderId, status, customer, lineItems);
  const qty  = totalQuantity(lineItems);

  switch (status) {
    case OrderStatus.BOOKED:
      return {
        ...base,
        poNumber:    `PO-ATT-${Math.floor(Math.random() * 900000) + 100000}`,
        quoteNumber: `QT-${Math.floor(Math.random() * 900000) + 100000}`,
        orderTotal:  Math.round(lineItems.reduce((s, i) => s + i.quantity * i.unitPrice, 0) * 100) / 100,
      };

    case OrderStatus.SHIPPED:
      return {
        ...base,
        trackingNumber:        generateTrackingNumber(),
        carrier:               pick(CARRIERS),
        serialNumbers:         lineItems.map(() => generateSerialNumber()),
        estimatedShipDate:     new Date().toISOString(),
        estimatedDeliveryDate: futureDate(pick([3, 5, 7])),
      };

    case OrderStatus.RECEIVED:
      return {
        ...base,
        receiptDate:       new Date().toISOString(),
        receivedQuantity:  qty,
        confirmedQuantity: qty,
      };

    case OrderStatus.PARTIALLY_RECEIVED:
      return {
        ...base,
        receiptDate:       new Date().toISOString(),
        confirmedQuantity: qty,
        receivedQuantity:  Math.max(1, Math.floor(qty * (Math.random() * 0.5 + 0.1))), // 10–60% of total
      };

    default:
      return base;
  }
}

/** Build a DATE_CHANGE digest batch event. */
function buildDateChangeEvent(
  orderId: string,
  customer: { id: string; name: string },
  lineItems: LineItem[]
): OrderEvent {
  return {
    ...baseEvent(orderId, OrderStatus.DATE_CHANGE, customer, lineItems),
    metadata: {
      simulatedAt: new Date().toISOString(),
      region:      pick(REGIONS),
      digestBatch: "6-hour",
    },
    previousEstimatedShipDate:    futureDate(pick([1, 2, 3])),
    newEstimatedShipDate:         futureDate(pick([5, 7, 10])),
    previousEstimatedArrivalDate: futureDate(pick([4, 5, 6])),
    newEstimatedArrivalDate:      futureDate(pick([8, 10, 14])),
  };
}

/** Build an exception event with detail and code. */
function buildExceptionEvent(
  orderId: string,
  status: OrderStatus,
  customer: { id: string; name: string },
  lineItems: LineItem[]
): OrderEvent {
  const { detail, code } = pick(EXCEPTION_MESSAGES[status]);
  return {
    ...baseEvent(orderId, status, customer, lineItems),
    exceptionDetail: detail,
    exceptionCode:   code,
  };
}

/**
 * Selects an exception status that is eligible at the given step index,
 * or returns null if no exception fires this tick.
 *
 * Step 0 (BOOKED):  PAYMENT_FAILED, ADDRESS_INVALID, OUT_OF_STOCK, SYSTEM_ERROR
 * Step 1 (SHIPPED): SHIPPING_DELAYED, SYSTEM_ERROR
 * Step 2 (RECEIVED): SYSTEM_ERROR
 */
function tryException(stepIndex: number): OrderStatus | null {
  if (Math.random() >= EXCEPTION_RATE) return null;
  const eligible: OrderStatus[] = [OrderStatus.SYSTEM_ERROR];
  if (stepIndex === 0) {
    eligible.push(OrderStatus.PAYMENT_FAILED, OrderStatus.ADDRESS_INVALID, OrderStatus.OUT_OF_STOCK);
  } else if (stepIndex === 1) {
    eligible.push(OrderStatus.SHIPPING_DELAYED);
  }
  return pick(eligible);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Simulation loop -------------------------------------------------------

interface ActiveOrder {
  orderId:   string;
  customer:  { id: string; name: string };
  lineItems: LineItem[];
  stepIndex: number;
  finished:  boolean;
}

async function runSimulation(): Promise<void> {
  console.log("==============================================");
  console.log("  AT&T TBX Order Event Simulator");
  console.log(`  Orders: ${ORDER_COUNT}  |  Interval: ${INTERVAL_MS}ms`);
  console.log(`  Exception rate: ${(EXCEPTION_RATE * 100).toFixed(0)}%  |  Date-change rate: ${(DATE_CHANGE_RATE * 100).toFixed(0)}%`);
  console.log(`  Partial-receive rate: ${(PARTIAL_RECEIVE_RATE * 100).toFixed(0)}%`);
  console.log("==============================================\n");

  await connect();

  const orders: ActiveOrder[] = Array.from({ length: ORDER_COUNT }, (_, i) => ({
    orderId:   `ORD-${Date.now()}-${String(i + 1).padStart(4, "0")}`,
    customer:  pick(CUSTOMERS),
    lineItems: pickItems(),
    stepIndex: 0,
    finished:  false,
  }));

  console.log(`[simulator] Created ${orders.length} orders. Starting event emission...\n`);

  while (orders.some((o) => !o.finished)) {
    const active = orders.filter((o) => !o.finished);
    const order  = pick(active);
    const status = HAPPY_PATH[order.stepIndex];

    // --- Exception check (terminal) ----------------------------------------
    const exception = tryException(order.stepIndex);
    if (exception) {
      const evt = buildExceptionEvent(order.orderId, exception, order.customer, order.lineItems);
      await publishEvent(evt);
      console.log(`[event] ${order.orderId}  ${exception}  "${evt.exceptionDetail}"`);
      order.finished = true;
      await sleep(INTERVAL_MS);
      continue;
    }

    // --- DATE_CHANGE injection (before SHIPPED, 6-hour digest batch) --------
    if (status === OrderStatus.SHIPPED && Math.random() < DATE_CHANGE_RATE) {
      const dateEvt = buildDateChangeEvent(order.orderId, order.customer, order.lineItems);
      await publishEvent(dateEvt);
      console.log(`[event] ${order.orderId}  DATE_CHANGE  (digest batch)`);
      await sleep(INTERVAL_MS);
    }

    // --- PARTIALLY_RECEIVED branch (instead of RECEIVED) -------------------
    if (status === OrderStatus.RECEIVED && Math.random() < PARTIAL_RECEIVE_RATE) {
      const evt = buildMilestoneEvent(order.orderId, OrderStatus.PARTIALLY_RECEIVED, order.customer, order.lineItems);
      await publishEvent(evt);
      console.log(`[event] ${order.orderId}  PARTIALLY_RECEIVED  (${evt.receivedQuantity}/${evt.confirmedQuantity} units)`);
      order.finished = true;
      await sleep(INTERVAL_MS);
      continue;
    }

    // --- Normal happy-path progression -------------------------------------
    const evt = buildMilestoneEvent(order.orderId, status, order.customer, order.lineItems);
    await publishEvent(evt);
    console.log(`[event] ${order.orderId}  ${status}`);

    order.stepIndex++;
    if (order.stepIndex >= HAPPY_PATH.length) order.finished = true;

    await sleep(INTERVAL_MS);
  }

  console.log("\n[simulator] All orders completed. Shutting down.");
  await disconnect();
}

// --- Entry -----------------------------------------------------------------

runSimulation().catch((err) => {
  console.error("[simulator] Fatal error:", err);
  process.exit(1);
});
