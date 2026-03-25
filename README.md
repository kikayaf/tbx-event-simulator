# AT&T TBX Order Event Simulator

Proof-of-concept simulation of the TBX order lifecycle event pipeline. Generates
realistic order events, publishes them through RabbitMQ, and exposes them via a
REST API for consumption by downstream systems such as Power Automate -- mirroring
the future-state architecture where TBX/Oracle ERP emits events through a message
broker for downstream consumers including SharePoint and email notifications.

## Architecture

```
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                              SIMULATOR LAYER                                │
  │                                                                             │
  │   ┌──────────────────────────────┐                                          │
  │   │      Event Simulator         │                                          │
  │   │      (TypeScript)            │                                          │
  │   │                              │                                          │
  │   │  Simulates TBX Oracle ERP    │                                          │
  │   │  order lifecycle events      │                                          │
  │   └──────────────┬───────────────┘                                          │
  └──────────────────┼──────────────────────────────────────────────────────────┘
                     │ publishes events
                     ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                              MESSAGE BROKER                                 │
  │                                                                             │
  │   ┌──────────────────────────────┐                                          │
  │   │          RabbitMQ            │                                          │
  │   │     (topic exchange)         │                                          │
  │   │                              │                                          │
  │   │  Exchange : tbx.events       │                                          │
  │   │  Queue    : tbx.events.all   │                                          │
  │   │  Queue    : tbx.events.      │                                          │
  │   │             exceptions       │                                          │
  │   └──────────────┬───────────────┘                                          │
  └──────────────────┼──────────────────────────────────────────────────────────┘
                     │ consumes events
                     ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                                  API LAYER                                  │
  │                                                                             │
  │   ┌──────────────────────────────┐      ┌──────────────────────────────┐   │
  │   │         REST API             │      │          MongoDB             │   │
  │   │         (Express)            │ ───► │         (Docker)             │   │
  │   │                              │      │                              │   │
  │   │  :3001/api/*                 │      │  db       : tbx              │   │
  │   │  1. Ingests event            │      │  collection: orderevents     │   │
  │   │  2. Persists to MongoDB      │      │  Survives API restarts       │   │
  │   │  3. Fires webhook trigger    │      └──────────────────────────────┘   │
  │   └──────────────┬───────────────┘                                         │
  └──────────────────┼─────────────────────────────────────────────────────────┘
                     │ POST webhook trigger (new event)
                     │ via ngrok public tunnel
                     ▼
  ┌─────────────────────────────────────────────────────────────────────────────┐
  │                            DOWNSTREAM CONSUMER                              │
  │                                                                             │
  │   ┌──────────────────────────────────────────────────────────────────────┐  │
  │   │                       Power Automate                                 │  │
  │   │                   (HTTP Request trigger)                             │  │
  │   │                                                                      │  │
  │   │   1. Wakes up on webhook POST                                        │  │
  │   │   2. GET /api/events via ngrok tunnel                                │  │
  │   │   3. Parses and processes event payload                              │  │
  │   └────────────────────────────┬─────────────────────────────────────────┘  │
  │                                │                                             │
  │              ┌─────────────────┴──────────────────┐                         │
  │              ▼                                     ▼                         │
  │   ┌─────────────────────┐             ┌─────────────────────┐               │
  │   │     SharePoint      │             │        Email        │               │
  │   │    (event list)     │             │   (notifications)   │               │
  │   └─────────────────────┘             └─────────────────────┘               │
  └─────────────────────────────────────────────────────────────────────────────┘

  ngrok tunnel: localhost:3001 ◄──────────────────────────────────► public HTTPS URL
```

> **ngrok** is required to expose the local API so Power Automate can reach it.
> Events are persisted to **MongoDB** and survive API restarts.

## Order Lifecycle Events

Event types are aligned with the AT&T TBX Oracle system as confirmed by
Barry Hammon and the AT&T discovery docs, architecture files, and technical spec.

### Core Milestone Events (real-time)

| Event | Timing | Payload Highlights |
|---|---|---|
| `BOOKED` | Real-time | Full order metadata: PO number, quote number, customer info, line items, order total |
| `SHIPPED` | Real-time | Tracking number, carrier, serial numbers, estimated ship date, estimated delivery date |
| `RECEIVED` | Real-time | Receipt date, received quantity, confirmed quantity |
| `PARTIALLY_RECEIVED` | Real-time | Receipt date, partial received quantity vs confirmed total |

