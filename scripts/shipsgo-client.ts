
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import {
  getServiceModuleDir,
  loadServiceConfig,
  z,
} from "@local/cli-utils";
import { PluginCache, TTL, createCacheKey } from "@local/plugin-cache";
import { isPreSendNetworkError, withRetry } from "./vendor/retry/index.js";


const REQUEST_TIMEOUT_MS = 30_000;
const EPOCH_MILLISECONDS_THRESHOLD = 1_000_000_000_000;
const HTTP_DATE_PREFIX = /^(?:(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun), |(?:Monday|Tuesday|Wednesday|Thursday|Friday|Saturday|Sunday), |(?:Mon|Tue|Wed|Thu|Fri|Sat|Sun) )/i;

function isValidDateTimestamp(value: number): boolean {
  return Number.isFinite(new Date(value).getTime());
}

function parseRateLimitReset(value: string | null): number | undefined {
  const normalized = value?.trim();
  if (!normalized || !/^\d+$/.test(normalized)) return undefined;

  const numericValue = Number(normalized);
  if (!Number.isSafeInteger(numericValue)) return undefined;

  const resetAt = numericValue >= EPOCH_MILLISECONDS_THRESHOLD
    ? numericValue
    : numericValue * 1000;
  return isValidDateTimestamp(resetAt) ? resetAt : undefined;
}

function parseRetryAfter(value: string | null, now: number): number | undefined {
  const normalized = value?.trim();
  if (!normalized) return undefined;

  if (/^\d+$/.test(normalized)) {
    const deltaSeconds = Number(normalized);
    const resetAt = now + deltaSeconds * 1000;
    return Number.isSafeInteger(deltaSeconds) && isValidDateTimestamp(resetAt)
      ? resetAt
      : undefined;
  }

  if (!HTTP_DATE_PREFIX.test(normalized)) return undefined;

  const resetAt = Date.parse(normalized);
  return isValidDateTimestamp(resetAt) ? resetAt : undefined;
}

function parseRetryAfterDelaySeconds(value: string | null, now: number): number | undefined {
  const resetAt = parseRetryAfter(value, now);
  return resetAt === undefined
    ? undefined
    : Math.max(0, Math.ceil((resetAt - now) / 1000));
}

const ShipsGoConfigSchema = z.object({
  shipsgo: z.object({
    apiKey: z.string().min(1),
    baseUrl: z.string().min(1),
  }),
});

type ShipsGoConfig = z.infer<typeof ShipsGoConfigSchema>;

export interface ShipmentCreateRequest {
  container_number?: string;
  booking_number?: string;
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
  warning?: string;
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

export class ApiError extends Error {
  constructor(public status: number, public data: unknown) {
    super(`API Error ${status}: ${JSON.stringify(data)}`);
    this.name = "ApiError";
  }
}

export class RateLimitError extends Error {
  constructor(public retryAfter?: number) {
    super(`Rate limited${retryAfter !== undefined ? `, retry after ${retryAfter}s` : ""}`);
    this.name = "RateLimitError";
  }
}

export class InsufficientCreditsError extends Error {
  constructor(message?: string) {
    super(message || "Insufficient credits");
    this.name = "InsufficientCreditsError";
  }
}

export class ShipmentCreateResponseError extends Error {
  constructor(
    public outcome: "created_response_invalid" | "duplicate_response_invalid",
    public data: unknown,
  ) {
    const message = outcome === "created_response_invalid"
      ? "ShipsGo accepted create-shipment but returned no usable shipment; the write outcome is ambiguous, so reconcile with a read before retrying"
      : "ShipsGo reported ALREADY_EXISTS but returned no usable shipment; reconcile with a read before retrying";
    super(message);
    this.name = "ShipmentCreateResponseError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function unwrapCreatedShipment(value: unknown): Record<string, unknown> | null {
  if (!isRecord(value)) return null;

  if (Object.prototype.hasOwnProperty.call(value, "shipment")) {
    return isRecord(value.shipment) ? value.shipment : null;
  }

  return value.id !== undefined || value.requestId !== undefined ? value : null;
}

interface FetchWithRetryOptions {
  maxRetries: number;
  baseDelay: number;
  operationKind?: "read" | "write";
}

const cache = new PluginCache({
  namespace: "shipsgo-container-tracker",
  defaultTTL: TTL.HOUR,
});

export class ShipsGoClient {
  private config: ShipsGoConfig;
  private cacheDisabled: boolean = false;
  private rateLimitFile: string;

