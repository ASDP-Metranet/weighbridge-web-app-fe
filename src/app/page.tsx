"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import Image from "next/image";
import { useWeightStream } from "@/hooks/useWeightStream";

// Badge status kestabilan sensor pada kartu monitor (kondisi STANDBY)
const STABILITY_BADGE = {
  STABLE: { label: "STABIL", bg: "#dcfce7", fg: "#15803d", dot: "#22c55e" },
  UNSTABLE: { label: "BELUM STABIL", bg: "#fef3c7", fg: "#b45309", dot: "#f59e0b" },
  DISCONNECTED: { label: "SENSOR TERPUTUS", bg: "#fee2e2", fg: "#b91c1c", dot: "#ef4444" },
};

// Auto-scan barcode scanner fisik (tanpa menekan Enter)
const AUTO_SCAN_MIN_LENGTH = 8;
const AUTO_SCAN_DEBOUNCE_MS = 250;
const SCANNER_MAX_MS_PER_CHAR = 80;
const SCANNER_BURST_GAP_MS = 150;
const DUPLICATE_SCAN_WINDOW_MS = 2000;
const MANUAL_CLEANUP_DELAY_MS = 1000;

// Konfigurasi input manual barcode dari ENV (bisa diedit jika di-set "true" / "1")
const ALLOW_MANUAL_INPUT =
  process.env.NEXT_PUBLIC_ALLOW_MANUAL_INPUT === "true" ||
  process.env.NEXT_PUBLIC_ALLOW_MANUAL_INPUT === "1" ||
  process.env.NEXT_PUBLIC_ENABLE_MANUAL_INPUT === "true" ||
  process.env.NEXT_PUBLIC_BARCODE_MANUAL_INPUT === "true";

// Konfigurasi apakah nilai bobot <= 0 boleh diproses (true = konfirmasi TETAP PROSES / BATAL, false = blokir TUTUP)
const ALLOW_ZERO_OR_NEGATIVE_WEIGHT =
  process.env.NEXT_PUBLIC_ALLOW_ZERO_OR_NEGATIVE_WEIGHT === "true" ||
  process.env.NEXT_PUBLIC_ALLOW_ZERO_OR_NEGATIVE_WEIGHT === "1" ||
  process.env.NEXT_PUBLIC_ALLOW_ZERO_WEIGHT === "true" ||
  process.env.NEXT_PUBLIC_ALLOW_ZERO_WEIGHT === "1";

// Durasi idle otomatis kembali ke tampilan STANDBY dalam detik (default 10 detik, 0 = nonaktif)
const IDLE_TIMEOUT_SECONDS = parseInt(
  process.env.NEXT_PUBLIC_IDLE_TIMEOUT_SECONDS || "10",
  10
);