### Digest Batch Event (6-hour intervals)

| Event | Timing | Payload Highlights |
|---|---|---|
| `DATE_CHANGE` | 6-hour digest | Previous/new estimated ship date, previous/new estimated arrival date |

### Exception Events

| Event | Context |
|---|---|
| `PAYMENT_FAILED` | Payment processing error |
| `OUT_OF_STOCK` | Inventory sync mismatch |
| `SHIPPING_DELAYED` | Carrier or fulfillment delay |
| `ADDRESS_INVALID` | Customer address validation failure |
| `SYSTEM_ERROR` | Integration or gateway failure |

### Simulation Flow

```
BOOKED ──[DATE_CHANGE?]──> SHIPPED ──> RECEIVED
   │                          │            └─> PARTIALLY_RECEIVED (15% branch)
   └─> Exception (10% chance per step):
       PAYMENT_FAILED | ADDRESS_INVALID | OUT_OF_STOCK | SHIPPING_DELAYED | SYSTEM_ERROR
```

## Prerequisites

- Docker and Docker Compose
- (Optional) Node.js 20+ and npm for local development

## Quick Start (Docker)

```bash
# Clone or navigate to this directory
cd tbx-event-simulator

# Start everything (RabbitMQ + Simulator + API)
docker compose up --build

# In another terminal, query the API
curl http://localhost:3001/health
curl http://localhost:3001/api/orders
curl http://localhost:3001/api/events
curl http://localhost:3001/api/stats
```

## Local Development (without Docker for app code)

```bash
# Start RabbitMQ and MongoDB
docker compose up rabbitmq mongodb -d

# Install dependencies
npm install

# Run simulator and API concurrently
npm run dev:all

# Or run them separately
npm run dev:simulator
npm run dev:api
```

## API Endpoints

| Method | Path                          | Description                          |
|--------|-------------------------------|--------------------------------------|
| GET    | `/health`                     | Service health and counts            |
| GET    | `/api/events`                 | List events (filterable)             |
| GET    | `/api/events/{eventId}`       | Single event by ID                   |
| GET    | `/api/orders`                 | List orders (filterable)             |
| GET    | `/api/orders/{orderId}`       | Single order with event history      |
| GET    | `/api/orders/{orderId}/events`| Events for a specific order          |
| GET    | `/api/stats`                  | Aggregate statistics                 |

> **Note:** `{eventId}` and `{orderId}` are placeholders — replace with the actual ID value.
> Example: `GET /api/events/3f2a1b4c-...` or `GET /api/orders/ORD-1773773838793-0001`

### Query Parameters

Events and orders endpoints support:

- `?status=BOOKED` -- filter by status (valid values: `BOOKED`, `SHIPPED`, `RECEIVED`, `PARTIALLY_RECEIVED`, `DATE_CHANGE`, `PAYMENT_FAILED`, `OUT_OF_STOCK`, `SHIPPING_DELAYED`, `ADDRESS_INVALID`, `SYSTEM_ERROR`)
- `?customerId=CUST-1001` -- filter by customer
- `?orderId=ORD-...` -- filter events by order (events endpoint only)
- `?limit=50&offset=0` -- pagination

## RabbitMQ Management

- **URL:** http://localhost:15672
- **Username:** `tbx_user`
- **Password:** `tbx_pass`

### Topology

- **Exchange:** `tbx.events` (topic)
- **Queue:** `tbx.events.all` -- receives all events (bound to `order.#`)
- **Queue:** `tbx.events.exceptions` -- receives exception events only (bound to each exception routing key)
- **Routing keys:** `order.BOOKED`, `order.SHIPPED`, `order.RECEIVED`, `order.PARTIALLY_RECEIVED`, `order.DATE_CHANGE`, `order.PAYMENT_FAILED`, `order.OUT_OF_STOCK`, `order.SHIPPING_DELAYED`, `order.ADDRESS_INVALID`, `order.SYSTEM_ERROR`

### Why the queue appears empty

The API consumes and acknowledges messages instantly — queues will show as empty during
normal operation. This is expected. To inspect messages mid-flight:

1. Stop the API (`Ctrl+C` or stop the `tbx-api` container)
2. Run the simulator only: `npm run dev:simulator`
3. Open **http://localhost:15672** → **Queues** → `tbx.events.all` → **Get Messages**

To monitor live message rates without stopping the API:
- Go to **Queues** → `tbx.events.all` → view the **Message rates** graph

## MongoDB

