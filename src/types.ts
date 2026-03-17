// ---------------------------------------------------------------------------
// AT&T TBX Event Simulator - Type Definitions
// ---------------------------------------------------------------------------
// Simulates a TBX Oracle order management system emitting lifecycle events:
//   Quote -> Order Created -> Order Confirmed -> Provisioning Started ->
//   Shipped -> Delivered  (with error/exception branches)
// ---------------------------------------------------------------------------

export enum OrderStatus {
  QUOTE_CREATED       = "QUOTE_CREATED",
  QUOTE_APPROVED      = "QUOTE_APPROVED",
  ORDER_CREATED       = "ORDER_CREATED",
  ORDER_CONFIRMED     = "ORDER_CONFIRMED",
  PROVISIONING_STARTED = "PROVISIONING_STARTED",
  PROVISIONING_COMPLETE = "PROVISIONING_COMPLETE",
  SHIPPED             = "SHIPPED",
  DELIVERED           = "DELIVERED",
  CANCELLED           = "CANCELLED",
  ERROR               = "ERROR",
}

/** The ordered progression for a happy-path order. */
export const HAPPY_PATH: OrderStatus[] = [
  OrderStatus.QUOTE_CREATED,
  OrderStatus.QUOTE_APPROVED,
  OrderStatus.ORDER_CREATED,
  OrderStatus.ORDER_CONFIRMED,
  OrderStatus.PROVISIONING_STARTED,
  OrderStatus.PROVISIONING_COMPLETE,
  OrderStatus.SHIPPED,
  OrderStatus.DELIVERED,
];

export interface OrderEvent {
  eventId: string;
  orderId: string;
  status: OrderStatus;
  timestamp: string;          // ISO 8601
  source: string;             // originating system (e.g. "TBX-Oracle")
  customerId: string;
  customerName: string;
  lineItems: LineItem[];
  metadata: Record<string, string>;
  errorDetail?: string;       // populated only when status === ERROR
}

export interface LineItem {
  sku: string;
  description: string;
  quantity: number;
  unitPrice: number;
}

export interface Order {
  orderId: string;
  customerId: string;
  customerName: string;
  currentStatus: OrderStatus;
  lineItems: LineItem[];
  events: OrderEvent[];
  createdAt: string;
  updatedAt: string;
}

// RabbitMQ topology constants
export const EXCHANGE_NAME  = "tbx.events";
export const QUEUE_ALL      = "tbx.events.all";
export const QUEUE_ERRORS   = "tbx.events.errors";
export const ROUTING_KEY_PREFIX = "order";
