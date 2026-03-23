/**
 * ShipsGo Container Tracking API Client
 *
 * Direct client using native fetch for ShipsGo API v2.
 * Reads configuration from config.json (symlinked to tmpfs).
 */

import { readFileSync, writeFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// Request timeout for API calls (30 seconds)
const REQUEST_TIMEOUT_MS = 30_000;

// === Configuration ===
interface ShipsGoConfig {
  shipsgo: {
    apiKey: string;
    baseUrl: string;
  };
}

// === Internal Types (stable, used by CLI) ===
// NOTE: API requires FLAT structure, NOT nested reference_numbers
export interface ShipmentCreateRequest {
  shipment_type: "ocean";
  bl_number?: string;
  container_number?: string;
  booking_number?: string;
}

export interface ShipmentUpdateRequest {
  reference?: string;
}

export interface Shipment {
  id: string;
  requestId?: string;
  status: "PENDING" | "EN_ROUTE" | "ARRIVED" | "DELIVERED" | "DISCARDED" | "NOT_FOUND";
  container_number?: string;
  bl_number?: string;
  booking_number?: string;
  carrier?: string;
  vessel?: { name: string; imo?: string };
  pol?: { code: string; name: string; departure?: string };
  pod?: { code: string; name: string; eta?: string; ata?: string };
  milestones?: Milestone[];
  coordinates?: { lat: number; lng: number };
  co2_emissions?: number;
  created_at: string;
  updated_at: string;
  discarded_at?: string;
  custom_reference?: string;
}

export interface Milestone {
  event: string;
  location?: string;
  timestamp: string;
  is_actual: boolean;
}

export interface ListOptions {
  status?: string;
  limit?: number;
  offset?: number;
  eta_from?: string;
  eta_to?: string;
  sort?: string;
  order?: "asc" | "desc";
}

export interface CreateResult {
  shipment: Shipment;
  source: "created" | "existing" | "cache";
  creditUsed: boolean;
  warning?: string;  // Non-fatal issues (e.g., PATCH failure for custom reference)
}

export interface SharingLinkResult {
  url: string;
  shipmentId: string;
  containerNumber: string | undefined;
  status: string;
  pol: string | undefined;
  pod: string | undefined;
  eta: string | undefined;
}

// === Rate Limiting ===
interface RateLimitData {
  serverRemaining?: number;
  serverLimit?: number;
  serverResetAt?: number;
  lastServerUpdate?: number;
  localCalls: number[];
}

export interface RateLimitStatus {
  remaining: number;
  limit: number;
  resetAt?: Date;
  localCallCount: number;
  warning?: string;
}

// === Error Types ===
export class ApiError extends Error {
  constructor(public status: number, public data: unknown) {
    super(`API Error ${status}: ${JSON.stringify(data)}`);
    this.name = "ApiError";
  }
}

export class RateLimitError extends Error {
  constructor(public retryAfter?: number) {
    super(`Rate limited${retryAfter ? `, retry after ${retryAfter}s` : ""}`);
    this.name = "RateLimitError";
  }
}

export class InsufficientCreditsError extends Error {
  constructor(message?: string) {
    super(message || "Insufficient credits");
    this.name = "InsufficientCreditsError";
  }
}

// Initialize cache with namespace
const cache = new PluginCache({
  namespace: "shipsgo-container-tracker",
  defaultTTL: TTL.HOUR,
});

export class ShipsGoClient {
  private config: ShipsGoConfig;
  private cacheDisabled: boolean = false;
  private rateLimitFile: string;

  constructor() {
    const configPath = join(__dirname, "..", "config.json");
    this.config = JSON.parse(readFileSync(configPath, "utf-8"));
    this.rateLimitFile = join(__dirname, ".ratelimit.json");

    if (!this.config.shipsgo?.apiKey) {
      throw new Error("Missing required config in config.json: shipsgo.apiKey");
    }
  }

  // ============================================
  // CACHE CONTROL
  // ============================================

  /** Disables caching for all subsequent requests. */
  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  /** Re-enables caching after it was disabled. */
  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  /** Returns cache statistics including hit/miss counts. */
  getCacheStats() {
    return cache.getStats();
  }

  /** Clears all cached data. @returns Number of cache entries cleared */
  clearCache(): number {
    return cache.clear();
  }

  /**
   * Invalidates cached data for a specific shipment.
   *
   * @param id - Shipment ID to invalidate
   * @returns True if any entry was found and removed
   */
  invalidateShipment(id: string): boolean {
    const shipmentInvalidated = cache.invalidate(createCacheKey("shipment:id", { id }));
    const sharingLinkInvalidated = cache.invalidate(createCacheKey("sharing-link", { id }));
    return shipmentInvalidated || sharingLinkInvalidated;
  }

  // ============================================
  // RATE LIMITING
  // ============================================

  private loadRateLimitData(): RateLimitData {
    try {
      if (existsSync(this.rateLimitFile)) {
        return JSON.parse(readFileSync(this.rateLimitFile, "utf-8"));
      }
    } catch {
      // Ignore parse errors
    }
    return { localCalls: [] };
  }

  private saveRateLimitData(data: RateLimitData): void {
    try {
      writeFileSync(this.rateLimitFile, JSON.stringify(data, null, 2));
    } catch {
      // Ignore write errors
    }
  }

  private updateRateLimitFromResponse(response: Response): void {
    const data = this.loadRateLimitData();

    const remaining = response.headers.get("X-RateLimit-Remaining");
    const limit = response.headers.get("X-RateLimit-Limit");
    const reset = response.headers.get("X-RateLimit-Reset") || response.headers.get("Retry-After");

    if (remaining) data.serverRemaining = parseInt(remaining, 10);
    if (limit) data.serverLimit = parseInt(limit, 10);
    if (reset) {
      // Could be epoch seconds or seconds from now
      const resetVal = parseInt(reset, 10);
      data.serverResetAt = resetVal > 1e10 ? resetVal : Date.now() + resetVal * 1000;
    }
    data.lastServerUpdate = Date.now();

    // Track locally as backup
    data.localCalls.push(Date.now());
    data.localCalls = data.localCalls.filter(t => t > Date.now() - 60_000);

    this.saveRateLimitData(data);
  }

  /**
   * Gets current rate limit status.
   *
   * Uses server-reported headers when available, falls back to local tracking.
   * Warning issued when approaching limit (< 20 remaining).
   *
   * @returns Rate limit info including remaining calls and reset time
   */
  getRateLimitStatus(): RateLimitStatus {
    const data = this.loadRateLimitData();
    const hasRecentServerData = data.lastServerUpdate && (Date.now() - data.lastServerUpdate) < 60_000;

    if (hasRecentServerData && data.serverRemaining !== undefined) {
      return {
        remaining: data.serverRemaining,
        limit: data.serverLimit ?? 100,
        resetAt: data.serverResetAt ? new Date(data.serverResetAt) : undefined,
        localCallCount: data.localCalls.length,
        warning: data.serverRemaining < 20 ? "Approaching rate limit" : undefined,
      };
    }

    const localRemaining = Math.max(0, 100 - data.localCalls.length);
    return {
      remaining: localRemaining,
      limit: 100,
      localCallCount: data.localCalls.length,
      warning: localRemaining < 20 ? "Approaching rate limit (estimated)" : undefined,
    };
  }

  // === HTTP Helpers ===
  private async request<T>(
    method: string,
    endpoint: string,
    body?: unknown
  ): Promise<{ data: T; response: Response }> {
    const url = `${this.config.shipsgo.baseUrl}${endpoint}`;

    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      "X-Shipsgo-User-Token": this.config.shipsgo.apiKey,
    };

    // Set up timeout with AbortController
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

    const options: RequestInit = {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    };

    try {
      const response = await fetch(url, options);
      this.updateRateLimitFromResponse(response);

      if (response.status === 429) {
        const retryAfter = response.headers.get("Retry-After");
        throw new RateLimitError(retryAfter ? parseInt(retryAfter, 10) : undefined);
      }

      if (response.status === 402) {
        const errorData = await response.json().catch(() => ({}));
        throw new InsufficientCreditsError((errorData as { message?: string })?.message);
      }

      const data = await response.json().catch(() => ({})) as T;
      return { data, response };
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error(`ShipsGo API request timed out after ${REQUEST_TIMEOUT_MS / 1000}s`);
      }
      throw error;
    } finally {
      clearTimeout(timeoutId);
    }
  }

  private async fetchWithRetry<T>(
    fn: () => Promise<T>,
    options: { maxRetries: number; baseDelay: number } = { maxRetries: 3, baseDelay: 1000 }
  ): Promise<T> {
    let lastError: Error | null = null;

    for (let attempt = 0; attempt <= options.maxRetries; attempt++) {
      try {
        return await fn();
      } catch (error) {
        lastError = error as Error;

        // Don't retry client errors (4xx except 429)
        if (error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429) {
          throw error;
        }

        // Don't retry on last attempt
        if (attempt === options.maxRetries) {
          break;
        }

        // Calculate delay with exponential backoff + jitter
        let delay = options.baseDelay * Math.pow(2, attempt) + Math.random() * 500;

        // Use Retry-After if available
        if (error instanceof RateLimitError && error.retryAfter) {
          delay = error.retryAfter * 1000;
        }

        await this.sleep(delay);
      }
    }

    throw lastError ?? new Error("Max retries exceeded");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  // === Type Mapping ===
  private mapToShipment(raw: Record<string, unknown>): Shipment {
    // Map from raw API response to internal Shipment type
    // The exact mapping depends on ShipsGo's actual response format
    const shipment: Shipment = {
      id: String(raw.id || raw.requestId || ""),
      requestId: raw.requestId ? String(raw.requestId) : undefined,
      status: this.mapStatus(raw.status as string || raw.shippingStatus as string),
      container_number: raw.containerNumber as string || raw.container_number as string,
      bl_number: raw.blNumber as string || raw.bl_number as string,
      booking_number: raw.bookingNumber as string || raw.booking_number as string,
      carrier: raw.carrier as string || raw.shippingLine as string,
      created_at: raw.createdAt as string || raw.created_at as string || new Date().toISOString(),
      updated_at: raw.updatedAt as string || raw.updated_at as string || new Date().toISOString(),
      custom_reference: raw.customReference as string || raw.custom_reference as string,
    };

    // Map vessel
    if (raw.vessel || raw.vesselName) {
      shipment.vessel = {
        name: (raw.vessel as { name?: string })?.name || raw.vesselName as string || "",
        imo: (raw.vessel as { imo?: string })?.imo || raw.vesselImo as string,
      };
    }

    // Map POL (Port of Loading)
    if (raw.pol || raw.portOfLoading) {
      const pol = raw.pol as Record<string, unknown> || {};
      shipment.pol = {
        code: pol.code as string || raw.polCode as string || "",
        name: pol.name as string || raw.portOfLoading as string || "",
        departure: pol.departure as string || raw.etd as string || raw.atd as string,
      };
    }

    // Map POD (Port of Discharge)
    if (raw.pod || raw.portOfDischarge) {
      const pod = raw.pod as Record<string, unknown> || {};
      shipment.pod = {
        code: pod.code as string || raw.podCode as string || "",
        name: pod.name as string || raw.portOfDischarge as string || "",
        eta: pod.eta as string || raw.eta as string,
        ata: pod.ata as string || raw.ata as string,
      };
    }

    // Map milestones
    if (Array.isArray(raw.milestones) || Array.isArray(raw.events)) {
      const events = (raw.milestones || raw.events) as Array<Record<string, unknown>>;
      shipment.milestones = events.map(e => ({
        event: e.event as string || e.description as string || "",
        location: e.location as string,
        timestamp: e.timestamp as string || e.date as string || "",
        is_actual: Boolean(e.isActual ?? e.is_actual ?? true),
      }));
    }

    // Map coordinates
    if (raw.coordinates || (raw.latitude && raw.longitude)) {
      const coords = raw.coordinates as Record<string, number> || {};
      shipment.coordinates = {
        lat: coords.lat || coords.latitude || raw.latitude as number,
        lng: coords.lng || coords.longitude || raw.longitude as number,
      };
    }

    if (raw.discardedAt || raw.discarded_at) {
      shipment.discarded_at = raw.discardedAt as string || raw.discarded_at as string;
    }

    return shipment;
  }

  private mapStatus(status: string): Shipment["status"] {
    if (!status) return "PENDING";
    const normalized = status.toUpperCase().replace(/[^A-Z_]/g, "_");
    const statusMap: Record<string, Shipment["status"]> = {
      "PENDING": "PENDING",
      "INPROGRESS": "EN_ROUTE",
      "IN_PROGRESS": "EN_ROUTE",
      "IN_TRANSIT": "EN_ROUTE",
      "EN_ROUTE": "EN_ROUTE",
      "DISCHARGED": "ARRIVED",
      "ARRIVED": "ARRIVED",
      "DELIVERED": "DELIVERED",
      "DISCARDED": "DISCARDED",
      "NOT_FOUND": "NOT_FOUND",
    };
    return statusMap[normalized] || "PENDING";
  }

  private getCacheTTL(shipment: Shipment): number {
    switch (shipment.status) {
      case "PENDING":
      case "EN_ROUTE":
        return TTL.HOUR * 2;
      case "ARRIVED":
        return TTL.HOUR * 4;
      case "DELIVERED":
      case "DISCARDED":
        return TTL.DAY;
      default:
        return TTL.HOUR * 2;
    }
  }

  private buildCacheKey(data: ShipmentCreateRequest): string {
    if (data.bl_number) return createCacheKey("shipment:bl", { bl: data.bl_number });
    if (data.container_number) return createCacheKey("shipment:container", { container: data.container_number });
    if (data.booking_number) return createCacheKey("shipment:booking", { booking: data.booking_number });
    return createCacheKey("shipment:unknown", {});
  }

  // ============================================
  // VALIDATION
  // ============================================

  /**
   * Validates Bill of Lading number format.
   * Expected: 4-char carrier prefix + 8-12 digits.
   */
  validateBLNumber(bl: string): boolean {
    // BL numbers typically: carrier prefix (4 chars) + digits
    return /^[A-Z]{4}\d{8,12}$/i.test(bl.toUpperCase());
  }

  /**
   * Validates container number format.
   * Expected: ISO 6346 format (4 letters + 7 digits).
   */
  validateContainerNumber(container: string): boolean {
    // ISO 6346 format: 4 letters + 7 digits (last is check digit)
    return /^[A-Z]{4}\d{7}$/i.test(container.toUpperCase());
  }

  /**
   * Validates booking number format.
   * Expected: Alphanumeric, 6-20 characters.
   */
  validateBookingNumber(booking: string): boolean {
    // Carrier-specific, generally alphanumeric 6-20 chars
    return /^[A-Z0-9]{6,20}$/i.test(booking);
  }

  // ============================================
  // SHIPMENT MANAGEMENT
  // ============================================

  /**
   * Creates or retrieves a shipment for tracking.
   *
   * Uses credit-saving strategy:
   * 1. Checks cache first (free)
   * 2. If 409 (already exists), fetches existing (free)
   * 3. Only creates new if needed (1 credit)
   *
   * NOTE: API requires FLAT structure (bl_number, container_number at root, not nested).
   * Custom reference requires separate PATCH call after creation.
   *
   * @param data - Shipment creation request with reference numbers (flat structure)
   * @param customReference - Optional custom reference (applied via PATCH after creation)
   * @returns Shipment details with source and credit usage info
   *
   * @throws {RateLimitError} If rate limited
   * @throws {InsufficientCreditsError} If no credits available
   */
  async createShipment(data: ShipmentCreateRequest, customReference?: string): Promise<CreateResult> {
    const cacheKey = this.buildCacheKey(data);

    // Step 1: Check cache first (always free)
    const cachedResult = cache.get<Shipment>(cacheKey);
    if (cachedResult.hit && cachedResult.data && !cachedResult.data.discarded_at) {
      return { shipment: cachedResult.data, source: "cache", creditUsed: false };
    }

    // Step 2: Attempt create with flat structure
    return this.fetchWithRetry(async () => {
      const { data: responseData, response } = await this.request<Record<string, unknown>>(
        "POST",
        "/ocean/shipments",
        data  // Flat structure: { shipment_type, bl_number?, container_number?, booking_number? }
      );

      // Handle responses
      if (response.status === 200 || response.status === 201) {
        const shipment = this.mapToShipment(responseData);

        // Update reference via PATCH if provided (non-fatal if fails)
        let warning: string | undefined;
        if (customReference && shipment.id) {
          try {
            const { response: patchResponse } = await this.request<Record<string, unknown>>(
              "PATCH",
              `/ocean/shipments/${shipment.id}`,
              { reference: customReference } as ShipmentUpdateRequest
            );
            if (!patchResponse.ok) {
              warning = `Reference update failed (${patchResponse.status}). Shipment created but reference not set.`;
            }
          } catch (e) {
            warning = `Reference update failed: ${e instanceof Error ? e.message : "Unknown error"}`;
          }
        }

        cache.set(cacheKey, shipment, { ttl: this.getCacheTTL(shipment) });
        return { shipment, source: "created" as const, creditUsed: true, warning };
      }

      if (response.status === 409) {
        // Already exists - fetch existing
        const existing = await this.fetchByReference(data);
        if (existing) {
          cache.set(cacheKey, existing, { ttl: this.getCacheTTL(existing) });
          return { shipment: existing, source: "existing" as const, creditUsed: false };
        }
        throw new Error("409 returned but shipment not found");
      }

      throw new ApiError(response.status, responseData);
    });
  }

  private async fetchByReference(data: ShipmentCreateRequest): Promise<Shipment | null> {
    if (data.bl_number) {
      return this.trackByBL(data.bl_number);
    }
    if (data.container_number) {
      return this.trackByContainer(data.container_number);
    }
    if (data.booking_number) {
      return this.trackByBooking(data.booking_number);
    }
    return null;
  }

  /**
   * Gets a shipment by its ID.
   *
   * @param id - ShipsGo shipment ID
   * @returns Shipment details
   *
   * @cached TTL: 2 hours
   */
  async getShipmentById(id: string): Promise<Shipment> {
    const cacheKey = createCacheKey("shipment:id", { id });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const { data, response } = await this.request<Record<string, unknown>>(
          "GET",
          `/ocean/shipments/${id}`
        );

        if (!response.ok) {
          throw new ApiError(response.status, data);
        }

        return this.mapToShipment(data);
      },
      { ttl: TTL.HOUR * 2, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Lists shipments with optional filters.
   *
   * @param options - Query options (status, limit, offset, ETA range, sort)
   * @returns Shipment list and total count
   *
   * @cached TTL: 15 minutes
   */
  async listShipments(options?: ListOptions): Promise<{ shipments: Shipment[]; count: number }> {
    const cacheKey = createCacheKey("list:shipments", {
      status: options?.status,
      limit: options?.limit,
      offset: options?.offset,
      eta_from: options?.eta_from,
      eta_to: options?.eta_to,
      sort: options?.sort,
      order: options?.order,
    });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const params = new URLSearchParams();
        if (options?.status) params.append("status", options.status);
        if (options?.limit) params.append("limit", String(options.limit));
        if (options?.offset) params.append("offset", String(options.offset));
        if (options?.eta_from) params.append("eta_from", options.eta_from);
        if (options?.eta_to) params.append("eta_to", options.eta_to);
        if (options?.sort) params.append("sort", options.sort);
        if (options?.order) params.append("order", options.order);

        const queryString = params.toString();
        const endpoint = `/ocean/shipments${queryString ? `?${queryString}` : ""}`;

        const { data, response } = await this.request<{ shipments?: unknown[]; data?: unknown[]; count?: number }>(
          "GET",
          endpoint
        );

        if (!response.ok) {
          throw new ApiError(response.status, data);
        }

        const shipments = (data.shipments || data.data || []) as Record<string, unknown>[];
        return {
          shipments: shipments.map(s => this.mapToShipment(s)),
          count: data.count ?? shipments.length,
        };
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // TRACKING QUERIES
  // ============================================

  /**
   * Tracks shipment by Bill of Lading number.
   *
   * @param blNumber - BL number (case-insensitive)
   * @returns Shipment if found, null otherwise
   *
   * @cached TTL: 2 hours
   */
  async trackByBL(blNumber: string): Promise<Shipment | null> {
    const cacheKey = createCacheKey("shipment:bl", { bl: blNumber.toUpperCase() });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const { data, response } = await this.request<{ shipments?: unknown[]; data?: unknown[] }>(
          "GET",
          `/ocean/shipments?bl_number=${encodeURIComponent(blNumber.toUpperCase())}`
        );

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new ApiError(response.status, data);
        }

        const shipments = (data.shipments || data.data || []) as Record<string, unknown>[];
        if (shipments.length === 0) return null;

        return this.selectBestMatch(shipments.map(s => this.mapToShipment(s)));
      },
      { ttl: TTL.HOUR * 2, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Tracks shipment by container number.
   *
   * @param containerNumber - ISO 6346 container number (case-insensitive)
   * @returns Shipment if found, null otherwise
   *
   * @cached TTL: 2 hours
   */
  async trackByContainer(containerNumber: string): Promise<Shipment | null> {
    const cacheKey = createCacheKey("shipment:container", { container: containerNumber.toUpperCase() });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const { data, response } = await this.request<{ shipments?: unknown[]; data?: unknown[] }>(
          "GET",
          `/ocean/shipments?container_number=${encodeURIComponent(containerNumber.toUpperCase())}`
        );

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new ApiError(response.status, data);
        }

        const shipments = (data.shipments || data.data || []) as Record<string, unknown>[];
        if (shipments.length === 0) return null;

        return this.selectBestMatch(shipments.map(s => this.mapToShipment(s)));
      },
      { ttl: TTL.HOUR * 2, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Tracks shipment by booking number.
   *
   * @param bookingNumber - Carrier booking number (case-insensitive)
   * @returns Shipment if found, null otherwise
   *
   * @cached TTL: 2 hours
   */
  async trackByBooking(bookingNumber: string): Promise<Shipment | null> {
    const cacheKey = createCacheKey("shipment:booking", { booking: bookingNumber.toUpperCase() });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const { data, response } = await this.request<{ shipments?: unknown[]; data?: unknown[] }>(
          "GET",
          `/ocean/shipments?booking_number=${encodeURIComponent(bookingNumber.toUpperCase())}`
        );

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new ApiError(response.status, data);
        }

        const shipments = (data.shipments || data.data || []) as Record<string, unknown>[];
        if (shipments.length === 0) return null;

        return this.selectBestMatch(shipments.map(s => this.mapToShipment(s)));
      },
      { ttl: TTL.HOUR * 2, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Searches shipments by any reference (BL, container, booking, or custom).
   *
   * @param reference - Reference string to search
   * @returns Matching shipments (may be empty)
   *
   * @cached TTL: 15 minutes
   */
  async searchByReference(reference: string): Promise<Shipment[]> {
    const cacheKey = createCacheKey("search", { ref: reference });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const { data, response } = await this.request<{ shipments?: unknown[]; data?: unknown[] }>(
          "GET",
          `/ocean/shipments?reference=${encodeURIComponent(reference)}`
        );

        if (!response.ok) {
          if (response.status === 404) return [];
          throw new ApiError(response.status, data);
        }

        const shipments = (data.shipments || data.data || []) as Record<string, unknown>[];
        return shipments.map(s => this.mapToShipment(s));
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // STATUS & MONITORING
  // ============================================

  /**
   * Gets all active shipments (EN_ROUTE and PENDING).
   *
   * @returns All active shipments
   *
   * @cached TTL: 15 minutes
   */
  async getActiveShipments(): Promise<Shipment[]> {
    const cacheKey = createCacheKey("list:active", {});

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const result = await this.listShipments({ status: "EN_ROUTE", limit: 100 });
        const pending = await this.listShipments({ status: "PENDING", limit: 100 });

        return [...result.shipments, ...pending.shipments];
      },
      { ttl: TTL.FIFTEEN_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets shipments arriving within N days.
   *
   * @param days - Number of days to look ahead (default: 7)
   * @returns Shipments with ETA in range
   *
   * @cached TTL: 30 minutes
   */
  async getArrivingSoon(days: number = 7): Promise<Shipment[]> {
    const cacheKey = createCacheKey("list:arriving", { days });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const now = new Date();
        const future = new Date(now.getTime() + days * 24 * 60 * 60 * 1000);

        const result = await this.listShipments({
          eta_from: now.toISOString().split("T")[0],
          eta_to: future.toISOString().split("T")[0],
          status: "EN_ROUTE",
          limit: 100,
        });

        return result.shipments;
      },
      { ttl: TTL.THIRTY_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  /**
   * Gets tracking milestones for a shipment.
   *
   * @param id - Shipment ID
   * @returns Array of milestone events
   */
  async getMilestones(id: string): Promise<Milestone[]> {
    const shipment = await this.getShipmentById(id);
    return shipment.milestones || [];
  }

  /**
   * Gets live vessel position for a shipment.
   *
   * @param id - Shipment ID
   * @returns Coordinates and vessel name, or null if unavailable
   *
   * @cached TTL: 30 minutes
   */
  async getVesselPosition(id: string): Promise<{ lat: number; lng: number; vessel: string } | null> {
    const cacheKey = createCacheKey("position", { id });

    return cache.getOrFetch(
      cacheKey,
      async () => {
        const { data, response } = await this.request<Record<string, unknown>>(
          "GET",
          `/ocean/shipments/${id}?mapPoint=true`
        );

        if (!response.ok) {
          if (response.status === 404) return null;
          throw new ApiError(response.status, data);
        }

        const shipment = this.mapToShipment(data);
        if (!shipment.coordinates) return null;

        return {
          lat: shipment.coordinates.lat,
          lng: shipment.coordinates.lng,
          vessel: shipment.vessel?.name || "Unknown",
        };
      },
      { ttl: TTL.THIRTY_MINUTES, bypassCache: this.cacheDisabled }
    );
  }

  // ============================================
  // UTILITIES
  // ============================================

  /**
   * Checks API connectivity and key validity.
   *
   * @returns Status including rate limit info
   */
  async getApiStatus(): Promise<{ valid: boolean; message: string; details?: unknown }> {
    try {
      const { response } = await this.request<unknown>("GET", "/ocean/shipments?limit=1");

      if (response.ok) {
        return {
          valid: true,
          message: "API key is valid and connection successful",
          details: { rateLimit: this.getRateLimitStatus() },
        };
      }

      return {
        valid: false,
        message: `API returned status ${response.status}`,
      };
    } catch (error) {
      return {
        valid: false,
        message: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Gets a shareable public tracking link for a shipment.
   * Uses the v2 API tokens.map field to construct the URL.
   *
   * @param id - ShipsGo shipment ID
   * @returns Sharing link with shipment summary, or null if token not yet available
   * @throws {ApiError} For non-404 HTTP errors
   */
  async getSharingLink(id: string): Promise<SharingLinkResult | null> {
    const cacheKey = createCacheKey("sharing-link", { id });
    const cached = cache.get<SharingLinkResult>(cacheKey);

    // Return cached result if available (but don't cache nulls)
    if (cached.hit && cached.data) {
      return cached.data;
    }

    // Fetch raw response to access tokens.map (not mapped in Shipment interface)
    const { data, response } = await this.request<Record<string, unknown>>(
      "GET",
      `/ocean/shipments/${id}`
    );

    // Match error handling pattern from getShipmentById
    if (!response.ok) {
      if (response.status === 404) return null;
      throw new ApiError(response.status, data);
    }

    // Extract token - check both possible response shapes
    // Shape 1: { shipment: { tokens: { map } } } (documented)
    // Shape 2: { tokens: { map } } (if response IS the shipment)
    const shipmentData = (data.shipment as Record<string, unknown>) || data;
    const tokens = shipmentData.tokens as { map?: string } | undefined;
    const mapToken = tokens?.map;

    if (!mapToken) {
      // Token not available yet - don't cache null (token may appear later)
      return null;
    }

    // Extract shipment details for convenience
    const route = shipmentData.route as Record<string, unknown> | undefined;
    const pol = route?.port_of_loading as Record<string, unknown> | undefined;
    const pod = route?.port_of_discharge as Record<string, unknown> | undefined;

    const result: SharingLinkResult = {
      url: `https://map.shipsgo.com/ocean/shipments/${id}?token=${mapToken}`,
      shipmentId: id,
      containerNumber: shipmentData.container_number as string | undefined,
      status: (shipmentData.status as string) || "UNKNOWN",
      pol: (pol?.location as Record<string, unknown>)?.name as string | undefined,
      pod: (pod?.location as Record<string, unknown>)?.name as string | undefined,
      eta: pod?.date_of_discharge as string | undefined,
    };

    // Cache successful results for 1 day (tokens are stable once assigned)
    cache.set(cacheKey, result, { ttl: TTL.DAY });
    return result;
  }

  // === Selection Logic ===
  private selectBestMatch(shipments: Shipment[]): Shipment | null {
    if (shipments.length === 0) return null;
    if (shipments.length === 1) return shipments[0];

    // Prefer: non-discarded, most recent, active status
    return shipments
      .filter(s => !s.discarded_at)
      .sort((a, b) => {
        const statusOrder: Record<string, number> = {
          EN_ROUTE: 0,
          PENDING: 1,
          ARRIVED: 2,
          DELIVERED: 3,
          DISCARDED: 4,
          NOT_FOUND: 5,
        };
        const statusDiff = (statusOrder[a.status] ?? 5) - (statusOrder[b.status] ?? 5);
        if (statusDiff !== 0) return statusDiff;

        // Most recent first
        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })[0] ?? shipments[0];
  }

  // ============================================
  // TOOL LIST
  // ============================================

  /** Returns list of available CLI commands with descriptions. */
  getTools(): Array<{ name: string; description: string }> {
    return [
      { name: "create-shipment", description: "Create/track a new shipment (1 credit if new)" },
      { name: "get-shipment", description: "Get shipment by ID" },
      { name: "list-shipments", description: "List all shipments with filters" },
      { name: "track-bl", description: "Track by Bill of Lading" },
      { name: "track-container", description: "Track by container number" },
      { name: "track-booking", description: "Track by booking number" },
      { name: "search", description: "Search by any reference" },
      { name: "active", description: "List all active shipments" },
      { name: "arriving-soon", description: "Shipments arriving within N days" },
      { name: "milestones", description: "Get tracking milestones" },
      { name: "vessel-position", description: "Get live vessel coordinates" },
      { name: "api-status", description: "Check API connectivity" },
      { name: "rate-limit", description: "Show rate limit status" },
      { name: "refresh-shipment", description: "Force re-poll, bypass cache" },
      { name: "get-sharing-link", description: "Get a shareable public tracking link for a shipment" },
      { name: "cache-stats", description: "Show cache statistics" },
      { name: "cache-clear", description: "Clear all cached data" },
      { name: "cache-invalidate", description: "Invalidate specific shipment" },
    ];
  }
}

export default ShipsGoClient;
