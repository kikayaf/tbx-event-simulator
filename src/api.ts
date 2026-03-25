// ---------------------------------------------------------------------------
// AT&T TBX Event API Layer
// ---------------------------------------------------------------------------
// REST API that consumes events from RabbitMQ and exposes them for querying.
// Stores events in-memory (suitable for POC / demo use).
//
// Endpoints:
//   GET  /health                     - Healthcheck
//   GET  /api/events                 - List all events (with optional filters)
//   GET  /api/events/:eventId        - Single event by ID
//   GET  /api/orders                 - List all orders (aggregated from events)
//   GET  /api/orders/:orderId        - Single order with full event history
//   GET  /api/orders/:orderId/events - Events for a specific order
//   GET  /api/stats                  - Summary statistics
// ---------------------------------------------------------------------------

import "dotenv/config";
import express, { Request, Response } from "express";
import { connect, subscribe, disconnect } from "./rabbitmq";
import {
  OrderEvent,
  Order,
  OrderStatus,
  EXCEPTION_STATUSES,
  QUEUE_ALL,
} from "./types";

const PORT               = parseInt(process.env.API_PORT ?? "3000", 10);
const WEBHOOK_URL        = process.env.POWER_AUTOMATE_WEBHOOK_URL ?? "";

// --- In-memory stores ------------------------------------------------------

const events: OrderEvent[] = [];
const orders: Map<string, Order> = new Map();

// --- Power Automate webhook ------------------------------------------------

async function notifyPowerAutomate(event: OrderEvent): Promise<void> {
  if (!WEBHOOK_URL) return;

  try {
    const res = await fetch(WEBHOOK_URL, {
      method:  "POST",
      headers: { "Content-Type": "application/json" },
      body:    JSON.stringify({ event }),
    });
    console.log(`[webhook] POST to Power Automate → ${res.status}`);
  } catch (err) {
    console.warn(`[webhook] Failed to notify Power Automate:`, err);
  }
}

// --- Event ingestion -------------------------------------------------------

function ingestEvent(event: OrderEvent): void {
  events.push(event);

  let order = orders.get(event.orderId);
  if (!order) {
    order = {
      orderId: event.orderId,
      customerId: event.customerId,
      customerName: event.customerName,
      currentStatus: event.status,
      lineItems: event.lineItems,
      events: [],
      createdAt: event.timestamp,
      updatedAt: event.timestamp,
    };
    orders.set(event.orderId, order);
  }

  order.currentStatus = event.status;
  order.updatedAt = event.timestamp;
  order.events.push(event);

  // Notify Power Automate if webhook is configured
  notifyPowerAutomate(event);
}

// --- Express app -----------------------------------------------------------

const app = express();
app.use(express.json());

// Healthcheck
app.get("/health", (_req: Request, res: Response) => {
  res.json({
    status: "ok",
    uptime: process.uptime(),
    eventCount: events.length,
    orderCount: orders.size,
  });
});

// GET /api/events - list all events with optional query filters
//   ?status=ORDER_CONFIRMED
//   ?orderId=ORD-...
//   ?customerId=CUST-1001
//   ?limit=50&offset=0
app.get("/api/events", (req: Request, res: Response) => {
  let result = [...events];

  const { status, orderId, customerId } = req.query;
  if (status)     result = result.filter((e) => e.status === status);
  if (orderId)    result = result.filter((e) => e.orderId === orderId);
  if (customerId) result = result.filter((e) => e.customerId === customerId);

  // Sort newest first
  result.sort((a, b) => new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime());

  const limit  = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
  const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
  const paged  = result.slice(offset, offset + limit);

  res.json({
    total: result.length,
    limit,
    offset,
    data: paged,
  });
});

// GET /api/events/:eventId
app.get("/api/events/:eventId", (req: Request, res: Response) => {
  const event = events.find((e) => e.eventId === req.params.eventId);
  if (!event) {
    res.status(404).json({ error: "Event not found" });
    return;
  }
  res.json(event);
});

