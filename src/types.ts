// ---------------------------------------------------------------------------
// AT&T TBX Event Simulator - Type Definitions
// ---------------------------------------------------------------------------
// Models the event types emitted by TBX Oracle via RabbitMQ as documented
// in the AT&T discovery docs, architecture files, and technical spec
// (confirmed by Barry Hammon).
//
// Core Milestone Events (real-time):
//   BOOKED -> SHIPPED -> RECEIVED  (happy path)
//   PARTIALLY_RECEIVED             (branch: partial fulfillment)
//
// Digest Batch Events (6-hour intervals):
//   DATE_CHANGE                    (estimated ship/arrival date updates)
//
// Exception Events:
//   PAYMENT_FAILED | OUT_OF_STOCK | SHIPPING_DELAYED
//   ADDRESS_INVALID | SYSTEM_ERROR
// ---------------------------------------------------------------------------

export enum OrderStatus {
  // Core milestone events (real-time)
  BOOKED             = "BOOKED",
  SHIPPED            = "SHIPPED",
  RECEIVED           = "RECEIVED",
  PARTIALLY_RECEIVED = "PARTIALLY_RECEIVED",

  // Digest batch event (6-hour intervals)
  DATE_CHANGE        = "DATE_CHANGE",

  // Exception events (from downstream automation diagram)
  PAYMENT_FAILED     = "PAYMENT_FAILED",
  OUT_OF_STOCK       = "OUT_OF_STOCK",
  SHIPPING_DELAYED   = "SHIPPING_DELAYED",
  ADDRESS_INVALID    = "ADDRESS_INVALID",
  SYSTEM_ERROR       = "SYSTEM_ERROR",
}

/** Happy-path milestone progression. */
export const HAPPY_PATH: OrderStatus[] = [
  OrderStatus.BOOKED,
  OrderStatus.SHIPPED,
  OrderStatus.RECEIVED,
];

/** All exception statuses — used to bind the exceptions queue and filter stats. */
export const EXCEPTION_STATUSES: OrderStatus[] = [
  OrderStatus.PAYMENT_FAILED,
  OrderStatus.OUT_OF_STOCK,
  OrderStatus.SHIPPING_DELAYED,
  OrderStatus.ADDRESS_INVALID,
  OrderStatus.SYSTEM_ERROR,
];

export interface OrderEvent {
  eventId:      string;
  orderId:      string;
  status:       OrderStatus;
  timestamp:    string;           // ISO 8601
  source:       string;           // originating system ("TBX-Oracle")
  customerId:   string;
  customerName: string;
  lineItems:    LineItem[];
  metadata:     Record<string, string>;

  // BOOKED fields — full order metadata: POs, quotes, totals
  poNumber?:    string;
  quoteNumber?: string;
  orderTotal?:  number;

  // SHIPPED / ASN fields — tracking, carrier, serial numbers, ETAs
  trackingNumber?:       string;
  carrier?:              string;
  serialNumbers?:        string[];
  estimatedShipDate?:    string;
  estimatedDeliveryDate?: string;

  // RECEIVED / PARTIALLY_RECEIVED fields
  receiptDate?:       string;
  receivedQuantity?:  number;
  confirmedQuantity?: number;

  // DATE_CHANGE fields — 6-hour digest batch
  previousEstimatedShipDate?:    string;
  newEstimatedShipDate?:         string;
  previousEstimatedArrivalDate?: string;
  newEstimatedArrivalDate?:      string;

  // Exception fields
  exceptionDetail?: string;
  exceptionCode?:   string;
}

export interface LineItem {
  sku:        string;
  description: string;
  quantity:   number;
  unitPrice:  number;
}

export interface Order {
  orderId:       string;
  customerId:    string;
  customerName:  string;
  currentStatus: OrderStatus;
  lineItems:     LineItem[];
  events:        OrderEvent[];
  createdAt:     string;
  updatedAt:     string;
}

// RabbitMQ topology constants
export const EXCHANGE_NAME       = "tbx.events";
export const QUEUE_ALL           = "tbx.events.all";
export const QUEUE_EXCEPTIONS    = "tbx.events.exceptions";
export const ROUTING_KEY_PREFIX  = "order";