  constructor() {
    this.config = loadServiceConfig("shipsgo-container-tracker", {
      schema: ShipsGoConfigSchema,
    });
    this.rateLimitFile = join(
      getServiceModuleDir("shipsgo-container-tracker"),
      ".ratelimit.json",
    );
  }


  disableCache(): void {
    this.cacheDisabled = true;
    cache.disable();
  }

  enableCache(): void {
    this.cacheDisabled = false;
    cache.enable();
  }

  getCacheStats() {
    return cache.getStats();
  }

  clearCache(): number {
    return cache.clear();
  }

  invalidateShipment(id: string): boolean {
    const shipmentInvalidated = cache.invalidate(createCacheKey("shipment:id", { id }));
    const sharingLinkInvalidated = cache.invalidate(createCacheKey("sharing-link", { id }));
    return shipmentInvalidated || sharingLinkInvalidated;
  }


  private loadRateLimitData(): RateLimitData {
    try {
      if (existsSync(this.rateLimitFile)) {
        return JSON.parse(readFileSync(this.rateLimitFile, "utf-8"));
      }
    } catch {
    }
    return { localCalls: [] };
  }

  private saveRateLimitData(data: RateLimitData): void {
    try {
      writeFileSync(this.rateLimitFile, JSON.stringify(data, null, 2));
    } catch {
    }
  }

  private updateRateLimitFromResponse(response: Response): void {
    const data = this.loadRateLimitData();
    const now = Date.now();

    const remaining = response.headers.get("X-RateLimit-Remaining");
    const limit = response.headers.get("X-RateLimit-Limit");
    const providerResetAt = parseRateLimitReset(response.headers.get("X-RateLimit-Reset"));
    const retryResetAt = parseRetryAfter(response.headers.get("Retry-After"), now);

    if (remaining) data.serverRemaining = parseInt(remaining, 10);
    if (limit) data.serverLimit = parseInt(limit, 10);
    if (providerResetAt !== undefined) {
      data.serverResetAt = providerResetAt;
    } else if (retryResetAt !== undefined) {
      data.serverResetAt = retryResetAt;
    }
    data.lastServerUpdate = now;

    data.localCalls.push(now);
    data.localCalls = data.localCalls.filter(t => t > now - 60_000);

    this.saveRateLimitData(data);
  }

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
        const retryAfter = parseRetryAfterDelaySeconds(
          response.headers.get("Retry-After"),
          Date.now(),
        );
        throw new RateLimitError(retryAfter);
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
    options: FetchWithRetryOptions = { maxRetries: 3, baseDelay: 1000 }
  ): Promise<T> {
    const result = await withRetry(fn, {
      maxRetries: options.maxRetries,
      baseDelayMs: options.baseDelay,
      maxDelayMs: Number.MAX_SAFE_INTEGER,
      jitterPercent: 0,
      retryableErrors: [],
      nextDelayMs: ({ attempt, error }) => {
        if (error instanceof RateLimitError && error.retryAfter !== undefined) {
          return error.retryAfter * 1000;
        }
        return options.baseDelay * Math.pow(2, attempt) + Math.random() * 500;
      },
      shouldRetry: (error) => {
        return !(error instanceof ApiError && error.status >= 400 && error.status < 500 && error.status !== 429);
      },
      operationKind: options.operationKind,
      isPreSendError: isPreSendNetworkError,
      sleepImpl: (ms) => this.sleep(ms),
      logger: () => {},
    });

    if (result.success) {
      return result.data as T;
    }

    throw result.error ?? new Error("Max retries exceeded");
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }

