# AT&T TBX Order Event Simulator

Proof-of-concept simulation of the TBX order lifecycle event pipeline. Generates
realistic order events, publishes them through RabbitMQ, and exposes them via a
REST API -- mirroring the future-state architecture where TBX/Oracle ERP emits
events through a message broker for downstream consumers.

## Architecture

```
+------------------+       +-------------------+       +----------------+
|  Event Simulator | ----> |     RabbitMQ      | ----> |   REST API     |
|  (TypeScript)    |       |  (topic exchange) |       |   (Express)    |
+------------------+       +-------------------+       +----------------+
                                                              |
                                                         :3001/api/*
```

## Order Lifecycle Events

The simulator produces events that follow the TBX order lifecycle:

1. `QUOTE_CREATED` -- ISR creates a new quote
2. `QUOTE_APPROVED` -- Quote approved / pricing validated
3. `ORDER_CREATED` -- Order submitted to TBX Oracle
4. `ORDER_CONFIRMED` -- TBX confirms receipt and validation
5. `PROVISIONING_STARTED` -- Provisioning/fulfillment begins
6. `PROVISIONING_COMPLETE` -- Provisioning finished
7. `SHIPPED` -- Order shipped with carrier
8. `DELIVERED` -- Order delivered to customer

Branch events: `ERROR` (8% default) and `CANCELLED` (5% default) can occur
at any eligible stage.

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
# Start RabbitMQ only
docker compose up rabbitmq

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
| GET    | `/api/events/:eventId`        | Single event by ID                   |
| GET    | `/api/orders`                 | List orders (filterable)             |
| GET    | `/api/orders/:orderId`        | Single order with event history      |
| GET    | `/api/orders/:orderId/events` | Events for a specific order          |
| GET    | `/api/stats`                  | Aggregate statistics                 |

### Query Parameters

Events and orders endpoints support:

- `?status=SHIPPED` -- filter by status
- `?customerId=CUST-1001` -- filter by customer
- `?orderId=ORD-...` -- filter events by order (events endpoint only)
- `?limit=50&offset=0` -- pagination

## RabbitMQ Management

- URL: http://localhost:15672
- Username: `tbx_user`
- Password: `tbx_pass`

### Topology

- **Exchange:** `tbx.events` (topic)
- **Queue:** `tbx.events.all` -- receives all events (bound to `order.#`)
- **Queue:** `tbx.events.errors` -- receives error events only (bound to `order.ERROR`)
- **Routing keys:** `order.QUOTE_CREATED`, `order.ORDER_CONFIRMED`, `order.ERROR`, etc.

## Configuration

Set via environment variables or `.env` file (copy `.env.example`):

| Variable                 | Default | Description                        |
|--------------------------|---------|------------------------------------|
| `RABBITMQ_URL`           | (see .env.example) | AMQP connection string  |
| `SIMULATOR_ORDER_COUNT`  | 10      | Number of orders to simulate       |
| `SIMULATOR_INTERVAL_MS`  | 3000    | Delay between events (ms)          |
| `SIMULATOR_ERROR_RATE`   | 0.08    | Probability of error per step      |
| `SIMULATOR_CANCEL_RATE`  | 0.05    | Probability of cancellation        |
| `API_PORT`               | 3001    | REST API listen port               |

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

With the API publicly exposed via ngrok, your existing Power Automate flow can pull
in TBX events using the built-in HTTP connector and route them to SharePoint and email.

### Step 1 — Add an HTTP action (fetch events)

Inside your existing flow, add a **HTTP** action at the point where you want events pulled:

- **Method:** `GET`
- **URI:** `https://<your-ngrok-url>/api/events?limit=20`

> Use `?status=` to filter by a specific lifecycle stage, e.g. `?status=DELIVERED`.

### Step 2 — Parse the JSON response

1. Add a **Parse JSON** action after the HTTP step
2. Set **Content** to `Body` from the HTTP step
3. Click **Generate from sample** and paste the following:

```json
[{
  "eventId": "e1",
  "orderId": "ORD-1773773838793-0001",
  "customerId": "CUST-1001",
  "status": "QUOTE_CREATED",
  "timestamp": "2026-03-24T22:32:16.759Z",
  "sourceSystem": "TBX-Oracle"
}]
```

### Step 3 — Loop through events

Add an **Apply to each** action, selecting `Body` from the Parse JSON step.
Inside the loop add the actions below.

#### Write to SharePoint

Add a **Create item** action inside the loop:

| SharePoint Column | Dynamic Content      |
|-------------------|----------------------|
| Title             | `eventId`            |
| Order ID          | `orderId`            |
| Customer ID       | `customerId`         |
| Status            | `status`             |
| Timestamp         | `timestamp`          |
| Source System     | `sourceSystem`       |

#### Send an Email

Add a **Send an email (V2)** action inside the loop:

- **To:** your notification address
- **Subject:** `TBX Event: [status] - [orderId]`
- **Body:**
  ```
  Order [orderId] for customer [customerId]
  Status: [status]
  Time:   [timestamp]
  Source: [sourceSystem]
  ```

### Step 4 — Save and test

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
  docker-compose.yml     -- RabbitMQ + Simulator + API containers
  Dockerfile             -- Multi-stage Node build
  package.json
  tsconfig.json
  .env.example
  src/
    types.ts             -- Event schemas, order model, constants
    rabbitmq.ts          -- Connection manager, publish/subscribe
    simulator.ts         -- Event generation engine
    api.ts               -- Express REST API
```
