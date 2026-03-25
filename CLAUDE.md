# TBX Order Event Simulator

## What This Is
A proof-of-concept that simulates TBX Oracle order events flowing through RabbitMQ and exposed via a REST API. This is NOT connected to any real AT&T systems. The simulator generates fake but realistic order lifecycle events.

## Architecture
- **Event Simulator** (`src/simulator.ts`) -- Generates order events and publishes to RabbitMQ
- **RabbitMQ** -- Message broker using a topic exchange (`tbx.events`) with routing keys per status
- **REST API** (`src/api.ts`) -- Express server that consumes events from RabbitMQ, persists to MongoDB, serves via REST endpoints, and fires a webhook to Power Automate on each new event
- **MongoDB** (`src/db.ts`) -- Persistent event store (Docker container); events survive API restarts; order cache rebuilt on startup
- **Shared types** (`src/types.ts`) -- Event schema, order model, status enum, RabbitMQ constants
- **RabbitMQ client** (`src/rabbitmq.ts`) -- Connection manager with retry logic, publish/subscribe helpers
- **ngrok** -- Secure public tunnel exposing the local API (`:3001`) so Power Automate can reach it
- **Power Automate** -- Downstream consumer triggered by webhook; fetches events via ngrok, writes to SharePoint and sends email notifications

## Tech Stack
- TypeScript, Node.js 20+
- Express (REST API)
- amqplib (RabbitMQ client)
- Mongoose (MongoDB ODM)
- dotenv (environment variable loading from `.env`)
- Docker Compose (RabbitMQ + MongoDB + app containers)

## Running
```bash
# Full stack via Docker
docker compose up --build

# Local dev (RabbitMQ + MongoDB in Docker, app code native)
cp .env.example .env          # configure API_PORT etc.
docker compose up rabbitmq mongodb -d
npm install
npm run dev:all
```

## Key Commands
- `npm run build` -- Compile TypeScript to `dist/`
- `npm run dev:simulator` -- Run simulator with ts-node
- `npm run dev:api` -- Run API with ts-node
- `npm run dev:all` -- Run both concurrently
- `npm run start:simulator` -- Run compiled simulator
- `npm run start:api` -- Run compiled API
- `npm run start:all` -- Run both compiled concurrently

## API Endpoints
- `GET /health` -- Service health
- `GET /api/events` -- List events (`?status=`, `?orderId=`, `?customerId=`, `?limit=`, `?offset=`)
- `GET /api/events/:eventId` -- Single event
- `GET /api/orders` -- List orders (`?status=`, `?customerId=`, `?limit=`, `?offset=`)
- `GET /api/orders/:orderId` -- Single order with event history
- `GET /api/orders/:orderId/events` -- Events for an order
- `GET /api/stats` -- Aggregate statistics

## Order Lifecycle
Core milestone events (real-time): BOOKED -> SHIPPED -> RECEIVED
Branch events: PARTIALLY_RECEIVED (partial fulfilment, branch from RECEIVED)
Digest batch event (6-hour): DATE_CHANGE (fires before SHIPPED)
Exception events (terminal): PAYMENT_FAILED | OUT_OF_STOCK | SHIPPING_DELAYED | ADDRESS_INVALID | SYSTEM_ERROR

## RabbitMQ Topology
- Exchange: `tbx.events` (topic)
- Queue: `tbx.events.all` (bound to `order.#`)
- Queue: `tbx.events.exceptions` (bound to each exception routing key individually)
- Routing keys: `order.BOOKED`, `order.SHIPPED`, `order.RECEIVED`, `order.PARTIALLY_RECEIVED`, `order.DATE_CHANGE`, `order.PAYMENT_FAILED`, `order.OUT_OF_STOCK`, `order.SHIPPING_DELAYED`, `order.ADDRESS_INVALID`, `order.SYSTEM_ERROR`

## Environment Variables
See `.env.example` for all configurable values. Key ones: `RABBITMQ_URL`, `MONGODB_URL`, `SIMULATOR_ORDER_COUNT`, `SIMULATOR_INTERVAL_MS`, `SIMULATOR_EXCEPTION_RATE`, `SIMULATOR_DATE_CHANGE_RATE`, `SIMULATOR_PARTIAL_RECEIVE_RATE`, `API_PORT`, `POWER_AUTOMATE_WEBHOOK_URL`.

## ngrok (External Access)
The API runs on `localhost:3001` by default. ngrok creates a public HTTPS tunnel so Power Automate can reach it.
- Install: https://ngrok.com/docs/getting-started/
- Run: `ngrok http 3001`
- Inspect traffic: http://localhost:4040
- The free plan generates a new URL on each restart — update `.env` and Power Automate HTTP action accordingly
- Use a static domain (ngrok dashboard → Cloud Edge → Domains) to avoid URL changes

## Power Automate Integration
The API uses a webhook push pattern:
1. New event ingested from RabbitMQ
2. API POSTs to `POWER_AUTOMATE_WEBHOOK_URL` (the flow's HTTP trigger URL)
3. Power Automate wakes up and GETs `/api/events` via the ngrok URL
4. Flow writes events to SharePoint and sends email notifications

Set `POWER_AUTOMATE_WEBHOOK_URL` in `.env` to the HTTP POST URL from the Power Automate HTTP Request trigger.
Leave blank to disable webhook notifications (API still works normally).

## Conventions
- All source in `src/`, compiled output in `dist/`
- Single source system: `TBX-Oracle`
- In-memory event store (no database) -- this is a POC
- Events are stored newest-first in API responses
