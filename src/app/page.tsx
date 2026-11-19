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
    snapshot: { weight: number; isStable: boolean; deviceId: string };
  } | null>(null);

  const inputRef = useRef<HTMLInputElement>(null);
  const dropdownRef = useRef<HTMLDivElement>(null);

  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const lastKeyTsRef = useRef(0);
  const burstStartRef = useRef(0);
  const burstCharsRef = useRef(0);
  const submittingRef = useRef(false);
  const lastSubmitRef = useRef({ value: "", ts: 0 });
  const validateRef = useRef<((input: string, options?: { snapshot?: { weight: number; isStable: boolean; deviceId: string }; searchType?: string }) => Promise<void>) | null>(null);

  const apiBaseUrl = process.env.NEXT_PUBLIC_WEIGHBRIDGE_URL || "http://localhost:8090";
  const operatorName = process.env.NEXT_PUBLIC_OPERATOR_NAME || "operator_timbang";

  // Clean timer on unmount
  useEffect(() => () => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
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
      if (pendingScan) return;
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
  }, [screenState, pendingScan]);

  // Keyboard shortcut: Space / Escape resets instantly to STANDBY
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (pendingScan) {
        if (e.code === "Escape") {
          e.preventDefault();
          setPendingScan(null);
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
  }, [screenState, pendingScan]);

  // Validate barcode
  const validateBarcode = useCallback(async (rawInput: string, options: { snapshot?: { weight: number; isStable: boolean; deviceId: string }; searchType?: string } = {}) => {
    const cleanInput = (rawInput || "").trim().toUpperCase();
    if (!cleanInput) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (submittingRef.current || (pendingScan && !options.snapshot)) return;

    const wt = options.snapshot || {
      weight: telemetry.weight,
      isStable: telemetry.isStable,
      deviceId: telemetry.deviceId,
    };
    const reqSearchType = options.searchType || searchType;

    // Unstable check
    if (!options.snapshot && telemetry.isConnected && !telemetry.isStable) {
      setPendingScan({ code: cleanInput, searchType: reqSearchType, snapshot: wt });
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
          operatorUsername: operatorName,
          deviceId: wt.deviceId,
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
        inputRef.current.select();
      }
    }
  }, [apiBaseUrl, operatorName, pendingScan, playAudioTone, searchType, telemetry.deviceId, telemetry.isConnected, telemetry.isStable, telemetry.weight]);

  validateRef.current = validateBarcode;

  const handleValidate = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    validateBarcode(barcodeInput);
  };

  const handleCancelUnstable = () => {
    setPendingScan(null);
    setBarcodeInput("");
    if (inputRef.current) inputRef.current.focus();
  };

  const handleConfirmUnstable = () => {
    const pending = pendingScan;
    if (!pending) return;
    setPendingScan(null);
    validateBarcode(pending.code, { snapshot: pending.snapshot, searchType: pending.searchType });
  };

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const value = e.target.value.toUpperCase();
    const now = Date.now();

    if (now - lastKeyTsRef.current > SCANNER_BURST_GAP_MS || value.length <= 1) {
      burstStartRef.current = now;
      burstCharsRef.current = 0;
    }
    lastKeyTsRef.current = now;
    burstCharsRef.current += Math.max(value.length - barcodeInput.length, 1);

    setBarcodeInput(value);
    if (debounceRef.current) clearTimeout(debounceRef.current);

    if (value.trim().length < AUTO_SCAN_MIN_LENGTH) return;

    const chars = burstCharsRef.current;
    const msPerChar = (now - burstStartRef.current) / Math.max(chars - 1, 1);
    if (chars < AUTO_SCAN_MIN_LENGTH || msPerChar > SCANNER_MAX_MS_PER_CHAR) return;

    debounceRef.current = setTimeout(() => {
      if (validateRef.current) validateRef.current(value);
    }, AUTO_SCAN_DEBOUNCE_MS);
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
            <span style={{ fontSize: "11px", backgroundColor: "#e0f2fe", color: "#0369a1", padding: "2px 8px", borderRadius: "4px", fontWeight: 700 }}>
              {telemetry.deviceId || "WB-MERAK-01"}
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
              justifyContent: "center",
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
                      placeholder={loading ? "Memvalidasi tiket..." : "Scan Barcode untuk input"}
                      readOnly={loading || !!pendingScan}
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
                      "Scan Barcode untuk input (Spasi / Esc reset)"
                    )}
                  </span>
                </div>
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
              justifyContent: "center",
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

              {/* STATUS 1: SUKSES (PERSIS GAMBAR #2) */}
              {!loading && screenState === "SUCCESS" && (
                <div style={{ display: "flex", flexDirection: "column", alignItems: "center", animation: "fadeIn 0.3s" }}>
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

                  {validationResult && (
                    <div style={{ marginTop: "16px", fontSize: "13px", color: "#64748b" }}>
                      Plat: <strong style={{ color: "#0f172a" }}>{validationResult.licensePlate}</strong> • Golongan: <strong style={{ color: "#0f172a" }}>{validationResult.vehicleClass}</strong>
                    </div>
                  )}

                  <button
                    onClick={() => {
                      setScreenState("STANDBY");
                      setBarcodeInput("");
                      setValidationResult(null);
                      if (inputRef.current) inputRef.current.focus();
                    }}
                    style={{
                      marginTop: "24px",
                      padding: "8px 20px",
                      backgroundColor: "#22c55e",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "8px",
                      fontWeight: 700,
                      fontSize: "13px",
                      cursor: "pointer"
                    }}
                  >
                    Scan Tiket Berikutnya (Spasi / Esc)
                  </button>
                </div>
              )}

              {/* STATUS 2: KODE BOOKING TIDAK VALID */}
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
                    margin: "0 0 20px 0",
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

                  <button
                    onClick={() => {
                      setScreenState("STANDBY");
                      setBarcodeInput("");
                      setValidationResult(null);
                      if (inputRef.current) inputRef.current.focus();
                    }}
                    style={{
                      padding: "8px 20px",
                      backgroundColor: "#ef4444",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "8px",
                      fontWeight: 700,
                      fontSize: "13px",
                      cursor: "pointer"
                    }}
                  >
                    Scan Ulang (Spasi / Esc)
                  </button>
                </div>
              )}

              {/* STATUS 3: TIKET SUDAH CHECK IN */}
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
                    margin: "0 0 20px 0",
                    letterSpacing: "-0.5px"
                  }}>
                    TIKET SUDAH<br />CHECK IN
                  </h2>

                  <button
                    onClick={() => {
                      setScreenState("STANDBY");
                      setBarcodeInput("");
                      setValidationResult(null);
                      if (inputRef.current) inputRef.current.focus();
                    }}
                    style={{
                      padding: "8px 20px",
                      backgroundColor: "#f59e0b",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "8px",
                      fontWeight: 700,
                      fontSize: "13px",
                      cursor: "pointer"
                    }}
                  >
                    Kembali ke Standby (Spasi / Esc)
                  </button>
                </div>
              )}

              {/* STATUS 4: TIKET EXPIRED */}
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
                    margin: "0 0 20px 0",
                    letterSpacing: "-0.5px"
                  }}>
                    TIKET EXPIRED
                  </h2>

                  <button
                    onClick={() => {
                      setScreenState("STANDBY");
                      setBarcodeInput("");
                      setValidationResult(null);
                      if (inputRef.current) inputRef.current.focus();
                    }}
                    style={{
                      padding: "8px 20px",
                      backgroundColor: "#ef4444",
                      color: "#ffffff",
                      border: "none",
                      borderRadius: "8px",
                      fontWeight: 700,
                      fontSize: "13px",
                      cursor: "pointer"
                    }}
                  >
                    Scan Tiket Lain (Spasi / Esc)
                  </button>
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

      {/* POPUP KONFIRMASI BOBOT BELUM STABIL */}
      {pendingScan && (
        <div style={{
          position: "fixed",
          inset: 0,
          backgroundColor: "rgba(15, 23, 42, 0.6)",
          backdropFilter: "blur(2px)",
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          zIndex: 100,
          padding: "20px"
        }}>
          <div style={{
            backgroundColor: "#ffffff",
            borderRadius: "16px",
            maxWidth: "460px",
            width: "100%",
            padding: "28px",
            boxShadow: "0 20px 25px -5px rgba(0, 0, 0, 0.1), 0 10px 10px -5px rgba(0, 0, 0, 0.04)"
          }}>
            <h3 style={{ fontSize: "18px", fontWeight: 800, color: "#0f172a", margin: "0 0 12px 0" }}>
              Bobot Belum Stabil
            </h3>
            <p style={{ fontSize: "14px", color: "#475569", lineHeight: 1.5, margin: "0 0 24px 0" }}>
              Bobot terbaca <strong>{Math.round(pendingScan.snapshot.weight).toLocaleString("id-ID")} kg</strong> dan belum stabil, kendaraan kemungkinan masih bergerak. Pilih &quot;Tunggu Stabil&quot; lalu scan ulang setelah kendaraan berhenti sempurna, atau &quot;Tetap Proses&quot; untuk melanjutkan dengan bobot saat ini.
            </p>
            <div style={{ display: "flex", justifyContent: "flex-end", gap: "10px" }}>
              <button
                onClick={handleCancelUnstable}
                style={{
                  padding: "9px 16px",
                  borderRadius: "8px",
                  border: "1.5px solid #cbd5e1",
                  backgroundColor: "#ffffff",
                  color: "#475569",
                  fontSize: "13px",
                  fontWeight: 600,
                  cursor: "pointer"
                }}
              >
                Tunggu Stabil
              </button>
              <button
                onClick={handleConfirmUnstable}
                style={{
                  padding: "9px 18px",
                  borderRadius: "8px",
                  border: "none",
                  backgroundColor: "#0056b3",
                  color: "#ffffff",
                  fontSize: "13px",
                  fontWeight: 700,
                  cursor: "pointer"
                }}
              >
                Tetap Proses
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
