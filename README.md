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
