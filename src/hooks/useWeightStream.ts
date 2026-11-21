"use client";

import { useState, useEffect, useRef, useCallback } from "react";

export interface WeightTelemetry {
  weight: number;
  isStable: boolean;
  isConnected: boolean;
  unit: string;
  deviceId: string;
  port?: string;
  rawString?: string;
  lastUpdated?: Date;
}

export interface UseWeightStreamOptions {
  adapterUrl?: string;
  toleranceKg?: number;
  settlingWindowMs?: number;
  watchdogTimeoutMs?: number;
  reconnectIntervalMs?: number;
  deviceId?: string;
}

interface WeightSample {
  weight: number;
  timestamp: number;
  hardwareStable: boolean;
}

const DEFAULT_OPTIONS: Required<UseWeightStreamOptions> = {
  adapterUrl: process.env.NEXT_PUBLIC_LOKET_ADAPTER_URL || "http://localhost:7777",
  toleranceKg: 10,
  settlingWindowMs: 1500,
  watchdogTimeoutMs: 20000,
  reconnectIntervalMs: 3000,
  deviceId: "",
};

export function useWeightStream(options?: UseWeightStreamOptions) {
  const config = { ...DEFAULT_OPTIONS, ...options };

  const [telemetry, setTelemetry] = useState<WeightTelemetry>({
    weight: 0,
    isStable: false,
    isConnected: false,
    unit: "kg",
    deviceId: config.deviceId,
  });

  const samplesRef = useRef<WeightSample[]>([]);
  const watchdogTimerRef = useRef<NodeJS.Timeout | null>(null);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const eventSourceRef = useRef<EventSource | null>(null);
  const isMountedRef = useRef<boolean>(true);
  const currentPortRef = useRef<string>("COM1");

  // Reset watchdog timer
  const kickWatchdog = useCallback(
    (onTimeout: () => void) => {
      if (watchdogTimerRef.current) {
        clearTimeout(watchdogTimerRef.current);
      }
      watchdogTimerRef.current = setTimeout(onTimeout, config.watchdogTimeoutMs);
    },
    [config.watchdogTimeoutMs]
  );

  // Dual-layer stabilization algorithm
  const evaluateStabilization = useCallback(
    (currentWeight: number, hardwareStable: boolean): boolean => {
      if (!hardwareStable) {
        samplesRef.current = [];
        return false;
      }

      const now = Date.now();
      // Append current sample
      samplesRef.current.push({
        weight: currentWeight,
        timestamp: now,
        hardwareStable,
      });

      // Prune samples older than settling window
      const cutoff = now - config.settlingWindowMs;
      samplesRef.current = samplesRef.current.filter((s) => s.timestamp >= cutoff);

      const samples = samplesRef.current;
      if (samples.length < 2) {
        return false;
      }

      const timeSpan = now - samples[0].timestamp;
      if (timeSpan < config.settlingWindowMs * 0.8) {
        return false;
      }

      // Check jitter/oscillation within tolerance window
      const weights = samples.map((s) => s.weight);
      const minWeight = Math.min(...weights);
      const maxWeight = Math.max(...weights);
      const delta = maxWeight - minWeight;

      return delta <= config.toleranceKg;
    },
    [config.settlingWindowMs, config.toleranceKg]
  );

  useEffect(() => {
    isMountedRef.current = true;

    function connect() {
      if (!isMountedRef.current) return;

      // Close previous connection if any
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }

      const streamUrl = `${config.adapterUrl}/api/weight/stream`;

      try {
        const es = new EventSource(streamUrl);
        eventSourceRef.current = es;

        const handleWatchdogTimeout = () => {
          console.warn("[useWeightStream] Watchdog timeout: no events received in 20s. Reconnecting...");
          if (isMountedRef.current) {
            setTelemetry((prev) => ({ ...prev, isConnected: false, isStable: false }));
            connect();
          }
        };

        kickWatchdog(handleWatchdogTimeout);

        // 1. Status event
        es.addEventListener("status", (e: MessageEvent) => {
          if (!isMountedRef.current) return;
          kickWatchdog(handleWatchdogTimeout);

          try {
            const data = JSON.parse(e.data);
            const isConn = Boolean(data.connected);
            if (data.port) currentPortRef.current = data.port;

            setTelemetry((prev) => ({
              ...prev,
              isConnected: isConn,
              port: data.port || prev.port,
              ...(!isConn ? { isStable: false, weight: 0 } : {}),
            }));
          } catch (err) {
            console.error("[useWeightStream] Error parsing status event:", err);
          }
        });

        // 2. Weight event
        es.addEventListener("weight", (e: MessageEvent) => {
          if (!isMountedRef.current) return;
          kickWatchdog(handleWatchdogTimeout);

          try {
            const data = JSON.parse(e.data);
            // Ponytail: Tare / Negative Normalization - negative drift becomes 0.0 kg
            const rawWeight = typeof data.weight === "number" ? data.weight : parseFloat(data.weight) || 0;
            const normalizedWeight = Math.max(0, Math.round(rawWeight * 1000) / 1000);
            // Ponytail: Gunakan flag kestabilan langsung dari indikator hardware/loket-adapter (ST/US)
            const hardwareStable = Boolean(
              data.stable !== undefined
                ? data.stable
                : data.isStable !== undefined
                ? data.isStable
                : evaluateStabilization(normalizedWeight, true)
            );
            const isStable = hardwareStable;

            setTelemetry((prev) => ({
              ...prev,
              weight: normalizedWeight,
              isStable,
              isConnected: true,
              unit: (data.unit || "kg").toLowerCase(),
              rawString: data.raw || "",
              port: currentPortRef.current,
              deviceId: data.deviceId || config.deviceId || "",
              lastUpdated: new Date(),
            }));
          } catch (err) {
            console.error("[useWeightStream] Error parsing weight event:", err);
          }
        });

        // 3. Error event & auto-reconnect
        es.onerror = () => {
          if (!isMountedRef.current) return;
          setTelemetry((prev) => ({
            ...prev,
            isConnected: false,
            isStable: false,
            weight: 0,
          }));

          if (es.readyState === EventSource.CLOSED) {
            es.close();
            if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
            reconnectTimerRef.current = setTimeout(connect, config.reconnectIntervalMs);
          }
        };
      } catch (err) {
        console.error("[useWeightStream] Connection failure:", err);
        if (isMountedRef.current) {
          setTelemetry((prev) => ({
            ...prev,
            isConnected: false,
            isStable: false,
            weight: 0,
          }));
          if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
          reconnectTimerRef.current = setTimeout(connect, config.reconnectIntervalMs);
        }
      }
    }

    connect();

    return () => {
      isMountedRef.current = false;
      if (watchdogTimerRef.current) clearTimeout(watchdogTimerRef.current);
      if (reconnectTimerRef.current) clearTimeout(reconnectTimerRef.current);
      if (eventSourceRef.current) {
        eventSourceRef.current.close();
        eventSourceRef.current = null;
      }
    };
  }, [config.adapterUrl, config.deviceId, config.reconnectIntervalMs, evaluateStabilization, kickWatchdog]);

  return telemetry;
}