export default function PosTimbang() {
  const telemetry = useWeightStream();

  // States
  const [screenState, setScreenState] = useState<"STANDBY" | "SUCCESS" | "INVALID" | "ALREADY_CHECKIN" | "EXPIRED">("STANDBY");
  const [barcodeInput, setBarcodeInput] = useState("");
  const [searchType, setSearchType] = useState<"Kode Booking" | "No Tiket" | "Order ID">("Kode Booking");
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);
  const [validationResult, setValidationResult] = useState<{
    bookingCode?: string;
    ticketNumber?: string;
    licensePlate?: string;
    vehicleClass?: string;
    recordedWeight?: number;
    message?: string;
  } | null>(null);
  const [loading, setLoading] = useState(false);
  const [pendingScan, setPendingScan] = useState<{
    code: string;
    searchType: string;
    snapshot: { weight: number; isStable: boolean };
    forceDuplicate?: boolean;
  } | null>(null);
  const [pendingDisconnectedScan, setPendingDisconnectedScan] = useState<{
    code: string;
    searchType: string;
    forceDuplicate?: boolean;
  } | null>(null);
  const [pendingZeroWeightScan, setPendingZeroWeightScan] = useState<{
    code: string;
    searchType: string;
    weight: number;
    forceDuplicate?: boolean;
  } | null>(null);
  const [pendingDuplicateScan, setPendingDuplicateScan] = useState<{
    code: string;
    searchType?: string;
  } | null>(null);
  const [pendingNonGoodsScan, setPendingNonGoodsScan] = useState<{
    code: string;
    vehicleClass?: string;
  } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const manualResetTimerRef = useRef<NodeJS.Timeout | null>(null);
  const lastKeyTsRef = useRef(0);
  const burstStartRef = useRef(0);
  const burstCharsRef = useRef(0);
  const submittingRef = useRef(false);
  const lastSubmitRef = useRef({ value: "", ts: 0 });
  const validateRef = useRef<((input: string, options?: { snapshot?: { weight: number; isStable: boolean }; searchType?: string; forceDisconnected?: boolean; forceZeroWeight?: boolean; forceDuplicate?: boolean }) => Promise<void>) | null>(null);

  const apiBaseUrl = process.env.NEXT_PUBLIC_WEIGHBRIDGE_API_URL || process.env.NEXT_PUBLIC_WEIGHBRIDGE_URL || "http://localhost:8090";
  const operatorName = process.env.NEXT_PUBLIC_OPERATOR_NAME || "-";

  // Clean timer on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (manualResetTimerRef.current) clearTimeout(manualResetTimerRef.current);
  }, []);

  // Web Audio alert synthesizer
  const playAudioTone = useCallback((type: "SUCCESS" | "ALREADY_CHECKIN" | "EXPIRED" | "INVALID") => {
    if (typeof window === "undefined") return;
    try {
      const AudioCtx = window.AudioContext || (window as unknown as { webkitAudioContext: typeof AudioContext }).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      if (type === "SUCCESS") {
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.36);
      } else if (type === "ALREADY_CHECKIN") {
        osc.type = "triangle";
        osc.frequency.setValueAtTime(440.0, ctx.currentTime);
        gain.gain.setValueAtTime(0.35, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.38);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.39);
      } else {
        osc.type = "sawtooth";
        osc.frequency.setValueAtTime(220.0, ctx.currentTime);
        osc.frequency.linearRampToValueAtTime(140.0, ctx.currentTime + 0.35);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.38);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.39);
      }
    } catch {
      // Audio autoplay policy fallback
    }
  }, []);

  // Close dropdown on outside click
  useEffect(() => {
    const handleClickOutside = (e: MouseEvent) => {
      if (dropdownRef.current && !dropdownRef.current.contains(e.target as Node)) {
        setIsDropdownOpen(false);
      }
    };
    document.addEventListener("mousedown", handleClickOutside);
    return () => document.removeEventListener("mousedown", handleClickOutside);
  }, []);

  // Auto-focus scanner input
  useEffect(() => {
    if (inputRef.current) {
      if (screenState === "STANDBY") {
        inputRef.current.focus();
      } else {
        inputRef.current.select();
      }
    }
  }, [screenState]);

  // Global click refocus for physical barcode scanner
  useEffect(() => {
    const handleGlobalClick = (e: MouseEvent) => {
      if (pendingScan || pendingDisconnectedScan || pendingZeroWeightScan || pendingDuplicateScan || pendingNonGoodsScan) return;
      if (dropdownRef.current && dropdownRef.current.contains(e.target as Node)) {
        return;
      }
      if (inputRef.current) {
        if (screenState === "STANDBY") {
          inputRef.current.focus();
        } else {
          inputRef.current.select();
        }
      }
    };
    window.addEventListener("click", handleGlobalClick);
    return () => window.removeEventListener("click", handleGlobalClick);
  }, [screenState, pendingScan, pendingDisconnectedScan, pendingZeroWeightScan, pendingDuplicateScan, pendingNonGoodsScan]);

  // Keyboard shortcut: Space / Escape resets instantly to STANDBY
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (pendingNonGoodsScan) {
        if (e.code === "Escape" || e.code === "Enter" || e.code === "Space") {
          e.preventDefault();
          setPendingNonGoodsScan(null);
          setBarcodeInput("");
          if (inputRef.current) inputRef.current.focus();
        }
        return;
      }
      if (pendingDuplicateScan) {
        if (e.code === "Enter") {
          e.preventDefault();
          const pending = pendingDuplicateScan;
          setPendingDuplicateScan(null);
          if (validateRef.current) {
            validateRef.current(pending.code, { forceDuplicate: true, searchType: pending.searchType });
          }
        } else if (e.code === "Escape") {
          e.preventDefault();
          setPendingDuplicateScan(null);
          setBarcodeInput("");
          if (inputRef.current) inputRef.current.focus();
        }
        return;
      }
      if (pendingScan) {
        if (e.code === "Escape") {
          e.preventDefault();
          setPendingScan(null);
          setBarcodeInput("");
          if (inputRef.current) inputRef.current.focus();
        }
        return;
      }
      if (pendingDisconnectedScan) {
        if (e.code === "Enter") {
          e.preventDefault();
          const pending = pendingDisconnectedScan;
          setPendingDisconnectedScan(null);
          if (validateRef.current) {
            validateRef.current(pending.code, {
              forceDisconnected: true,
              forceDuplicate: pending.forceDuplicate,
              searchType: pending.searchType
            });
          }
        } else if (e.code === "Escape") {
          e.preventDefault();
          setPendingDisconnectedScan(null);
          setBarcodeInput("");
          if (inputRef.current) inputRef.current.focus();
        }
        return;
      }
      if (pendingZeroWeightScan) {
        if (e.code === "Enter" && ALLOW_ZERO_OR_NEGATIVE_WEIGHT) {
          e.preventDefault();
          const pending = pendingZeroWeightScan;
          setPendingZeroWeightScan(null);
          if (validateRef.current) {
            validateRef.current(pending.code, {
              forceZeroWeight: true,
              forceDuplicate: pending.forceDuplicate,
              searchType: pending.searchType,
              snapshot: { weight: pending.weight, isStable: true }
            });
          }
        } else if (e.code === "Escape") {
          e.preventDefault();
          setPendingZeroWeightScan(null);
          setBarcodeInput("");
          if (inputRef.current) inputRef.current.focus();
        }
        return;
      }
      if (screenState !== "STANDBY" && (e.code === "Space" || e.code === "Escape")) {
        e.preventDefault();
        setScreenState("STANDBY");
        setBarcodeInput("");
        setValidationResult(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [screenState, pendingScan, pendingDisconnectedScan, pendingZeroWeightScan, pendingDuplicateScan, pendingNonGoodsScan]);

  // Auto-reset ke tampilan kosong (STANDBY) saat idle selama durasi env (default 10 detik)
  useEffect(() => {
    if (IDLE_TIMEOUT_SECONDS <= 0) return;
    if (pendingScan || pendingDisconnectedScan || pendingZeroWeightScan || pendingDuplicateScan || pendingNonGoodsScan) return;
    if (screenState === "STANDBY" && !barcodeInput) return;

    const timer = setTimeout(() => {
      setScreenState("STANDBY");
      setBarcodeInput("");
      setValidationResult(null);
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }, IDLE_TIMEOUT_SECONDS * 1000);

    return () => clearTimeout(timer);
  }, [screenState, barcodeInput, pendingScan, pendingDisconnectedScan, pendingZeroWeightScan, pendingDuplicateScan, pendingNonGoodsScan]);

  // Validate barcode
  const validateBarcode = useCallback(async (rawInput: string, options: { snapshot?: { weight: number; isStable: boolean }; searchType?: string; forceDisconnected?: boolean; forceZeroWeight?: boolean; forceDuplicate?: boolean } = {}) => {
    const cleanInput = (rawInput || "").trim().toUpperCase();
    if (!cleanInput) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (submittingRef.current || (pendingScan && !options.snapshot) || (pendingDisconnectedScan && !options.forceDisconnected) || (pendingZeroWeightScan && !options.forceZeroWeight) || pendingDuplicateScan || pendingNonGoodsScan) return;

    const wt = options.snapshot || {
      weight: telemetry.weight,
      isStable: telemetry.isStable,
    };
    const reqSearchType = options.searchType || searchType;

    // 0. Cek ke backend apakah kode booking/tiket sudah pernah bertransaksi timbang hari ini: tampilkan popup konfirmasi
    if (!options.forceDuplicate) {
      try {
        const checkRes = await fetch(`${apiBaseUrl}/api/weighbridge/check-today?code=${encodeURIComponent(cleanInput)}`);
        if (checkRes.ok) {
          const isToday = await checkRes.json();
          if (isToday === true) {
            setPendingDuplicateScan({ code: cleanInput, searchType: reqSearchType });
            playAudioTone("ALREADY_CHECKIN");
            return;
          }
        }
      } catch (err) {
        console.warn("Gagal mengecek status transaksi hari ini dari server:", err);
      }
    }

    // 1. Cek jika sensor terputus: minta konfirmasi petugas apakah tetap memproses atau batal
    if (!options.forceDisconnected && !telemetry.isConnected) {
      setPendingDisconnectedScan({ code: cleanInput, searchType: reqSearchType, forceDuplicate: options.forceDuplicate });
      return;
    }

    // 2. Cek jika sensor terhubung tapi bobot <= 0 (0 atau minus): tahan dan tampilkan dialog konfirmasi/pemblokiran
    if (!options.forceZeroWeight && telemetry.isConnected && wt.weight <= 0) {
      setPendingZeroWeightScan({ code: cleanInput, searchType: reqSearchType, weight: wt.weight, forceDuplicate: options.forceDuplicate });
      return;
    }

    // 3. Cek jika sensor terhubung tapi bobot belum stabil: tahan dan tampilkan modal "Bobot Belum Stabil"
    if (!options.snapshot && telemetry.isConnected && !telemetry.isStable) {
      setPendingScan({ code: cleanInput, searchType: reqSearchType, snapshot: wt, forceDuplicate: options.forceDuplicate });
      return;
    }

    const now = Date.now();
    if (
      lastSubmitRef.current.value === cleanInput &&
      now - lastSubmitRef.current.ts < DUPLICATE_SCAN_WINDOW_MS
    ) {
      return;
    }
    submittingRef.current = true;
    lastSubmitRef.current = { value: cleanInput, ts: now };

    setLoading(true);

    try {
      const res = await fetch(`${apiBaseUrl}/api/weighbridge/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          barcodeInput: cleanInput,
          searchType: reqSearchType,
          actualWeight: wt.weight,
          isStable: wt.isStable,
          operatorUsername: operatorName !== "-" ? operatorName : undefined,
        }),
      });

      if (res.ok) {
        const result = await res.json();
        setValidationResult({
          bookingCode: result.bookingCode || cleanInput,
          ticketNumber: result.ticketNumber || "-",
          licensePlate: result.licensePlate || "-",
          vehicleClass: result.vehicleClass || "-",
          recordedWeight: result.recordedWeight != null ? result.recordedWeight : wt.weight,
          message: result.message || "BERHASIL INPUT BERAT KENDARAAN",
        });

        if (result.status === "SUCCESS") {
          setScreenState("SUCCESS");
          playAudioTone("SUCCESS");
          setBarcodeInput("");
          burstCharsRef.current = 0;
        } else if (result.status === "NON_GOODS_VEHICLE") {
          setPendingNonGoodsScan({
            code: result.bookingCode || cleanInput,
            vehicleClass: result.vehicleClass || "Penumpang",
          });
          playAudioTone("INVALID");
        } else if (result.status === "ALREADY_CHECKED_IN") {
          setScreenState("ALREADY_CHECKIN");
          playAudioTone("ALREADY_CHECKIN");
        } else if (result.status === "EXPIRED") {
          setScreenState("EXPIRED");
          playAudioTone("EXPIRED");
        } else {
          setScreenState("INVALID");
          playAudioTone("INVALID");
        }
      } else {
        const errorData = await res.json().catch(() => ({}));
        setValidationResult({
          bookingCode: cleanInput,
          recordedWeight: wt.weight,
          message: errorData.message || "KODE BOOKING TIDAK VALID",
        });
        setScreenState("INVALID");
        playAudioTone("INVALID");
      }
    } catch {
      setValidationResult({
        bookingCode: cleanInput,
        recordedWeight: wt.weight,
        message: "GAGAL MENGHUBUNGI SERVER SISTEM TIMBANGAN",
      });
      setScreenState("INVALID");
      playAudioTone("INVALID");
    } finally {
      submittingRef.current = false;
      setLoading(false);
      if (inputRef.current) {
        inputRef.current.focus();
      }
    }
  }, [apiBaseUrl, operatorName, pendingDisconnectedScan, pendingScan, pendingZeroWeightScan, playAudioTone, searchType, telemetry.isConnected, telemetry.isStable, telemetry.weight]);

  validateRef.current = validateBarcode;

  const handleValidate = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (manualResetTimerRef.current) clearTimeout(manualResetTimerRef.current);
    const targetInput = (inputRef.current?.value || barcodeInput || "").trim();
    const now = Date.now();
    const chars = burstCharsRef.current;
    const msPerChar = (now - burstStartRef.current) / Math.max(chars - 1, 1);
    const isScannerBurst = chars >= AUTO_SCAN_MIN_LENGTH && msPerChar <= SCANNER_MAX_MS_PER_CHAR;

    if (!isScannerBurst && !ALLOW_MANUAL_INPUT) {
      // Ketikan manual ditekan Enter tapi manual input tidak diizinkan via ENV: tolak senyap dan auto-clear input
      setBarcodeInput("");
      burstCharsRef.current = 0;
      return;
    }

    validateBarcode(targetInput);
  };

  const handleCancelUnstable = () => {
    setPendingScan(null);
    setBarcodeInput("");
    if (inputRef.current) inputRef.current.focus();
  };

  const handleCancelDisconnected = () => {
    setPendingDisconnectedScan(null);
    setBarcodeInput("");
    if (inputRef.current) inputRef.current.focus();
  };

  const handleConfirmDisconnected = () => {
    const pending = pendingDisconnectedScan;
    if (!pending) return;
    setPendingDisconnectedScan(null);
    validateBarcode(pending.code, {
      forceDisconnected: true,
      forceDuplicate: pending.forceDuplicate,
      searchType: pending.searchType
    });
  };

  const handleCancelZeroWeight = () => {
    setPendingZeroWeightScan(null);
    setBarcodeInput("");
    if (inputRef.current) inputRef.current.focus();
  };

  const handleConfirmZeroWeight = () => {
    const pending = pendingZeroWeightScan;
    if (!pending) return;
    setPendingZeroWeightScan(null);
    validateBarcode(pending.code, {
      forceZeroWeight: true,
      forceDuplicate: pending.forceDuplicate,
      searchType: pending.searchType,
      snapshot: { weight: pending.weight, isStable: true }
    });
  };

  const handleCancelDuplicate = () => {
    setPendingDuplicateScan(null);
    setBarcodeInput("");
    if (inputRef.current) inputRef.current.focus();
  };

  const handleConfirmDuplicate = () => {
    const pending = pendingDuplicateScan;
    if (!pending) return;
    setPendingDuplicateScan(null);
    validateBarcode(pending.code, { forceDuplicate: true, searchType: pending.searchType });
  };

  const handleCloseNonGoodsModal = () => {
    setPendingNonGoodsScan(null);
    setBarcodeInput("");
    if (inputRef.current) inputRef.current.focus();
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    const now = Date.now();
    const isNewBurst = now - lastKeyTsRef.current > SCANNER_BURST_GAP_MS;

    if (isNewBurst || value.length <= 1) {
      burstStartRef.current = now;
      burstCharsRef.current = value.length;
    } else {
      burstCharsRef.current += Math.max(value.length - barcodeInput.length, 1);
    }
    lastKeyTsRef.current = now;

    setBarcodeInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (manualResetTimerRef.current) clearTimeout(manualResetTimerRef.current);

    if (value.trim().length === 0) return;

    const chars = burstCharsRef.current;
    const msPerChar = (now - burstStartRef.current) / Math.max(chars - 1, 1);
    const isScannerBurst = chars >= AUTO_SCAN_MIN_LENGTH && msPerChar <= SCANNER_MAX_MS_PER_CHAR;

    if (isScannerBurst) {
      debounceRef.current = setTimeout(() => {
        if (validateRef.current) validateRef.current(value);
      }, AUTO_SCAN_DEBOUNCE_MS);
    } else if (!ALLOW_MANUAL_INPUT) {
      // Ketikan manual: jika tidak diizinkan via ENV, abaikan dan auto-clear senyap
      manualResetTimerRef.current = setTimeout(() => {
        setBarcodeInput("");
        burstCharsRef.current = 0;
      }, MANUAL_CLEANUP_DELAY_MS);
    }
  };

  const displayWeight = validationResult?.recordedWeight != null
    ? Math.round(validationResult.recordedWeight).toLocaleString("id-ID")
    : Math.round(telemetry.weight).toLocaleString("id-ID");

  const liveWeightText = Math.round(telemetry.weight).toLocaleString("id-ID");
  const stabilityKey = !telemetry.isConnected ? "DISCONNECTED" : telemetry.isStable ? "STABLE" : "UNSTABLE";
  const stabilityBadge = STABILITY_BADGE[stabilityKey];

  return (
    <div style={{ minHeight: "100vh", display: "flex", flexDirection: "column", backgroundColor: "#ffffff", fontFamily: "Arial, Helvetica, sans-serif" }}>
      <style>{`
        @keyframes fadeIn { from { opacity: 0; transform: translateY(4px); } to { opacity: 1; transform: none; } }
        @keyframes pulseDot { 0%, 100% { opacity: 1; } 50% { opacity: 0.3; } }
        @keyframes spin { from { transform: rotate(0deg); } to { transform: rotate(360deg); } }
      `}</style>

      {/* ========================================================= */}
      {/* HEADER ASDP RESMI (PERSIS DOKUMEN & REPO EKSISTING)        */}
      {/* ========================================================= */}
      <header style={{ width: "100%", backgroundColor: "#ffffff", borderBottom: "2px solid #0056b3" }}>
        <div style={{
          maxWidth: "1160px",
          margin: "0 auto",
          padding: "0 24px",
          boxSizing: "border-box"
        }}>
          <div style={{ position: "relative", width: "100%", aspectRatio: "6480 / 616" }}>
            <Image
              src="/assets/images/header_banner.png"
              alt="ASDP Header Banner Resmi"
              fill
              style={{ objectFit: "contain", objectPosition: "center" }}
              priority
            />
          </div>
        </div>
      </header>

      {/* ========================================================= */}
      {/* SUB-BAR STATUS OPERATOR POS TIMBANG                       */}
      {/* ========================================================= */}
      <div style={{
        backgroundColor: "#ffffff",
        borderBottom: "1px solid #e2e8f0",
        padding: "6px 0"
      }}>
        <div style={{
          maxWidth: "1160px",
          margin: "0 auto",
          padding: "0 24px",
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          boxSizing: "border-box"
        }}>
          <div style={{ display: "flex", alignItems: "center", gap: "10px" }}>
            <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 600 }}>
              TERMINAL POS JEMBATAN TIMBANG
            </span>
          </div>

          <div style={{ display: "flex", alignItems: "center", gap: "14px" }}>
            <span style={{ fontSize: "12px", color: "#64748b", fontWeight: 500 }}>
              Operator: <strong style={{ color: "#0f172a" }}>{operatorName}</strong>
            </span>
            <span style={{
              display: "inline-flex",
              alignItems: "center",
              gap: "6px",
              fontSize: "11px",
              fontWeight: 700,
              padding: "2px 8px",
              borderRadius: "4px",
              backgroundColor: telemetry.isConnected ? "#dcfce7" : "#fee2e2",
              color: telemetry.isConnected ? "#15803d" : "#b91c1c"
            }}>
              <span style={{
                width: "6px",
                height: "6px",
                borderRadius: "50%",
                backgroundColor: telemetry.isConnected ? "#22c55e" : "#ef4444"
              }} />
              {telemetry.isConnected ? "SENSOR CONNECTED" : "DISCONNECTED"}
            </span>
          </div>
        </div>
      </div>

      {/* ========================================================= */}
      {/* MAIN WORK AREA (PERSIS GAMBAR #2 SPESIFIKASI ASDP)        */}
      {/* ========================================================= */}
      <main style={{
        flex: 1,
        padding: "32px 24px",
        maxWidth: "1160px",
        width: "100%",
        margin: "0 auto",
        display: "flex",
        flexDirection: "column",
        gap: "32px",
        boxSizing: "border-box"
      }}>
        {/* ROW DUA KOTAK SEJAJAR */}
        <div style={{
          display: "flex",
          justifyContent: "center",
          alignItems: "flex-start",
          gap: "44px",
          width: "100%"
        }}>
          {/* -------------------------------------------------------- */}
          {/* SISI KIRI: INLINE DROPDOWN & FORM SCAN BARCODE           */}
          {/* -------------------------------------------------------- */}
          <div style={{ flex: "1 1 0", minWidth: 0 }}>
            <div style={{
              backgroundColor: "#ffffff",
              border: "1.5px solid #e2e8f0",
              borderRadius: "20px",
              minHeight: "480px",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              justifyContent: "flex-start",
              padding: "48px 28px",
              boxSizing: "border-box"
            }}>
              <h3 style={{ fontSize: "13px", fontWeight: 700, color: "#64748b", letterSpacing: "1px", margin: "0 0 14px 0" }}>
                PEMINDAIAN TIKET
              </h3>
              <form onSubmit={handleValidate} style={{ display: "flex", alignItems: "flex-start", gap: "14px" }}>
                {/* Custom Dropdown Selector */}
                <div ref={dropdownRef} style={{ position: "relative", width: "160px" }}>
                  <button
                    type="button"
                    onClick={() => setIsDropdownOpen((prev) => !prev)}
                    style={{
                      width: "100%",
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      padding: "9px 14px",
                      borderRadius: "8px",
                      border: "1.5px solid #cbd5e1",
                      backgroundColor: "#ffffff",
                      fontSize: "14px",
                      fontWeight: 500,
                      color: "#334155",
                      cursor: "pointer",
                      outline: "none"
                    }}
                  >
                    <span>{searchType}</span>
                    <svg
                      width="14"
                      height="14"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#64748b"
                      strokeWidth="2.5"
                      strokeLinecap="round"
                      strokeLinejoin="round"
                      style={{
                        transform: isDropdownOpen ? "rotate(180deg)" : "rotate(0deg)",
                        transition: "transform 0.15s ease"
                      }}
                    >
                      <polyline points="6 9 12 15 18 9" />
                    </svg>
                  </button>

                  {/* Dropdown Menu Popover */}
                  {isDropdownOpen && (
                    <div
                      style={{
                        position: "absolute",
                        top: "calc(100% + 4px)",
                        left: 0,
                        width: "100%",
                        backgroundColor: "#ffffff",
                        border: "1px solid #e2e8f0",
                        borderRadius: "8px",
                        boxShadow: "0 4px 12px rgba(0,0,0,0.08)",
                        padding: "4px",
                        zIndex: 50,
                        display: "flex",
                        flexDirection: "column",
                        gap: "2px"
                      }}
                    >
                      {(["Kode Booking", "No Tiket", "Order ID"] as const).map((option) => {
                        const isSelected = searchType === option;
                        return (
                          <div
                            key={option}
                            onClick={() => {
                              setSearchType(option);
                              setIsDropdownOpen(false);
                              if (inputRef.current) inputRef.current.focus();
                            }}
                            style={{
                              padding: "8px 12px",
                              borderRadius: "6px",
                              backgroundColor: isSelected ? "#f1f5f9" : "transparent",
                              color: isSelected ? "#0f172a" : "#475569",
                              fontWeight: isSelected ? 600 : 500,
                              fontSize: "13px",
                              cursor: "pointer",
                              transition: "background-color 0.15s"
                            }}
                          >
                            {option}
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>

                {/* Input Barcode Scanner */}
                <div style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", gap: "6px" }}>
                  <div style={{ position: "relative", width: "100%" }}>
                    <input
                      ref={inputRef}
                      type="text"
                      value={barcodeInput}
                      onChange={handleInputChange}
                      onKeyDown={(e) => {
                        if (e.key === "Enter") {
                          e.preventDefault();
                          handleValidate();
                        }
                      }}
                      onPaste={ALLOW_MANUAL_INPUT ? undefined : (e) => e.preventDefault()}
                      placeholder={loading ? "Memvalidasi tiket..." : "Scan Barcode untuk input"}
                      readOnly={loading || !!pendingScan || !!pendingDisconnectedScan || !!pendingZeroWeightScan}
                      autoComplete="off"
                      style={{
                        width: "100%",
                        padding: "9px 14px",
                        paddingRight: loading ? "38px" : "14px",
                        borderRadius: "8px",
                        border: loading ? "1.5px solid #0284c7" : "1.5px solid #cbd5e1",
                        fontSize: "15px",
                        color: "#0f172a",
                        fontWeight: 600,
                        outline: "none",
                        backgroundColor: loading ? "#f8fafc" : "#ffffff",
                        boxSizing: "border-box",
                        transition: "border-color 0.15s, background-color 0.15s"
                      }}
                    />
                    {loading && (
                      <div style={{
                        position: "absolute",
                        right: "12px",
                        top: "50%",
                        transform: "translateY(-50%)",
                        display: "flex",
                        alignItems: "center",
                        pointerEvents: "none"
                      }}>
                        <svg
                          width="18"
                          height="18"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="#0284c7"
                          strokeWidth="3"
                          strokeLinecap="round"
                          style={{ animation: "spin 0.75s linear infinite" }}
                        >
                          <circle cx="12" cy="12" r="10" stroke="#cbd5e1" strokeWidth="3" />
                          <path d="M12 2 A 10 10 0 0 1 22 12" />
                        </svg>
                      </div>
                    )}
                  </div>
                  <span style={{
                    fontSize: "12px",
                    color: loading ? "#0284c7" : "#64748b",
                    fontWeight: loading ? 600 : 400,
                    display: "flex",
                    alignItems: "center",
                    gap: "6px"
                  }}>
                    {loading ? (
                      <>
                        <span style={{
                          display: "inline-block",
                          width: "6px",
                          height: "6px",
                          borderRadius: "50%",
                          backgroundColor: "#0284c7",
                          animation: "pulseDot 0.8s infinite"
                        }} />
                        Sedang memvalidasi ke sistem backend...
                      </>
                    ) : (
                      ALLOW_MANUAL_INPUT
                        ? "Scan Barcode untuk input (Spasi / Esc reset)"
                        : "Hanya menerima pemindaian barcode scanner (Input keyboard dinonaktifkan)"
                    )}
                  </span>
                </div>
                <button type="submit" style={{ display: "none" }} aria-hidden="true" tabIndex={-1} />
              </form>
            </div>
          </div>

          {/* -------------------------------------------------------- */}
          {/* SISI KANAN: STATUS CARD SESUAI GAMBAR #2                 */}
          {/* -------------------------------------------------------- */}
          <div style={{ flex: "1 1 0", minWidth: 0 }}>
            <div style={{
              backgroundColor: "#f1f5f9",
              borderRadius: "20px",
              minHeight: "480px",
              width: "100%",
              display: "flex",
              flexDirection: "column",
              alignItems: "center",
              justifyContent: "flex-start",
              padding: "48px 32px",
              boxSizing: "border-box",
              textAlign: "center",
              boxShadow: "inset 0 1px 2px rgba(0,0,0,0.02)"
            }}>

              {/* STATUS 0: MEMVALIDASI KE BACKEND (LOADING) */}
              {loading && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", animation: "fadeIn 0.25s" }}>
                  <div style={{
                    width: "90px",
                    height: "90px",
                    borderRadius: "50%",
                    backgroundColor: "#ffffff",
                    border: "5px solid #e0f2fe",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 16px rgba(2, 132, 199, 0.15)",
                    marginBottom: "24px"
                  }}>
                    <svg
                      width="46"
                      height="46"
                      viewBox="0 0 24 24"
                      fill="none"
                      stroke="#0284c7"
                      strokeWidth="3"
                      strokeLinecap="round"
                      style={{ animation: "spin 0.8s linear infinite" }}
                    >
                      <circle cx="12" cy="12" r="10" stroke="#e2e8f0" strokeWidth="3" />
                      <path d="M12 2 A 10 10 0 0 1 22 12" />
                    </svg>
                  </div>

                  <h2 style={{
                    fontSize: "26px",
                    fontWeight: 800,
                    color: "#0f172a",
                    lineHeight: 1.25,
                    margin: "0 0 8px 0",
                    letterSpacing: "-0.5px"
                  }}>
                    MEMVALIDASI TIKET...
                  </h2>
                  <p style={{ fontSize: "14px", color: "#64748b", margin: 0, fontWeight: 500 }}>
                    Menghubungi sistem database loket ASDP
                  </p>
                </div>
              )}

              {/* ===================================================== */}
              {/* STATUS 1: SUKSES (PERSIS GAMBAR #2)                   */}
              {/* ===================================================== */}
              {!loading && screenState === "SUCCESS" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", animation: "fadeIn 0.3s" }}>
                  {/* Outline Green Checkmark Icon (Persis Gambar #2) */}
                  <div style={{
                    width: "90px",
                    height: "90px",
                    borderRadius: "50%",
                    backgroundColor: "#ffffff",
                    border: "6px solid #22c55e",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 2px 8px rgba(34, 197, 94, 0.15)",
                    marginBottom: "24px"
                  }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#22c55e" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <polyline points="20 6 9 17 4 12" />
                    </svg>
                  </div>

                  {/* Title Header */}
                  <h2 style={{
                    fontSize: "26px",
                    fontWeight: 800,
                    color: "#0f172a",
                    lineHeight: 1.25,
                    margin: "0 0 24px 0",
                    letterSpacing: "-0.5px"
                  }}>
                    BERHASIL INPUT<br />BERAT KENDARAAN
                  </h2>

                  {/* White Box with Border: Nilai Bobot (Persis Gambar #2) */}
                  <div style={{
                    backgroundColor: "#ffffff",
                    border: "1.5px solid #cbd5e1",
                    borderRadius: "10px",
                    padding: "16px 56px",
                    minWidth: "260px",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
                  }}>
                    <span style={{
                      fontSize: "32px",
                      fontWeight: 800,
                      color: "#0f172a",
                      letterSpacing: "0.5px"
                    }}>
                      {displayWeight} kg
                    </span>
                  </div>
                </div>
              )}

              {/* ===================================================== */}
              {/* STATUS 2: KODE BOOKING TIDAK VALID                    */}
              {/* ===================================================== */}
              {!loading && screenState === "INVALID" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", animation: "fadeIn 0.3s" }}>
                  <div style={{
                    width: "90px",
                    height: "90px",
                    borderRadius: "50%",
                    backgroundColor: "#ef4444",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 12px rgba(239, 68, 68, 0.25)",
                    marginBottom: "24px"
                  }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>

                  <h2 style={{
                    fontSize: "26px",
                    fontWeight: 800,
                    color: "#0f172a",
                    lineHeight: 1.25,
                    margin: "0",
                    letterSpacing: "-0.5px"
                  }}>
                    {validationResult?.message ? (
                      validationResult.message.includes(" ") ? (
                        <>
                          {validationResult.message.substring(0, validationResult.message.lastIndexOf(" "))}<br />
                          {validationResult.message.substring(validationResult.message.lastIndexOf(" ") + 1)}
                        </>
                      ) : (
                        validationResult.message
                      )
                    ) : (
                      <>
                        KODE BOOKING<br />TIDAK VALID
                      </>
                    )}
                  </h2>
                </div>
              )}

              {/* ===================================================== */}
              {/* STATUS 3: TIKET SUDAH CHECK IN (KUNING / WARNING)    */}
              {/* ===================================================== */}
              {!loading && screenState === "ALREADY_CHECKIN" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", animation: "fadeIn 0.3s" }}>
                  <div style={{
                    width: "90px",
                    height: "90px",
                    borderRadius: "50%",
                    backgroundColor: "#f59e0b",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 12px rgba(245, 158, 11, 0.25)",
                    marginBottom: "24px"
                  }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>

                  <h2 style={{
                    fontSize: "26px",
                    fontWeight: 800,
                    color: "#0f172a",
                    lineHeight: 1.25,
                    margin: "0",
                    letterSpacing: "-0.5px"
                  }}>
                    TIKET SUDAH<br />CHECK IN
                  </h2>
                </div>
              )}

              {/* ===================================================== */}
              {/* STATUS 4: TIKET EXPIRED                               */}
              {/* ===================================================== */}
              {!loading && screenState === "EXPIRED" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", animation: "fadeIn 0.3s" }}>
                  <div style={{
                    width: "90px",
                    height: "90px",
                    borderRadius: "50%",
                    backgroundColor: "#ef4444",
                    display: "flex",
                    alignItems: "center",
                    justifyContent: "center",
                    boxShadow: "0 4px 12px rgba(239, 68, 68, 0.25)",
                    marginBottom: "24px"
                  }}>
                    <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="#ffffff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                      <line x1="12" y1="8" x2="12" y2="12" />
                      <line x1="12" y1="16" x2="12.01" y2="16" />
                    </svg>
                  </div>

                  <h2 style={{
                    fontSize: "26px",
                    fontWeight: 800,
                    color: "#0f172a",
                    lineHeight: 1.25,
                    margin: "0",
                    letterSpacing: "-0.5px"
                  }}>
                    TIKET EXPIRED
                  </h2>
                </div>
              )}

              {/* STATUS 5: STANDBY (MENUNGGU SCAN) */}
              {!loading && screenState === "STANDBY" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", width: "100%", animation: "fadeIn 0.3s" }}>
                  <span style={{ fontSize: "13px", fontWeight: 700, color: "#64748b", letterSpacing: "1px", marginBottom: "12px" }}>
                    BERAT KENDARAAN SAAT INI
                  </span>

                  {/* Streaming bobot dari adapter timbangan */}
                  <div style={{
                    backgroundColor: "#ffffff",
                    border: "1.5px solid #cbd5e1",
                    borderRadius: "10px",
                    padding: "20px 40px",
                    minWidth: "300px",
                    boxShadow: "0 1px 3px rgba(0,0,0,0.04)"
                  }}>
                    <span style={{
                      fontSize: "52px",
                      fontWeight: 800,
                      color: telemetry.isConnected ? "#0f172a" : "#94a3b8",
                      fontVariantNumeric: "tabular-nums",
                      letterSpacing: "0.5px"
                    }}>
                      {liveWeightText} KG
                    </span>
                  </div>

                  {/* Badge kestabilan: STABIL / BELUM STABIL / SENSOR TERPUTUS */}
                  <span
                    role="status"
                    aria-live="polite"
                    style={{
                      marginTop: "18px",
                      display: "inline-flex",
                      alignItems: "center",
                      gap: "8px",
                      backgroundColor: stabilityBadge.bg,
                      color: stabilityBadge.fg,
                      borderRadius: "999px",
                      padding: "6px 18px",
                      fontSize: "14px",
                      fontWeight: 800,
                      letterSpacing: "0.5px"
                    }}
                  >
                    <span style={{
                      width: "10px",
                      height: "10px",
                      borderRadius: "50%",
                      backgroundColor: stabilityBadge.dot,
                      animation: stabilityKey === "UNSTABLE" ? "pulseDot 1s ease-in-out infinite" : "none"
                    }} />
                    {stabilityBadge.label}
                  </span>

                  <h3 style={{ fontSize: "18px", fontWeight: 700, color: "#334155", margin: "36px 0 6px 0" }}>
                    SILAKAN SCAN TIKET KENDARAAN
                  </h3>
                  <p style={{ fontSize: "13px", color: "#64748b", margin: 0 }}>
                    Arahkan scanner ke barcode tiket atau masukkan kode booking
                  </p>
                </div>
              )}

            </div>
          </div>
        </div>
      </main>

      {/* POPUP KONFIRMASI BOBOT BELUM STABIL (DISAMAKAN DENGAN MODALCONFIRMATION DI LOKET-WEB-APP-FE) */}
      {pendingScan && (
        <div style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "20px"
        }}>
          <div style={{
            position: "relative",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            maxWidth: "450px",
            width: "100%",
            padding: "24px 20px 24px 20px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            boxSizing: "border-box"
          }}>
            {/* HelpOutline Icon Blue */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginTop: "4px" }}>
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#1A73E8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="2.5" />
              </svg>
            </div>

            {/* Title */}
            <h3 style={{
              fontSize: "18px",
              fontWeight: 700,
              color: "#344767",
              textAlign: "center",
              lineHeight: "20px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "0px"
            }}>
              Bobot Belum Stabil
            </h3>

            {/* Description */}
            <p style={{
              fontSize: "16px",
              fontWeight: 400,
              color: "#475569",
              textAlign: "center",
              lineHeight: "22px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "24px"
            }}>
              Bobot belum stabil (kendaraan kemungkinan masih bergerak). Silakan tunggu hingga kendaraan berhenti sempurna dan indikator menjadi STABIL sebelum memindai tiket kembali.
            </p>

            {/* Action Buttons: Tunggu Stabil Single Button */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", width: "100%" }}>
              <button
                type="button"
                onClick={handleCancelUnstable}
                style={{
                  height: "36px",
                  padding: "6px 24px",
                  borderRadius: "6px",
                  border: "none",
                  backgroundColor: "#1A73E8",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  cursor: "pointer",
                  boxShadow: "0 3px 5px -1px rgba(26, 115, 232, 0.3)"
                }}
              >
                Tunggu Stabil
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POPUP KONFIRMASI SENSOR TERPUTUS */}
      {pendingDisconnectedScan && (
        <div style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "20px"
        }}>
          <div style={{
            position: "relative",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            maxWidth: "450px",
            width: "100%",
            padding: "24px 20px 24px 20px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            boxSizing: "border-box"
          }}>
            {/* HelpOutline Icon */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginTop: "4px" }}>
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#1A73E8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="2.5" />
              </svg>
            </div>

            {/* Title */}
            <h3 style={{
              fontSize: "18px",
              fontWeight: 700,
              color: "#344767",
              textAlign: "center",
              lineHeight: "20px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "0px"
            }}>
              Sensor Timbangan Terputus
            </h3>

            {/* Description */}
            <p style={{
              fontSize: "16px",
              fontWeight: 400,
              color: "#475569",
              textAlign: "center",
              lineHeight: "22px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "24px"
            }}>
              Koneksi ke alat jembatan timbang terputus. Kendaraan akan diproses tanpa data berat timbangan (NOT_WEIGHED). Apakah Anda yakin ingin tetap memproses tiket ini?
            </p>

            {/* Action Buttons: TETAP PROSES & BATAL */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", width: "100%" }}>
              <button
                type="button"
                onClick={handleConfirmDisconnected}
                style={{
                  height: "36px",
                  padding: "6px 20px",
                  borderRadius: "6px",
                  border: "none",
                  backgroundColor: "#1A73E8",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  cursor: "pointer",
                  boxShadow: "0 3px 5px -1px rgba(26, 115, 232, 0.3)"
                }}
              >
                Tetap Proses
              </button>
              <button
                type="button"
                onClick={handleCancelDisconnected}
                style={{
                  height: "36px",
                  padding: "6px 20px",
                  borderRadius: "6px",
                  border: "1.5px solid #1A73E8",
                  backgroundColor: "transparent",
                  color: "#1A73E8",
                  fontSize: "13px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  cursor: "pointer"
                }}
              >
                Batal
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POPUP KONFIRMASI / BLOKIR BOBOT <= 0 (0 ATAU MINUS) */}
      {pendingZeroWeightScan && (
        <div style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "20px"
        }}>
          <div style={{
            position: "relative",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            maxWidth: "450px",
            width: "100%",
            padding: "24px 20px 24px 20px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            boxSizing: "border-box"
          }}>
            {/* HelpOutline Icon Blue */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginTop: "4px" }}>
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#1A73E8" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <path d="M9.09 9a3 3 0 0 1 5.83 1c0 2-3 3-3 3" />
                <line x1="12" y1="17" x2="12.01" y2="17" strokeWidth="2.5" />
              </svg>
            </div>

            {/* Title */}
            <h3 style={{
              fontSize: "18px",
              fontWeight: 700,
              color: "#344767",
              textAlign: "center",
              lineHeight: "20px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "0px"
            }}>
              {ALLOW_ZERO_OR_NEGATIVE_WEIGHT ? "Konfirmasi Bobot ≤ 0 kg" : "Bobot Tidak Valid (≤ 0 kg)"}
            </h3>

            {/* Description */}
            <p style={{
              fontSize: "16px",
              fontWeight: 400,
              color: "#475569",
              textAlign: "center",
              lineHeight: "22px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "24px"
            }}>
              {ALLOW_ZERO_OR_NEGATIVE_WEIGHT
                ? "Timbangan membaca 0 kg atau minus. Kendaraan akan diproses tanpa data berat (NOT_WEIGHED). Lanjutkan proses?"
                : "Timbangan membaca 0 kg atau minus. Pastikan kendaraan sudah berada di platform timbangan sebelum scan kembali."}
            </p>

            {/* Action Buttons */}
            {ALLOW_ZERO_OR_NEGATIVE_WEIGHT ? (
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", width: "100%" }}>
                <button
                  type="button"
                  onClick={handleConfirmZeroWeight}
                  style={{
                    height: "36px",
                    padding: "6px 20px",
                    borderRadius: "6px",
                    border: "none",
                    backgroundColor: "#1A73E8",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    cursor: "pointer",
                    boxShadow: "0 3px 5px -1px rgba(26, 115, 232, 0.3)"
                  }}
                >
                  Tetap Proses
                </button>
                <button
                  type="button"
                  onClick={handleCancelZeroWeight}
                  style={{
                    height: "36px",
                    padding: "6px 20px",
                    borderRadius: "6px",
                    border: "1.5px solid #1A73E8",
                    backgroundColor: "transparent",
                    color: "#1A73E8",
                    fontSize: "13px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    cursor: "pointer"
                  }}
                >
                  Batal
                </button>
              </div>
            ) : (
              <div style={{ display: "flex", justifyContent: "center", alignItems: "center", width: "100%" }}>
                <button
                  type="button"
                  onClick={handleCancelZeroWeight}
                  style={{
                    height: "36px",
                    padding: "6px 24px",
                    borderRadius: "6px",
                    border: "none",
                    backgroundColor: "#1A73E8",
                    color: "#ffffff",
                    fontSize: "13px",
                    fontWeight: 700,
                    textTransform: "uppercase",
                    letterSpacing: "0.5px",
                    cursor: "pointer",
                    boxShadow: "0 3px 5px -1px rgba(26, 115, 232, 0.3)"
                  }}
                >
                  Tutup
                </button>
              </div>
            )}
          </div>
        </div>
      )}

      {/* POPUP NOTIFIKASI KODE BOOKING SAMA (DUPLICATE SCAN) */}
      {pendingDuplicateScan && (
        <div style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "20px"
        }}>
          <div style={{
            position: "relative",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            maxWidth: "450px",
            width: "100%",
            padding: "24px 20px 24px 20px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            boxSizing: "border-box"
          }}>
            {/* Warning Icon */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginTop: "4px" }}>
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#f59e0b" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" strokeWidth="2.5" />
              </svg>
            </div>

            {/* Title */}
            <h3 style={{
              fontSize: "18px",
              fontWeight: 700,
              color: "#344767",
              textAlign: "center",
              lineHeight: "20px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "0px"
            }}>
              Kode Booking Sudah Diproses
            </h3>

            {/* Description */}
            <p style={{
              fontSize: "16px",
              fontWeight: 400,
              color: "#475569",
              textAlign: "center",
              lineHeight: "22px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "24px"
            }}>
              Tiket dengan kode booking <strong>{pendingDuplicateScan.code}</strong> sudah berhasil diproses sebelumnya. Apakah Anda ingin melakukan penimbangan ulang untuk tiket ini?
            </p>

            {/* Action Buttons: TETAP PROSES & BATAL */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", gap: "10px", width: "100%" }}>
              <button
                type="button"
                onClick={handleConfirmDuplicate}
                style={{
                  height: "36px",
                  padding: "6px 20px",
                  borderRadius: "6px",
                  border: "none",
                  backgroundColor: "#1A73E8",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  cursor: "pointer",
                  boxShadow: "0 3px 5px -1px rgba(26, 115, 232, 0.3)"
                }}
              >
                Tetap Proses
              </button>
              <button
                type="button"
                onClick={handleCancelDuplicate}
                style={{
                  height: "36px",
                  padding: "6px 20px",
                  borderRadius: "6px",
                  border: "1.5px solid #1A73E8",
                  backgroundColor: "transparent",
                  color: "#1A73E8",
                  fontSize: "13px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  cursor: "pointer"
                }}
              >
                Batal
              </button>
            </div>
          </div>
        </div>
      )}

      {/* POPUP NOTIFIKASI GOLONGAN BUKAN BARANG */}
      {pendingNonGoodsScan && (
        <div style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(0, 0, 0, 0.5)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "20px"
        }}>
          <div style={{
            position: "relative",
            backgroundColor: "#ffffff",
            borderRadius: "8px",
            maxWidth: "450px",
            width: "100%",
            padding: "24px 20px 24px 20px",
            boxShadow: "0 10px 25px -5px rgba(0, 0, 0, 0.2), 0 8px 10px -6px rgba(0, 0, 0, 0.1)",
            display: "flex",
            flexDirection: "column",
            alignItems: "center",
            boxSizing: "border-box"
          }}>
            {/* Warning Icon */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", marginTop: "4px" }}>
              <svg width="80" height="80" viewBox="0 0 24 24" fill="none" stroke="#ef4444" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round">
                <circle cx="12" cy="12" r="10" />
                <line x1="12" y1="8" x2="12" y2="12" />
                <line x1="12" y1="16" x2="12.01" y2="16" strokeWidth="2.5" />
              </svg>
            </div>

            {/* Title */}
            <h3 style={{
              fontSize: "18px",
              fontWeight: 700,
              color: "#344767",
              textAlign: "center",
              lineHeight: "20px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "0px"
            }}>
              Bukan Kendaraan Barang
            </h3>

            {/* Description */}
            <p style={{
              fontSize: "16px",
              fontWeight: 400,
              color: "#475569",
              textAlign: "center",
              lineHeight: "22px",
              margin: 0,
              paddingTop: "14px",
              paddingBottom: "24px"
            }}>
              Tiket dengan kode booking <strong>{pendingNonGoodsScan.code}</strong> terdaftar sebagai <strong>{pendingNonGoodsScan.vehicleClass || "Golongan Penumpang"}</strong>. Jembatan timbang hanya diperuntukkan bagi kendaraan barang / muatan.
            </p>

            {/* Action Button: TUTUP */}
            <div style={{ display: "flex", justifyContent: "center", alignItems: "center", width: "100%" }}>
              <button
                type="button"
                onClick={handleCloseNonGoodsModal}
                style={{
                  height: "36px",
                  padding: "6px 28px",
                  borderRadius: "6px",
                  border: "none",
                  backgroundColor: "#1A73E8",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 700,
                  textTransform: "uppercase",
                  letterSpacing: "0.5px",
                  cursor: "pointer",
                  boxShadow: "0 3px 5px -1px rgba(26, 115, 232, 0.3)"
                }}
              >
                Tutup
              </button>
            </div>
          </div>
        </div>
      )}

      {/* FOOTER ASDP */}
      <footer style={{
        borderTop: "1px solid #e2e8f0",
        padding: "14px 24px",
        backgroundColor: "#ffffff",
        fontSize: "12px",
        color: "#64748b",
        display: "flex",
        justifyContent: "space-between",
        alignItems: "center"
      }}>
        <span>© 2026 PT ASDP Indonesia Ferry (Persero) • We Bridge The Nation</span>
        <span style={{ fontWeight: 600 }}>v1.2.0-weighbridge-asdp-official</span>
      </footer>
    </div>
  );
}
