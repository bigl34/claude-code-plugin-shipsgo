#!/usr/bin/env npx tsx
/**
 * ShipsGo Container Tracker CLI
 *
 * Zod-validated CLI for ocean container tracking.
 */

import { z, createCommand, runCli, cacheCommands, cliTypes } from "@local/cli-utils";
import { ShipsGoClient, ShipmentCreateRequest } from "./shipsgo-client.js";

// ISO 6346 container number format: 4 letters + 7 digits (e.g., MRKU4569299)
const containerRegex = /^[A-Z]{4}\d{7}$/i;

// Define commands with Zod schemas
const commands = {
  "list-tools": createCommand(
    z.object({}),
    async (_args, client: ShipsGoClient) => client.getTools(),
    "List all available commands"
  ),

  // ==================== Shipment Management ====================
  "create-shipment": createCommand(
    z.object({
      bl: z.string().trim().min(1).optional().describe("Bill of Lading number"),
      container: z.string().trim().min(1)
        .refine(val => containerRegex.test(val), {
          message: "Container format invalid (expected: 4 letters + 7 digits, e.g., MRKU4569299)"
        })
        .optional()
        .describe("Container number (ISO 6346 format)"),
      booking: z.string().trim().min(1).optional().describe("Booking number"),
      reference: z.string().trim().min(1).optional().describe("Custom reference (e.g., SO-12345)"),
    }).refine(
      (data) => Boolean(data.bl || data.container || data.booking),
      { message: "At least one of --bl, --container, or --booking is required" }
    ),
    async (args, client: ShipsGoClient) => {
      const { bl, container, booking, reference } = args as {
        bl?: string; container?: string; booking?: string; reference?: string;
      };

      // Build flat request structure (API requires fields at root level, not nested)
      const request: ShipmentCreateRequest = {
        shipment_type: "ocean",
        ...(bl && { bl_number: bl }),
        ...(container && { container_number: container }),
        ...(booking && { booking_number: booking }),
      };

      const result = await client.createShipment(request, reference);

      // Surface warning if present (non-fatal, e.g., PATCH failure)
      if (result.warning) {
        console.error(`Warning: ${result.warning}`);
      }

      return result;
    },
    "Create/track a new shipment (1 credit if new)"
  ),

  "get-shipment": createCommand(
    z.object({
      id: z.string().min(1).describe("ShipsGo shipment ID"),
    }),
    async (args, client: ShipsGoClient) => {
      const { id } = args as { id: string };
      return client.getShipmentById(id);
    },
    "Get shipment by ID"
  ),

  "list-shipments": createCommand(
    z.object({
      status: z.string().optional().describe("Filter: PENDING, EN_ROUTE, ARRIVED, DELIVERED"),
      limit: cliTypes.int(1, 1000).optional().describe("Max results"),
      offset: cliTypes.int(0).optional().describe("Pagination offset"),
      etaFrom: z.string().optional().describe("ETA range start (YYYY-MM-DD)"),
      etaTo: z.string().optional().describe("ETA range end"),
      sort: z.string().optional().describe("Sort by: eta, created_at, updated_at"),
      order: z.enum(["asc", "desc"]).optional().describe("Sort direction"),
    }),
    async (args, client: ShipsGoClient) => {
      const { status, limit, offset, etaFrom, etaTo, sort, order } = args as {
        status?: string; limit?: number; offset?: number;
        etaFrom?: string; etaTo?: string; sort?: string; order?: "asc" | "desc";
      };
      return client.listShipments({
        status, limit, offset,
        eta_from: etaFrom,
        eta_to: etaTo,
        sort, order,
      });
    },
    "List all shipments with filters"
  ),

  // ==================== Tracking Queries ====================
  "track-bl": createCommand(
    z.object({
      number: z.string().min(1).describe("BL number to track"),
    }),
    async (args, client: ShipsGoClient) => {
      const { number } = args as { number: string };
      if (!client.validateBLNumber(number)) {
        console.error("Warning: BL number format may be invalid (expected: 4 letters + 8-12 digits)");
      }
      const result = await client.trackByBL(number);
      return result || { found: false, message: `No shipment found for BL: ${number}` };
    },
    "Track by Bill of Lading"
  ),

  "track-container": createCommand(
    z.object({
      number: z.string().min(1).describe("Container number to track"),
    }),
    async (args, client: ShipsGoClient) => {
      const { number } = args as { number: string };
      if (!client.validateContainerNumber(number)) {
        console.error("Warning: Container number format may be invalid (expected: 4 letters + 7 digits)");
      }
      const result = await client.trackByContainer(number);
      return result || { found: false, message: `No shipment found for container: ${number}` };
    },
    "Track by container number"
  ),

  "track-booking": createCommand(
    z.object({
      number: z.string().min(1).describe("Booking number to track"),
    }),
    async (args, client: ShipsGoClient) => {
      const { number } = args as { number: string };
      const result = await client.trackByBooking(number);
      return result || { found: false, message: `No shipment found for booking: ${number}` };
    },
    "Track by booking number"
  ),

  "search": createCommand(
    z.object({
      query: z.string().min(1).describe("Reference to search"),
    }),
    async (args, client: ShipsGoClient) => {
      const { query } = args as { query: string };
      const shipments = await client.searchByReference(query);
      return { shipments, count: shipments.length };
    },
    "Search by any reference"
  ),

  // ==================== Monitoring ====================
  "active": createCommand(
    z.object({}),
    async (_args, client: ShipsGoClient) => {
      const shipments = await client.getActiveShipments();
      return { shipments, count: shipments.length };
    },
    "List all active (in-transit) shipments"
  ),

  "arriving-soon": createCommand(
    z.object({
      days: cliTypes.int(1, 365).optional().describe("Days ahead (default: 7)"),
    }),
    async (args, client: ShipsGoClient) => {
      const { days = 7 } = args as { days?: number };
      const shipments = await client.getArrivingSoon(days);
      return { shipments, count: shipments.length, daysAhead: days };
    },
    "Shipments arriving within N days"
  ),

  "milestones": createCommand(
    z.object({
      id: z.string().min(1).describe("Shipment ID"),
    }),
    async (args, client: ShipsGoClient) => {
      const { id } = args as { id: string };
      const milestones = await client.getMilestones(id);
      return { milestones, count: milestones.length };
    },
    "Get tracking milestones"
  ),

  "vessel-position": createCommand(
    z.object({
      id: z.string().min(1).describe("Shipment ID"),
    }),
    async (args, client: ShipsGoClient) => {
      const { id } = args as { id: string };
      const position = await client.getVesselPosition(id);
      return position || { found: false, message: "No position data available for this shipment" };
    },
    "Get live vessel coordinates"
  ),

  // ==================== Utilities ====================
  "api-status": createCommand(
    z.object({}),
    async (_args, client: ShipsGoClient) => client.getApiStatus(),
    "Check API connectivity and auth"
  ),

  "rate-limit": createCommand(
    z.object({}),
    async (_args, client: ShipsGoClient) => client.getRateLimitStatus(),
    "Show rate limit status"
  ),

  "refresh-shipment": createCommand(
    z.object({
      id: z.string().min(1).describe("Shipment ID to refresh"),
    }),
    async (args, client: ShipsGoClient) => {
      const { id } = args as { id: string };
      client.invalidateShipment(id);
      client.disableCache();
      return client.getShipmentById(id);
    },
    "Force re-poll shipment, bypass cache"
  ),

  "get-sharing-link": createCommand(
    z.object({
      id: z.string().min(1).describe("Shipment ID"),
    }),
    async (args, client: ShipsGoClient) => {
      const { id } = args as { id: string };
      const result = await client.getSharingLink(id);

      if (!result) {
        // Match existing pattern: return object with found: false
        return {
          found: false,
          message: `No sharing link available for shipment ${id}. The shipment may not exist or the map token is not yet assigned.`
        };
      }

      return {
        found: true,
        sharingLink: result.url,
        shipmentId: result.shipmentId,
        containerNumber: result.containerNumber,
        status: result.status,
        route: result.pol && result.pod ? `${result.pol} → ${result.pod}` : null,
        eta: result.eta,
      };
    },
    "Get a shareable public tracking link for a shipment"
  ),

  // Pre-built cache commands (with custom invalidate)
  "cache-stats": createCommand(
    z.object({}),
    async (_args, client: ShipsGoClient) => client.getCacheStats(),
    "Show cache statistics"
  ),

  "cache-clear": createCommand(
    z.object({}),
    async (_args, client: ShipsGoClient) => {
      const cleared = client.clearCache();
      return { success: true, entriesCleared: cleared };
    },
    "Clear all cached data"
  ),

  "cache-invalidate": createCommand(
    z.object({
      id: z.string().min(1).describe("Shipment ID to invalidate"),
    }),
    async (args, client: ShipsGoClient) => {
      const { id } = args as { id: string };
      const invalidated = client.invalidateShipment(id);
      return { success: invalidated, id };
    },
    "Invalidate specific shipment"
  ),
};

// Run CLI
runCli(commands, ShipsGoClient, {
  programName: "shipsgo-cli",
  description: "ShipsGo ocean container tracking",
});