  private mapToShipment(raw: Record<string, unknown>): Shipment {
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
      custom_reference: raw.reference as string || raw.customReference as string || raw.custom_reference as string,
    };

    if (raw.vessel || raw.vesselName) {
      shipment.vessel = {
        name: (raw.vessel as { name?: string })?.name || raw.vesselName as string || "",
        imo: (raw.vessel as { imo?: string })?.imo || raw.vesselImo as string,
      };
    }

    if (raw.pol || raw.portOfLoading) {
      const pol = raw.pol as Record<string, unknown> || {};
      shipment.pol = {
        code: pol.code as string || raw.polCode as string || "",
        name: pol.name as string || raw.portOfLoading as string || "",
        departure: pol.departure as string || raw.etd as string || raw.atd as string,
      };
    }

    if (raw.pod || raw.portOfDischarge) {
      const pod = raw.pod as Record<string, unknown> || {};
      shipment.pod = {
        code: pod.code as string || raw.podCode as string || "",
        name: pod.name as string || raw.portOfDischarge as string || "",
        eta: pod.eta as string || raw.eta as string,
        ata: pod.ata as string || raw.ata as string,
      };
    }

    if (Array.isArray(raw.milestones) || Array.isArray(raw.events)) {
      const events = (raw.milestones || raw.events) as Array<Record<string, unknown>>;
      shipment.milestones = events.map(e => ({
        event: e.event as string || e.description as string || "",
        location: e.location as string,
        timestamp: e.timestamp as string || e.date as string || "",
        is_actual: Boolean(e.isActual ?? e.is_actual ?? true),
      }));
    }

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
    const reference = data.reference?.trim() || undefined;

    if (data.booking_number) {
      return createCacheKey("shipment:booking", {
        booking: data.booking_number.toUpperCase(),
        reference,
      });
    }
    if (data.container_number) {
      return createCacheKey("shipment:container", {
        container: data.container_number.toUpperCase(),
        reference,
      });
    }
    return createCacheKey("shipment:unknown", { reference });
  }

  private getReferenceWarning(
    data: ShipmentCreateRequest,
    shipment: Shipment,
    source: CreateResult["source"],
  ): string | undefined {
    if (!data.reference || shipment.custom_reference === data.reference) return undefined;

    if (source === "cache") {
      return "The cached shipment did not confirm the requested reference; no ShipsGo create or update request was sent.";
    }
    if (source === "existing") {
      return "ShipsGo reported an existing shipment without confirming the requested reference; no standalone reference update was attempted.";
    }
    return "ShipsGo accepted the create request, but its response did not confirm the requested reference; reconcile with a read before retrying.";
  }

  private async writeShipmentCache(cacheKey: string, shipment: Shipment): Promise<void> {
    await cache.set(cacheKey, shipment, { ttl: this.getCacheTTL(shipment) });
  }

  private async publishAcceptedShipmentToCache(
    cacheKey: string,
    shipment: Shipment,
    source: "created" | "existing",
  ): Promise<string | undefined> {
    try {
      await this.writeShipmentCache(cacheKey, shipment);
      return undefined;
    } catch {
      const acceptance = source === "created"
        ? "ShipsGo accepted create-shipment"
        : "ShipsGo confirmed ALREADY_EXISTS";
      return `${acceptance}, but local cache publication failed. The returned shipment.id is the authoritative provider identity; do not retry create-shipment solely because of this warning.`;
    }
  }

  private combineWarnings(...warnings: Array<string | undefined>): string | undefined {
    const present = warnings.filter((warning): warning is string => Boolean(warning));
    return present.length > 0 ? present.join(" ") : undefined;
  }


