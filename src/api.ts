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
import express, { Request, Response, NextFunction } from "express";
import { connect, subscribe, disconnect } from "./rabbitmq";
import { connectDB, disconnectDB, EventModel } from "./db";
import {
  OrderEvent,
  Order,
  OrderStatus,
  EXCEPTION_STATUSES,
  QUEUE_ALL,
} from "./types";

const PORT                = parseInt(process.env.API_PORT ?? "3001", 10);
const WEBHOOK_URL         = process.env.POWER_AUTOMATE_WEBHOOK_URL ?? "";
const API_KEY             = process.env.API_KEY ?? "";
const WEBHOOK_TIMEOUT_MS  = 5_000;
const WEBHOOK_MAX_RETRIES = 3;

// --- In-memory order aggregation (rebuilt from MongoDB on startup) ----------
const orders: Map<string, Order> = new Map();

// --- Power Automate webhook ------------------------------------------------

async function notifyPowerAutomate(event: OrderEvent): Promise<void> {
  if (!WEBHOOK_URL) return;

  const delays = [1_000, 5_000, 15_000];
  for (let attempt = 1; attempt <= WEBHOOK_MAX_RETRIES; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), WEBHOOK_TIMEOUT_MS);
    try {
      const res = await fetch(WEBHOOK_URL, {
        method:  "POST",
        headers: { "Content-Type": "application/json" },
        body:    JSON.stringify({ event }),
        signal:  controller.signal,
      });
      clearTimeout(timer);
      console.log(`[webhook] POST to Power Automate → ${res.status} (attempt ${attempt})`);
      return;
    } catch (err) {
      clearTimeout(timer);
      console.warn(`[webhook] Attempt ${attempt}/${WEBHOOK_MAX_RETRIES} failed:`, (err as Error).message);
      if (attempt < WEBHOOK_MAX_RETRIES) {
        await new Promise((r) => setTimeout(r, delays[attempt - 1]));
      }
    }
  }
  console.error("[webhook] All retry attempts exhausted — event not delivered to Power Automate");
}

// --- API key authentication ------------------------------------------------

function requireApiKey(req: Request, res: Response, next: NextFunction): void {
  if (!API_KEY) { next(); return; }
  if (req.headers["x-api-key"] !== API_KEY) {
    res.status(401).json({ error: "Unauthorized" });
    return;
  }
  next();
}

// --- Event ingestion -------------------------------------------------------

function updateOrderCache(event: OrderEvent): void {
  let order = orders.get(event.orderId);
  if (!order) {
    order = {
      orderId:       event.orderId,
      customerId:    event.customerId,
      customerName:  event.customerName,
      currentStatus: event.status,
      lineItems:     event.lineItems,
      events:        [],
      createdAt:     event.timestamp,
      updatedAt:     event.timestamp,
    };
    orders.set(event.orderId, order);
  }
  order.currentStatus = event.status;
  order.updatedAt     = event.timestamp;
  order.events.push(event);
}

async function ingestEvent(event: OrderEvent): Promise<void> {
  // Persist to MongoDB (ignore duplicate eventIds)
  await EventModel.updateOne(
    { eventId: event.eventId },
    { $setOnInsert: event },
    { upsert: true }
  );

  // Update in-memory order cache
  updateOrderCache(event);

  // Notify Power Automate if webhook is configured (awaited — fires after MongoDB confirms)
  await notifyPowerAutomate(event);
}

// --- Express app -----------------------------------------------------------

const app = express();
app.use(express.json());
app.use("/api", requireApiKey);

// Healthcheck
app.get("/health", async (_req: Request, res: Response) => {
  const eventCount = await EventModel.countDocuments();
  res.json({
    status:     "ok",
    uptime:     process.uptime(),
    eventCount,
    orderCount: orders.size,
  });
});