Events are persisted to MongoDB so they survive API restarts. The API rebuilds its
in-memory order cache from MongoDB on startup.

- **Container:** `tbx-mongodb`
- **Port:** `27017`
- **Database:** `tbx`
- **Collection:** `orderevents`

### Querying persisted events with mongosh

```bash
# Connect to the MongoDB container
docker exec -it tbx-mongodb mongosh

# Switch to the tbx database
use tbx

# See all events
db.orderevents.find().pretty()

# Count total events
db.orderevents.countDocuments()

# Filter by status
db.orderevents.find({ status: "BOOKED" }).pretty()

# Filter by orderId
db.orderevents.find({ orderId: "ORD-1773773838793-0001" }).pretty()

# Filter by customerId
db.orderevents.find({ customerId: "CUST-1001" }).pretty()

# Exit
exit
```

> **Tip:** You can also use **MongoDB Compass** (free GUI) to browse the data visually.
> Download at https://www.mongodb.com/try/download/compass and connect to `mongodb://localhost:27017`.

## Configuration

Set via environment variables or `.env` file (copy `.env.example`):

| Variable                         | Default | Description                                      |
|----------------------------------|---------|--------------------------------------------------|
| `RABBITMQ_URL`                   | (see .env.example) | AMQP connection string              |
| `MONGODB_URL`                    | `mongodb://localhost:27017/tbx` | MongoDB connection string  |
| `SIMULATOR_ORDER_COUNT`          | 10      | Number of orders to simulate                     |
| `SIMULATOR_INTERVAL_MS`          | 3000    | Delay between events (ms)                        |
| `SIMULATOR_EXCEPTION_RATE`       | 0.10    | Probability of an exception per step             |
| `SIMULATOR_DATE_CHANGE_RATE`     | 0.20    | Probability of a DATE_CHANGE before SHIPPED      |
| `SIMULATOR_PARTIAL_RECEIVE_RATE` | 0.15    | Probability of PARTIALLY_RECEIVED vs RECEIVED    |
| `API_PORT`                       | 3001    | REST API listen port                             |
| `POWER_AUTOMATE_WEBHOOK_URL`     | (blank) | Power Automate HTTP trigger URL — leave blank to disable |

## Exposing the API Externally with ngrok

By default the API runs on `localhost` and is not reachable from external services
such as Power Automate. ngrok creates a secure public tunnel to your local port.

**ngrok documentation:** https://ngrok.com/docs/getting-started/

### Step 1 — Install ngrok

```bash
curl -s https://ngrok-agent.s3.amazonaws.com/ngrok.asc | sudo tee /etc/apt/trusted.gpg.d/ngrok.asc >/dev/null
echo "deb https://ngrok-agent.s3.amazonaws.com buster main" | sudo tee /etc/apt/sources.list.d/ngrok.list
sudo apt-get update && sudo apt-get install -y ngrok
```

### Step 2 — Create a free account and authenticate

1. Sign up at **https://dashboard.ngrok.com/signup**
2. Copy your auth token from **https://dashboard.ngrok.com/get-started/your-authtoken**
3. Add it to your local ngrok config:

```bash
ngrok config add-authtoken <YOUR_TOKEN>
```

### Step 3 — Start the tunnel

Make sure the simulator is already running (`npm run dev:all`), then in a new terminal:

```bash
ngrok http 3001
```

You will see output like:

```
Forwarding  https://abc123.ngrok-free.dev -> http://localhost:3001
```

The `https://` URL is now publicly accessible.

### Step 4 — Test the tunnel

```bash
curl https://<your-ngrok-url>/health
curl https://<your-ngrok-url>/api/events
curl https://<your-ngrok-url>/api/orders
curl https://<your-ngrok-url>/api/stats
```

### Step 5 — Inspect traffic in the ngrok dashboard

ngrok ships with a local web inspector. Open **http://localhost:4040** in your browser
to see every request that passes through the tunnel — including URL, headers, request
body, response body, and status code. You can also **replay** any request directly
from this UI without re-triggering the consumer.

---

## Integrating with Power Automate

The API uses a **webhook push** pattern to trigger your Power Automate flow in real time.
Every time a new event is ingested from RabbitMQ, the API POSTs to your Power Automate
HTTP trigger URL — waking the flow up instantly rather than waiting for a poll.