  validateBLNumber(bl: string): boolean {
    return /^[A-Z]{4}\d{8,12}$/i.test(bl.toUpperCase());
  }

  validateContainerNumber(container: string): boolean {
    return /^[A-Z]{4}\d{7}$/i.test(container.toUpperCase());
  }

  validateBookingNumber(booking: string): boolean {
    return /^[A-Z0-9]{6,20}$/i.test(booking);
  }


  async createShipment(data: ShipmentCreateRequest): Promise<CreateResult> {
    const cacheKey = this.buildCacheKey(data);

    const cachedResult = cache.get<Shipment>(cacheKey);
    if (cachedResult.hit && cachedResult.data && !cachedResult.data.discarded_at) {
      return {
        shipment: cachedResult.data,
        source: "cache",
        creditUsed: false,
        warning: this.getReferenceWarning(data, cachedResult.data, "cache"),
      };
    }

    return this.fetchWithRetry(async () => {
      const { data: responseData, response } = await this.request<unknown>(
        "POST",
        "/ocean/shipments",
        data,
      );

      if (response.status === 200 || response.status === 201) {
        const rawShipment = unwrapCreatedShipment(responseData);
        if (!rawShipment) {
          throw new ShipmentCreateResponseError("created_response_invalid", responseData);
        }

        const shipment = this.mapToShipment(rawShipment);
        if (!shipment.id) {
          throw new ShipmentCreateResponseError("created_response_invalid", responseData);
        }

        const cacheWarning = await this.publishAcceptedShipmentToCache(
          cacheKey,
          shipment,
          "created",
        );
        return {
          shipment,
          source: "created" as const,
          creditUsed: true,
          warning: this.combineWarnings(
            this.getReferenceWarning(data, shipment, "created"),
            cacheWarning,
          ),
        };
      }

      if (response.status === 409) {
        const rawShipment = unwrapCreatedShipment(responseData);
        if (!rawShipment) {
          throw new ShipmentCreateResponseError("duplicate_response_invalid", responseData);
        }

        const existing = this.mapToShipment(rawShipment);
        if (!existing.id) {
          throw new ShipmentCreateResponseError("duplicate_response_invalid", responseData);
        }

        const cacheWarning = await this.publishAcceptedShipmentToCache(
          cacheKey,
          existing,
          "existing",
        );
        return {
          shipment: existing,
          source: "existing" as const,
          creditUsed: false,
          warning: this.combineWarnings(
            this.getReferenceWarning(data, existing, "existing"),
            cacheWarning,
          ),
        };
      }

      throw new ApiError(response.status, responseData);
    }, { maxRetries: 3, baseDelay: 1000, operationKind: "write" });
  }

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

  async getMilestones(id: string): Promise<Milestone[]> {
    const shipment = await this.getShipmentById(id);
    return shipment.milestones || [];
  }

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

  async getSharingLink(id: string): Promise<SharingLinkResult | null> {
    const cacheKey = createCacheKey("sharing-link", { id });
    const cached = cache.get<SharingLinkResult>(cacheKey);

    if (cached.hit && cached.data) {
      return cached.data;
    }

    const { data, response } = await this.request<Record<string, unknown>>(
      "GET",
      `/ocean/shipments/${id}`
    );

    if (!response.ok) {
      if (response.status === 404) return null;
      throw new ApiError(response.status, data);
    }

    const shipmentData = (data.shipment as Record<string, unknown>) || data;
    const tokens = shipmentData.tokens as { map?: string } | undefined;
    const mapToken = tokens?.map;

    if (!mapToken) {
      return null;
    }

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

    cache.set(cacheKey, result, { ttl: TTL.DAY });
    return result;
  }

  private selectBestMatch(shipments: Shipment[]): Shipment | null {
    if (shipments.length === 0) return null;
    if (shipments.length === 1) return shipments[0];

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

        return new Date(b.created_at).getTime() - new Date(a.created_at).getTime();
      })[0] ?? shipments[0];
  }


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
