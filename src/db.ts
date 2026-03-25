// ---------------------------------------------------------------------------
// AT&T TBX Event Simulator - MongoDB Connection & Schema
// ---------------------------------------------------------------------------
// Provides persistent storage for order events using MongoDB.
// Replaces the in-memory store in api.ts so events survive API restarts.
// ---------------------------------------------------------------------------

import mongoose, { Schema, Document, Model } from "mongoose";
import { OrderEvent, OrderStatus } from "./types";

// --- Connection ------------------------------------------------------------

export async function connectDB(): Promise<void> {
  const url = process.env.MONGODB_URL ?? "mongodb://localhost:27017/tbx";

  mongoose.connection.on("connected", () =>
    console.log(`[db] Connected to MongoDB at ${url}`)
  );
  mongoose.connection.on("error", (err) =>
    console.error("[db] MongoDB error:", err)
  );

  await mongoose.connect(url);
}

export async function disconnectDB(): Promise<void> {
  await mongoose.disconnect();
  console.log("[db] Disconnected from MongoDB");
}

// --- Event Schema ----------------------------------------------------------

export interface OrderEventDocument extends OrderEvent, Document {}

const LineItemSchema = new Schema(
  {
    sku:         { type: String, required: true },
    description: { type: String, required: true },
    quantity:    { type: Number, required: true },
    unitPrice:   { type: Number, required: true },
  },
  { _id: false }
);

const OrderEventSchema = new Schema<OrderEventDocument>(
  {
    eventId:      { type: String, required: true, unique: true, index: true },
    orderId:      { type: String, required: true, index: true },
    status:       { type: String, required: true, enum: Object.values(OrderStatus), index: true },
    timestamp:    { type: String, required: true },
    source:       { type: String, required: true },
    customerId:   { type: String, required: true, index: true },
    customerName: { type: String, required: true },
    lineItems:    { type: [LineItemSchema], default: [] },
    metadata:     { type: Map, of: String, default: {} },

    // BOOKED fields
    poNumber:    String,
    quoteNumber: String,
    orderTotal:  Number,

    // SHIPPED fields
    trackingNumber:        String,
    carrier:               String,
    serialNumbers:         [String],
    estimatedShipDate:     String,
    estimatedDeliveryDate: String,

    // RECEIVED / PARTIALLY_RECEIVED fields
    receiptDate:       String,
    receivedQuantity:  Number,
    confirmedQuantity: Number,

    // DATE_CHANGE fields
    previousEstimatedShipDate:    String,
    newEstimatedShipDate:         String,
    previousEstimatedArrivalDate: String,
    newEstimatedArrivalDate:      String,

    // Exception fields
    exceptionDetail: String,
    exceptionCode:   String,
  },
  {
    timestamps: false,
    versionKey: false,
  }
);

export const EventModel: Model<OrderEventDocument> =
  mongoose.models.OrderEvent ??
  mongoose.model<OrderEventDocument>("OrderEvent", OrderEventSchema);