```
TBX Oracle → RabbitMQ → API ──POST /trigger──▶ Power Automate
                          │                           │
                     ngrok tunnel              GET /api/events
                     (public URL)              via ngrok URL
                                                      │
                                          ┌───────────┴───────────┐
                                          ▼                       ▼
                                     SharePoint                 Email
```

### Step 1 — Get your Power Automate HTTP trigger URL

1. Open your flow in Power Automate
2. Click the **HTTP Request trigger** at the top of the flow
3. Copy the **HTTP POST URL**

### Step 2 — Add the webhook URL to your .env

```bash
# .env
POWER_AUTOMATE_WEBHOOK_URL=https://prod-xx.westus.logic.azure.com/workflows/...
```

Restart the API after saving:
```bash
npm run dev:all
```

The startup log will confirm the webhook is active:
```
  Webhook: https://prod-xx.westus.logic.azure.com/workflows/...
```

### Step 3 — Add an HTTP action inside your flow (fetch full events)

Your flow wakes up when the API POSTs to it. Inside the flow, add a **HTTP** action
to fetch the full event list from the API via ngrok:

- **Method:** `GET`
- **URI:** `https://<your-ngrok-url>/api/events?limit=20`

> Use `?status=` to filter by a specific lifecycle stage, e.g. `?status=BOOKED`, `?status=SHIPPED`, `?status=RECEIVED`.

### Step 4 — Parse the JSON response

1. Add a **Parse JSON** action after the HTTP step
2. Set **Content** to `Body` from the HTTP step
3. Click **Generate from sample** and paste the following:

```json
[{
  "eventId": "e1",
  "orderId": "ORD-1773773838793-0001",
  "customerId": "CUST-1001",
  "customerName": "AT&T Corporate HQ",
  "status": "BOOKED",
  "timestamp": "2026-03-24T22:32:16.759Z",
  "source": "TBX-Oracle",
  "poNumber": "PO-ATT-482910",
  "quoteNumber": "QT-839201",
  "orderTotal": 12400.00,
  "trackingNumber": null,
  "carrier": null,
  "receiptDate": null,
  "receivedQuantity": null,
  "confirmedQuantity": null,
  "exceptionDetail": null,
  "exceptionCode": null,
  "lineItems": [
    { "sku": "CSC-ISR4451", "description": "Cisco ISR 4451-X Router", "quantity": 1, "unitPrice": 12400.00 }
  ],
  "metadata": { "region": "US-EAST", "simulatedAt": "2026-03-24T22:32:16.759Z" }
}]
```

### Step 5 — Loop through events

Add an **Apply to each** action, selecting `Body` from the Parse JSON step.
Inside the loop add the actions below.

#### Write to SharePoint

Add a **Create item** action inside the loop:

| SharePoint Column | Dynamic Content      |
|-------------------|----------------------|
| Title             | `eventId`            |
| Order ID          | `orderId`            |
| Customer ID       | `customerId`         |
| Customer Name     | `customerName`       |
| Status            | `status`             |
| Timestamp         | `timestamp`          |
| Source System     | `source`             |
| PO Number         | `poNumber`           |
| Tracking Number   | `trackingNumber`     |
| Exception Detail  | `exceptionDetail`    |

#### Send an Email

Add a **Send an email (V2)** action inside the loop:

- **To:** your notification address
- **Subject:** `TBX Event: [status] - [orderId]`
- **Body:**
  ```
  Order:    [orderId]
  Customer: [customerName] ([customerId])
  Status:   [status]
  Time:     [timestamp]
  Source:   [source]
  PO:       [poNumber]
  Tracking: [trackingNumber]
  Exception:[exceptionDetail]
  ```

### Step 6 — Save and test

1. Click **Save**
2. Click **Test** → **Manually** → **Run flow**
3. Check your SharePoint list and inbox for incoming events

> **Note:** The free ngrok plan generates a new URL each time you restart the tunnel.
> Update the URI in your HTTP action whenever the URL changes, or upgrade to a paid
> ngrok plan to use a fixed static domain.

---

## Project Structure

```
tbx-event-simulator/
  docker-compose.yml     -- RabbitMQ + MongoDB + Simulator + API containers
  Dockerfile             -- Multi-stage Node build
  package.json
  tsconfig.json
  .env.example
  src/
    types.ts             -- Event schemas, order model, constants
    rabbitmq.ts          -- Connection manager, publish/subscribe
    db.ts                -- MongoDB connection and event schema (Mongoose)
    simulator.ts         -- Event generation engine
    api.ts               -- Express REST API with MongoDB persistence and webhook
```
