# Changelog

All notable changes to the TBX Event Simulator are documented here.

---

## [1.1.0] — 2026-03-25

### Added

- **Webhook retry logic** — The API now retries failed Power Automate webhook
  calls up to 3 times with exponential back-off (1 s → 5 s → 15 s). Previously
  a single failure would silently drop the notification.

- **Webhook timeout** — Each webhook attempt is capped at 5 seconds via
  `AbortController`. Prevents a slow or unresponsive Power Automate endpoint
  from blocking event ingestion indefinitely.

- **API key authentication** — All `/api/*` endpoints now support an optional
  `x-api-key` header check. Set `API_KEY` in `.env` to enable. Leave blank to
  keep open access (default for POC use).

- **Dead-letter queue** — RabbitMQ is now configured with a dead-letter exchange
  (`tbx.events.dlx`) and dead-letter queue (`tbx.events.dead`). Messages that
  fail processing are routed there instead of being silently dropped.

### Fixed

- **Webhook ordering** — `notifyPowerAutomate()` is now `await`ed inside
  `ingestEvent()`, ensuring the webhook fires only after MongoDB has confirmed
  the write. Previously Power Automate could be triggered before the event was
  persisted and available via the API.

### Configuration

New environment variable added to `.env.example`:

| Variable  | Default | Description |
|-----------|---------|-------------|
| `API_KEY` | (blank) | Secret key required in `x-api-key` header for all `/api/*` requests. Leave blank to disable. |

### Migration Note

The dead-letter queue change modifies the `tbx.events.all` queue arguments. If
you have an existing queue running you must delete it before restarting:

1. Open **http://localhost:15672**
2. Go to **Queues** → `tbx.events.all`
3. Scroll to **Delete** and confirm
4. Restart the API — it will recreate the queue with the correct configuration

---

## [1.0.0] — 2026-03-25

### Initial Release

- Event Simulator generating TBX Oracle order lifecycle events
- RabbitMQ topic exchange (`tbx.events`) with routing keys per status
- REST API (Express) consuming events from RabbitMQ
- MongoDB persistence — events survive API restarts, order cache rebuilt on startup
- ngrok tunnel exposing `localhost:3001` publicly for Power Automate access
- Webhook push to Power Automate HTTP trigger URL on each new event
- Power Automate integration — writes events to SharePoint, sends email notifications
- Architecture aligned with AT&T TBX Oracle event specification confirmed by Barry Hammon

### Event Types (aligned with AT&T TBX Oracle specification)

**Core milestone events (real-time):**
`BOOKED` · `SHIPPED` · `RECEIVED` · `PARTIALLY_RECEIVED`

**Digest batch event (6-hour intervals):**
`DATE_CHANGE`

**Exception events:**
`PAYMENT_FAILED` · `OUT_OF_STOCK` · `SHIPPING_DELAYED` · `ADDRESS_INVALID` · `SYSTEM_ERROR`
