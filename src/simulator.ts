// ---------------------------------------------------------------------------
// AT&T TBX Order Event Simulator
// ---------------------------------------------------------------------------
// Generates realistic order lifecycle events and publishes them to RabbitMQ.
// Each order progresses through the TBX happy path with configurable delays
// and a random chance of error or cancellation at each stage.
// ---------------------------------------------------------------------------

import "dotenv/config";
import { v4 as uuid } from "uuid";
import { connect, publishEvent, disconnect } from "./rabbitmq";
import {
  OrderStatus,
  HAPPY_PATH,
  OrderEvent,
  LineItem,
} from "./types";

// --- Configuration ---------------------------------------------------------

const ORDER_COUNT    = parseInt(process.env.SIMULATOR_ORDER_COUNT ?? "10", 10);
const INTERVAL_MS    = parseInt(process.env.SIMULATOR_INTERVAL_MS ?? "3000", 10);
const ERROR_RATE     = parseFloat(process.env.SIMULATOR_ERROR_RATE ?? "0.08");
const CANCEL_RATE    = parseFloat(process.env.SIMULATOR_CANCEL_RATE ?? "0.05");

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
  { sku: "CSC-C9300-48P",  description: "Cisco Catalyst 9300 48-port PoE+",  quantity: 1, unitPrice: 8750.00 },
  { sku: "CSC-ISR4451",    description: "Cisco ISR 4451-X Router",            quantity: 1, unitPrice: 12400.00 },
  { sku: "CSC-C9200L-24T", description: "Cisco Catalyst 9200L 24-port",      quantity: 2, unitPrice: 3200.00 },
  { sku: "MRK-MS250-48",   description: "Meraki MS250-48 Switch",             quantity: 1, unitPrice: 6900.00 },
  { sku: "CSC-FPR2130",    description: "Cisco Firepower 2130 NGFW",          quantity: 1, unitPrice: 18500.00 },
  { sku: "PAN-PA-3260",    description: "Palo Alto PA-3260 Firewall",         quantity: 1, unitPrice: 22000.00 },
  { sku: "ARB-AP-535",     description: "Aruba AP-535 Wireless Access Point", quantity: 5, unitPrice: 1150.00 },
  { sku: "CSC-DNA-LIC-3Y", description: "Cisco DNA Advantage 3-Year License", quantity: 10, unitPrice: 450.00 },
  { sku: "JNP-EX4400-48T", description: "Juniper EX4400-48T Switch",          quantity: 2, unitPrice: 5800.00 },
  { sku: "CSC-ASR1001-HX", description: "Cisco ASR 1001-HX Router",           quantity: 1, unitPrice: 28000.00 },
];

const SOURCE = "TBX-Oracle";

const ERROR_MESSAGES = [
  "Oracle ERP connectivity timeout after 30s",
  "Invalid SKU mapping in TBX catalog",
  "Provisioning gateway returned 503",
  "Customer account validation failed",
  "Inventory sync mismatch - stock unavailable",
  "Order submission rejected: duplicate PO number",
  "Oracle fulfillment API rate limit exceeded",
  "Shipping carrier API returned invalid tracking format",
];

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

function buildEvent(
  orderId: string,
  status: OrderStatus,
  customer: { id: string; name: string },
  lineItems: LineItem[],
  errorDetail?: string
): OrderEvent {
  return {
    eventId: uuid(),
    orderId,
    status,
    timestamp: new Date().toISOString(),
    source: SOURCE,
    customerId: customer.id,
    customerName: customer.name,
    lineItems,
    metadata: {
      simulatedAt: new Date().toISOString(),
      region: pick(["US-EAST", "US-WEST", "US-CENTRAL", "US-SOUTH"]),
    },
    ...(errorDetail ? { errorDetail } : {}),
  };
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// --- Simulation loop -------------------------------------------------------

interface ActiveOrder {
  orderId: string;
  customer: { id: string; name: string };
  lineItems: LineItem[];
  stepIndex: number;
  finished: boolean;
}

async function runSimulation(): Promise<void> {
  console.log("==============================================");
  console.log("  AT&T TBX Order Event Simulator");
  console.log(`  Orders: ${ORDER_COUNT}  |  Interval: ${INTERVAL_MS}ms`);
  console.log(`  Error rate: ${(ERROR_RATE * 100).toFixed(0)}%  |  Cancel rate: ${(CANCEL_RATE * 100).toFixed(0)}%`);
  console.log("==============================================\n");

  await connect();

  // Create all orders upfront
  const orders: ActiveOrder[] = Array.from({ length: ORDER_COUNT }, (_, i) => {
    const customer = pick(CUSTOMERS);
    return {
      orderId: `ORD-${Date.now()}-${String(i + 1).padStart(4, "0")}`,
      customer,
      lineItems: pickItems(),
      stepIndex: 0,
      finished: false,
    };
  });

  console.log(`[simulator] Created ${orders.length} orders. Starting event emission...\n`);

  // Each tick advances one random unfinished order by one step
  while (orders.some((o) => !o.finished)) {
    const active = orders.filter((o) => !o.finished);
    const order = pick(active);
    const status = HAPPY_PATH[order.stepIndex];

    // Random chance of error
    if (order.stepIndex > 1 && Math.random() < ERROR_RATE) {
      const evt = buildEvent(
        order.orderId,
        OrderStatus.ERROR,
        order.customer,
        order.lineItems,
        pick(ERROR_MESSAGES)
      );
      await publishEvent(evt);
      console.log(`[event] ${order.orderId}  ERROR  "${evt.errorDetail}"`);
      order.finished = true;
      await sleep(INTERVAL_MS);
      continue;
    }

    // Random chance of cancellation
    if (order.stepIndex > 0 && order.stepIndex < 5 && Math.random() < CANCEL_RATE) {
      const evt = buildEvent(order.orderId, OrderStatus.CANCELLED, order.customer, order.lineItems);
      await publishEvent(evt);
      console.log(`[event] ${order.orderId}  CANCELLED`);
      order.finished = true;
      await sleep(INTERVAL_MS);
      continue;
    }

    // Normal progression
    const evt = buildEvent(order.orderId, status, order.customer, order.lineItems);
    await publishEvent(evt);
    console.log(`[event] ${order.orderId}  ${status}`);

    order.stepIndex++;
    if (order.stepIndex >= HAPPY_PATH.length) {
      order.finished = true;
    }

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
