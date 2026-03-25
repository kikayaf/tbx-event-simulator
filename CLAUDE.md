# TBX Order Event Simulator

## What This Is
A proof-of-concept that simulates TBX Oracle order events flowing through RabbitMQ and exposed via a REST API. This is NOT connected to any real AT&T systems. The simulator generates fake but realistic order lifecycle events.

## Architecture
- **Event Simulator** (`src/simulator.ts`) -- Generates order events and publishes to RabbitMQ
- **RabbitMQ** -- Message broker using a topic exchange (`tbx.events`) with routing keys per status
- **REST API** (`src/api.ts`) -- Express server that consumes events from RabbitMQ and serves them via REST endpoints
- **Shared types** (`src/types.ts`) -- Event schema, order model, status enum, RabbitMQ constants
- **RabbitMQ client** (`src/rabbitmq.ts`) -- Connection manager with retry logic, publish/subscribe helpers

## Tech Stack
- TypeScript, Node.js 20+
- Express (REST API)
- amqplib (RabbitMQ client)
- dotenv (environment variable loading from `.env`)
- Docker Compose (RabbitMQ + app containers)

## Running
```bash
# Full stack via Docker
docker compose up --build

# Local dev (RabbitMQ in Docker, app code native)
cp .env.example .env          # configure API_PORT etc.
docker compose up rabbitmq -d
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
See `.env.example` for all configurable values. Key ones: `RABBITMQ_URL`, `SIMULATOR_ORDER_COUNT`, `SIMULATOR_INTERVAL_MS`, `SIMULATOR_EXCEPTION_RATE`, `SIMULATOR_DATE_CHANGE_RATE`, `SIMULATOR_PARTIAL_RECEIVE_RATE`, `API_PORT`.

## Conventions
- All source in `src/`, compiled output in `dist/`
- Single source system: `TBX-Oracle`
- In-memory event store (no database) -- this is a POC
- Events are stored newest-first in API responses