// GET /api/events - list all events with optional query filters
//   ?status=BOOKED
//   ?orderId=ORD-...
//   ?customerId=CUST-1001
//   ?limit=50&offset=0
app.get("/api/events", async (req: Request, res: Response) => {
  const { status, orderId, customerId } = req.query;
  const filter: Record<string, unknown> = {};
  if (status)     filter.status     = status;
  if (orderId)    filter.orderId    = orderId;
  if (customerId) filter.customerId = customerId;

  const limit  = Math.min(parseInt(String(req.query.limit ?? "50"), 10) || 50, 500);
  const offset = parseInt(String(req.query.offset ?? "0"), 10) || 0;

  const [total, data] = await Promise.all([
    EventModel.countDocuments(filter),
    EventModel.find(filter, { _id: 0 })
      .sort({ timestamp: -1 })
      .skip(offset)
      .limit(limit)
      .lean(),
  ]);

  res.json({ total, limit, offset, data });
});

// GET /api/events/:eventId
app.get("/api/events/:eventId", async (req: Request, res: Response) => {
  const event = await EventModel.findOne(
    { eventId: req.params.eventId },
    { _id: 0 }
  ).lean();
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
app.get("/api/stats", async (_req: Request, res: Response) => {
  const statusCounts: Record<string, number> = {};
  for (const order of orders.values()) {
    statusCounts[order.currentStatus] = (statusCounts[order.currentStatus] || 0) + 1;
  }

  const receivedOrders = Array.from(orders.values()).filter(
    (o) => o.currentStatus === OrderStatus.RECEIVED || o.currentStatus === OrderStatus.PARTIALLY_RECEIVED
  );

  let avgLifecycleMs = 0;
  if (receivedOrders.length > 0) {
    const totalMs = receivedOrders.reduce((sum, o) => {
      return sum + (new Date(o.updatedAt).getTime() - new Date(o.createdAt).getTime());
    }, 0);
    avgLifecycleMs = totalMs / receivedOrders.length;
  }

  const [totalEvents, exceptionCount, oldest, newest] = await Promise.all([
    EventModel.countDocuments(),
    EventModel.countDocuments({ status: { $in: EXCEPTION_STATUSES } }),
    EventModel.findOne({}, { timestamp: 1, _id: 0 }).sort({ timestamp: 1 }).lean(),
    EventModel.findOne({}, { timestamp: 1, _id: 0 }).sort({ timestamp: -1 }).lean(),
  ]);

  res.json({
    totalEvents,
    totalOrders:    orders.size,
    ordersByStatus: statusCounts,
    exceptionCount,
    receivedCount:  receivedOrders.length,
    avgLifecycleMs: Math.round(avgLifecycleMs),
    oldestEvent:    oldest?.timestamp ?? null,
    newestEvent:    newest?.timestamp ?? null,
  });
});

// --- Startup ---------------------------------------------------------------

async function start(): Promise<void> {
  console.log("==============================================");
  console.log("  AT&T TBX Event API");
  console.log(`  Port:    ${PORT}`);
  console.log(`  Webhook: ${WEBHOOK_URL || "disabled"}`);
  console.log(`  API Key: ${API_KEY ? "enabled" : "disabled (set API_KEY to enable)"}`);
  console.log("==============================================\n");

  // Connect to MongoDB
  await connectDB();

  // Rebuild in-memory order cache from persisted events
  const persisted = await EventModel.find({}, { _id: 0 })
    .sort({ timestamp: 1 })
    .lean();
  for (const event of persisted as OrderEvent[]) {
    updateOrderCache(event);
  }
  console.log(`[api] Restored ${persisted.length} events from MongoDB`);

  // Connect to RabbitMQ and subscribe to all events
  await connect();
  await subscribe(QUEUE_ALL, async (event) => {
    await ingestEvent(event);
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
    await disconnectDB();
    process.exit(0);
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

start().catch((err) => {
  console.error("[api] Fatal error:", err);
  process.exit(1);
});
