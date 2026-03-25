// ---------------------------------------------------------------------------
// RabbitMQ Connection & Channel Manager
// ---------------------------------------------------------------------------

import amqplib from "amqplib";
import type { Channel } from "amqplib";
import {
  EXCHANGE_NAME,
  QUEUE_ALL,
  QUEUE_EXCEPTIONS,
  ROUTING_KEY_PREFIX,
  EXCEPTION_STATUSES,
  OrderEvent,
} from "./types";

const RABBITMQ_URL = process.env.RABBITMQ_URL ?? "amqp://tbx_user:tbx_pass@localhost:5672/tbx";
const DLX_NAME     = "tbx.events.dlx";
const DLQ_NAME     = "tbx.events.dead";

let connModel: Awaited<ReturnType<typeof amqplib.connect>> | null = null;
let channel: Channel | null = null;

/**
 * Connect to RabbitMQ, declare the topic exchange, and bind queues.
 * Retries up to `maxRetries` times with exponential back-off.
 */
export async function connect(maxRetries = 10): Promise<Channel> {
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    try {
      console.log(`[rabbitmq] Connecting (attempt ${attempt}/${maxRetries})...`);
      connModel = await amqplib.connect(RABBITMQ_URL);
      const ch = await connModel.createChannel();
      channel = ch;

      // Declare a topic exchange so consumers can filter by routing key
      await ch.assertExchange(EXCHANGE_NAME, "topic", { durable: true });

      // Dead-letter exchange and queue — receives messages rejected by nack
      await ch.assertExchange(DLX_NAME, "fanout", { durable: true });
      await ch.assertQueue(DLQ_NAME, { durable: true });
      await ch.bindQueue(DLQ_NAME, DLX_NAME, "");

      // Queue that receives ALL events (routes failures to DLX instead of dropping)
      await ch.assertQueue(QUEUE_ALL, {
        durable: true,
        arguments: { "x-dead-letter-exchange": DLX_NAME },
      });
      await ch.bindQueue(QUEUE_ALL, EXCHANGE_NAME, `${ROUTING_KEY_PREFIX}.#`);

      // Queue that receives exception events (one binding per exception status)
      await ch.assertQueue(QUEUE_EXCEPTIONS, { durable: true });
      for (const status of EXCEPTION_STATUSES) {
        await ch.bindQueue(QUEUE_EXCEPTIONS, EXCHANGE_NAME, `${ROUTING_KEY_PREFIX}.${status}`);
      }

      console.log("[rabbitmq] Connected and topology ready.");
      return ch;
    } catch (err) {
      console.error(`[rabbitmq] Attempt ${attempt} failed:`, (err as Error).message);
      if (attempt === maxRetries) throw err;
      const delay = Math.min(1000 * 2 ** attempt, 30_000);
      await new Promise((r) => setTimeout(r, delay));
    }
  }
  throw new Error("Unreachable");
}

/** Publish an OrderEvent to the topic exchange. */
export async function publishEvent(event: OrderEvent): Promise<void> {
  if (!channel) throw new Error("RabbitMQ channel not initialized. Call connect() first.");
  const routingKey = `${ROUTING_KEY_PREFIX}.${event.status}`;
  const payload = Buffer.from(JSON.stringify(event));
  channel.publish(EXCHANGE_NAME, routingKey, payload, {
    persistent: true,
    contentType: "application/json",
    timestamp: Date.now(),
    messageId: event.eventId,
  });
}

/** Subscribe to a queue, invoking `handler` for each message. */
export async function subscribe(
  queue: string,
  handler: (event: OrderEvent) => void | Promise<void>
): Promise<void> {
  if (!channel) throw new Error("RabbitMQ channel not initialized. Call connect() first.");
  await channel.consume(queue, async (msg) => {
    if (!msg) return;
    try {
      const event: OrderEvent = JSON.parse(msg.content.toString());
      await handler(event);
      channel!.ack(msg);
    } catch (err) {
      console.error("[rabbitmq] Message processing failed:", err);
      channel!.nack(msg, false, false);
    }
  });
}

/** Graceful shutdown. */
export async function disconnect(): Promise<void> {
  try {
    await channel?.close();
    await connModel?.close();
    console.log("[rabbitmq] Disconnected.");
  } catch {
    // swallow errors during shutdown
  }
}