// GET /api/orders - list all orders
//   ?status=SHIPPED
//   ?customerId=CUST-1001
//   ?limit=50&offset=0
app.get("/api/orders", (req: Request, res: Response) => {
  let result = Array.from(orders.values());

  const { status, customerId } = req.query;
  if (status)     result = result.filter((o) => o.currentStatus === String(status));
  if (customerId) result = result.filter((o) => o.customerId === String(customerId));

  result.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());

  const limit  = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
  const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;
  const paged  = result.slice(offset, offset + limit);

  res.json({
    total: result.length,
    limit,
    offset,
    data: paged,
  });
});

// GET /api/orders/:orderId
app.get("/api/orders/:orderId", (req: Request, res: Response) => {
  const order = orders.get(String(req.params.orderId));
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json(order);
});

// GET /api/orders/:orderId/events
app.get("/api/orders/:orderId/events", (req: Request, res: Response) => {
  const order = orders.get(String(req.params.orderId));
  if (!order) {
    res.status(404).json({ error: "Order not found" });
    return;
  }
  res.json({
    orderId: order.orderId,
    total: order.events.length,
    data: order.events,
  });
});

// GET /api/stats - aggregated statistics
app.get("/api/stats", (_req: Request, res: Response) => {
  const statusCounts: Record<string, number> = {};
  for (const order of orders.values()) {
    statusCounts[order.currentStatus] = (statusCounts[order.currentStatus] || 0) + 1;
  }

  const exceptionEvents = events.filter((e) => EXCEPTION_STATUSES.includes(e.status));
  const receivedOrders  = Array.from(orders.values()).filter(
    (o) => o.currentStatus === OrderStatus.RECEIVED || o.currentStatus === OrderStatus.PARTIALLY_RECEIVED
  );

  // Calculate average lifecycle duration for received orders
  let avgLifecycleMs = 0;
  if (receivedOrders.length > 0) {
    const totalMs = receivedOrders.reduce((sum, o) => {
      return sum + (new Date(o.updatedAt).getTime() - new Date(o.createdAt).getTime());
    }, 0);
    avgLifecycleMs = totalMs / receivedOrders.length;
  }

  res.json({
    totalEvents:    events.length,
    totalOrders:    orders.size,
    ordersByStatus: statusCounts,
    exceptionCount: exceptionEvents.length,
    receivedCount:  receivedOrders.length,
    avgLifecycleMs: Math.round(avgLifecycleMs),
    oldestEvent:    events[0]?.timestamp ?? null,
    newestEvent:    events[events.length - 1]?.timestamp ?? null,
  });
});

// --- Startup ---------------------------------------------------------------

async function start(): Promise<void> {
  console.log("==============================================");
  console.log("  AT&T TBX Event API");
  console.log(`  Port:    ${PORT}`);
  console.log(`  Webhook: ${WEBHOOK_URL || "disabled"}`);
  console.log("==============================================\n");

  await connect();

  // Subscribe to all events and ingest them
  await subscribe(QUEUE_ALL, (event) => {
    ingestEvent(event);
    console.log(`[api] Ingested ${event.status} for ${event.orderId}`);
  });

  app.listen(PORT, () => {
    console.log(`[api] REST API listening on http://0.0.0.0:${PORT}`);
    console.log("[api] Endpoints:");
    console.log("  GET /health");
    console.log("  GET /api/events");
    console.log("  GET /api/events/:eventId");
    console.log("  GET /api/orders");
    console.log("  GET /api/orders/:orderId");
    console.log("  GET /api/orders/:orderId/events");
    console.log("  GET /api/stats");
  });

  // Graceful shutdown
  const shutdown = async () => {
    console.log("\n[api] Shutting down...");
    await disconnect();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("[api] Fatal error:", err);
  process.exit(1);
});
