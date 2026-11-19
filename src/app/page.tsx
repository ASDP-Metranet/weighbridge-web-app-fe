"use client";

import React, { useState, useEffect, useRef, useCallback } from "react";
import { 
  Scale, 
  Barcode, 
  CheckCircle2, 
  AlertTriangle, 
  XCircle, 
  Clock, 
  RefreshCw, 
  Wifi, 
  WifiOff, 
  Truck,
  History,
  UserCheck
} from "lucide-react";
import { useWeightStream } from "@/hooks/useWeightStream";

type ScreenState = "STANDBY" | "SUCCESS" | "INVALID" | "ALREADY_CHECKIN" | "EXPIRED";

interface ValidationResult {
  bookingCode: string;
  ticketNumber?: string;
  licensePlate?: string;
  vehicleClass?: string;
  recordedWeight: number;
  message: string;
}

interface RecentWeighing {
  id: number;
  booking_code: string;
  ticket_number?: string;
  license_plate: string;
  actual_weight: number;
  weigh_status: string;
  is_stable: boolean;
  created_at: string;
  operator_username?: string;
}

// Auto-scan hardware barcode constants
const AUTO_SCAN_MIN_LENGTH = 8;
const AUTO_SCAN_DEBOUNCE_MS = 250;
const SCANNER_MAX_MS_PER_CHAR = 80;
const SCANNER_BURST_GAP_MS = 150;
const DUPLICATE_SCAN_WINDOW_MS = 2000;

export default function WeighbridgeKiosk() {
  const [screenState, setScreenState] = useState<ScreenState>("STANDBY");
  const telemetry = useWeightStream();
  const [barcodeInput, setBarcodeInput] = useState("");
  const [activeTab, setActiveTab] = useState<"BOOKING" | "TIKET" | "ORDER">("BOOKING");
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [recentWeighings, setRecentWeighings] = useState<RecentWeighing[]>([]);
  const [currentTime, setCurrentTime] = useState("");

  const inputRef = useRef<HTMLInputElement>(null);
  const debounceRef = useRef<NodeJS.Timeout | null>(null);
  const lastKeyTsRef = useRef(0);
  const burstStartRef = useRef(0);
  const burstCharsRef = useRef(0);
  const submittingRef = useRef(false);
  const lastSubmitRef = useRef({ value: "", ts: 0 });
  const validateRef = useRef<((input: string) => Promise<void>) | null>(null);

  const apiBaseUrl = process.env.NEXT_PUBLIC_WEIGHBRIDGE_URL || "http://localhost:8090";
  const operatorName = process.env.NEXT_PUBLIC_OPERATOR_NAME || "operator_timbang";

  // Clock updater
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      setCurrentTime(now.toLocaleTimeString("id-ID", { hour: "2-digit", minute: "2-digit", second: "2-digit" }));
    };
    updateTime();
    const timer = setInterval(updateTime, 1000);
    return () => clearInterval(timer);
  }, []);

  // Web Audio synthesizer tone alert
  const playAudioTone = useCallback((type: ScreenState) => {
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
        // High pitch two-tone chime (D5 -> A5)
        osc.type = "sine";
        osc.frequency.setValueAtTime(587.33, ctx.currentTime);
        osc.frequency.setValueAtTime(880.00, ctx.currentTime + 0.12);
        gain.gain.setValueAtTime(0.3, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.35);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.36);
      } else if (type === "ALREADY_CHECKIN") {
        // Warning tone (440Hz pulse)
        osc.type = "triangle";
        osc.frequency.setValueAtTime(440.0, ctx.currentTime);
        gain.gain.setValueAtTime(0.35, ctx.currentTime);
        gain.gain.exponentialRampToValueAtTime(0.01, ctx.currentTime + 0.38);
        osc.start(ctx.currentTime);
        osc.stop(ctx.currentTime + 0.39);
      } else {
        // Error buzzer (220Hz down to 140Hz)
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

  // Fetch recent weighings from backend
  const fetchRecentWeighings = useCallback(async () => {
    try {
      const res = await fetch(`${apiBaseUrl}/api/weighbridge/recent`);
      if (res.ok) {
        const data = await res.json();
        if (Array.isArray(data)) {
          setRecentWeighings(data);
        }
      }
    } catch {
      // Ignore background refresh errors
    }
  }, [apiBaseUrl]);

  useEffect(() => {
    fetchRecentWeighings();
    const interval = setInterval(fetchRecentWeighings, 15000);
    return () => clearInterval(interval);
  }, [fetchRecentWeighings]);

  // Keep scanner input auto-focused
  useEffect(() => {
    if (screenState === "STANDBY" && inputRef.current) {
      inputRef.current.focus();
    }
  }, [screenState]);

  // Keyboard shortcut: Space or Escape resets instantly to STANDBY
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (screenState !== "STANDBY" && (e.code === "Space" || e.code === "Escape")) {
        e.preventDefault();
        setScreenState("STANDBY");
        setBarcodeInput("");
        setValidationResult(null);
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [screenState]);

  // Main validation handler
  const validateBarcode = useCallback(async (rawInput: string) => {
    const cleanInput = (rawInput || "").trim().toUpperCase();
    if (!cleanInput) return;

    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (submittingRef.current) return;

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
      const searchTypeVal = activeTab === "BOOKING" ? "Kode Booking" : activeTab === "TIKET" ? "No Tiket" : "Order ID";
      const response = await fetch(`${apiBaseUrl}/api/weighbridge/validate`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          barcodeInput: cleanInput,
          searchType: searchTypeVal,
          actualWeight: telemetry.weight,
          isStable: telemetry.isStable,
          operatorUsername: operatorName,
          deviceId: telemetry.deviceId
        })
      });

      if (response.ok) {
        const result = await response.json();
        setValidationResult({
          bookingCode: result.bookingCode || cleanInput,
          ticketNumber: result.ticketNumber || "-",
          licensePlate: result.licensePlate || "-",
          vehicleClass: result.vehicleClass || "-",
          recordedWeight: result.recordedWeight != null ? result.recordedWeight : telemetry.weight,
          message: result.message || "BERHASIL INPUT BERAT KENDARAAN"
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
        const errorData = await response.json().catch(() => ({}));
        setValidationResult({
          bookingCode: cleanInput,
          recordedWeight: telemetry.weight,
          message: errorData.message || "KODE BOOKING TIDAK VALID"
        });
        setScreenState("INVALID");
        playAudioTone("INVALID");
      }
    } catch {
      setValidationResult({
        bookingCode: cleanInput,
        recordedWeight: telemetry.weight,
        message: "GAGAL MENGHUBUNGI SERVER SISTEM TIMBANGAN"
      });
      setScreenState("INVALID");
      playAudioTone("INVALID");
    } finally {
      submittingRef.current = false;
      setLoading(false);
      fetchRecentWeighings();
    }
  }, [activeTab, apiBaseUrl, operatorName, playAudioTone, telemetry.deviceId, telemetry.isStable, telemetry.weight, fetchRecentWeighings]);

  validateRef.current = validateBarcode;

  // Manual submit (Enter)
  const handleValidate = (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    validateBarcode(barcodeInput);
  };

  // Hardware scanner burst detection
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

  const handleReset = () => {
    setScreenState("STANDBY");
    setBarcodeInput("");
    setValidationResult(null);
  };

  return (
    <main className="min-h-screen w-screen flex flex-col justify-between p-6 bg-slate-950 font-sans text-slate-100">
      {/* HEADER ATAS */}
      <header className="flex flex-wrap justify-between items-center bg-slate-900/90 border border-slate-800 rounded-2xl px-8 py-4 shadow-xl gap-4">
        <div className="flex items-center gap-4">
          <div className="bg-blue-600 p-2.5 rounded-xl text-white font-black tracking-tighter text-xl shadow-md">
            ASDP
          </div>
          <div>
            <h1 className="text-xl font-black text-white tracking-wide uppercase">
              Terminal Pos Jembatan Timbang
            </h1>
            <p className="text-xs text-slate-400 font-medium">
              Weighbridge Kiosk • Pelabuhan Merak
            </p>
          </div>
        </div>

        {/* STATUS OPERATOR & TELEMETRI */}
        <div className="flex items-center gap-4">
          <div className="flex items-center gap-2 bg-slate-950 px-3.5 py-1.5 rounded-xl border border-slate-800 text-xs">
            <UserCheck className="w-4 h-4 text-emerald-400" />
            <span className="text-slate-400">Operator:</span>
            <span className="font-bold text-white font-mono">{operatorName}</span>
          </div>

          <div className="flex items-center gap-2 bg-slate-950 px-3.5 py-1.5 rounded-xl border border-slate-800 text-xs font-mono">
            <Clock className="w-4 h-4 text-slate-400" />
            <span className="text-slate-300 font-semibold">{currentTime} WIB</span>
          </div>

          <div className={`flex items-center gap-2 px-3.5 py-1.5 rounded-xl border text-xs font-bold transition-all ${
            telemetry.isConnected 
              ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/30" 
              : "bg-rose-500/10 text-rose-400 border-rose-500/30 animate-pulse"
          }`}>
            {telemetry.isConnected ? <Wifi className="w-4 h-4" /> : <WifiOff className="w-4 h-4" />}
            <span>{telemetry.isConnected ? "SENSOR ONLINE" : "OFFLINE"}</span>
          </div>
        </div>
      </header>

      {/* KONTEN UTAMA: BERDASARKAN 4 STATUS LAYAR */}
      <div className="flex-1 flex flex-col items-center justify-center my-6">

        {/* KONDISI 1: BERHASIL INPUT BERAT (LAYAR HIJAU) */}
        {screenState === "SUCCESS" && validationResult && (
          <div className="w-full max-w-3xl bg-emerald-950/40 border-2 border-emerald-500 rounded-3xl p-10 text-center shadow-2xl backdrop-blur-md animate-in fade-in zoom-in duration-200">
            <div className="inline-flex p-4 bg-emerald-500/20 text-emerald-400 rounded-full mb-6 ring-8 ring-emerald-500/10">
              <CheckCircle2 className="w-20 h-20" />
            </div>
            
            <p className="text-sm font-bold tracking-widest text-emerald-400 uppercase mb-2">Penimbangan Berhasil Direkam</p>
            <h2 className="text-3xl md:text-5xl font-black text-white mb-2 tracking-tight">
              {validationResult.recordedWeight.toLocaleString("id-ID", { minimumFractionDigits: 0 })} KG
            </h2>
            <p className="text-slate-400 text-sm mb-6 font-mono">Kode Booking: <strong className="text-white text-base">{validationResult.bookingCode}</strong></p>

            <div className="grid grid-cols-2 gap-4 max-w-lg mx-auto text-left bg-slate-900/80 p-4 rounded-xl border border-emerald-800/40 text-sm mb-8">
              <div>
                <span className="text-slate-400 text-xs block">Nomor Polisi:</span>
                <span className="font-bold text-white text-base font-mono">{validationResult.licensePlate}</span>
              </div>
              <div>
                <span className="text-slate-400 text-xs block">Golongan Kendaraan:</span>
                <span className="font-bold text-white text-base">{validationResult.vehicleClass}</span>
              </div>
            </div>

            <button 
              onClick={handleReset}
              className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-8 py-3.5 rounded-xl shadow-lg transition-all flex items-center gap-2 text-base mx-auto"
            >
              Scan Kendaraan Berikutnya (Spasi / Esc)
            </button>
          </div>
        )}

        {/* KONDISI 2: KODE BOOKING TIDAK VALID (LAYAR MERAH) */}
        {screenState === "INVALID" && (
          <div className="w-full max-w-3xl bg-rose-950/40 border-2 border-rose-500 rounded-3xl p-12 text-center shadow-2xl backdrop-blur-md animate-in fade-in zoom-in duration-200">
            <div className="inline-flex p-4 bg-rose-500/20 text-rose-400 rounded-full mb-6 ring-8 ring-rose-500/10">
              <XCircle className="w-20 h-20" />
            </div>
            
            <h2 className="text-3xl md:text-5xl font-black text-white mb-4 uppercase tracking-tight">
              {validationResult?.message || "KODE BOOKING TIDAK VALID"}
            </h2>
            <p className="text-slate-300 text-base max-w-md mx-auto mb-8">
              Data transaksi tidak ditemukan di sistem. Pastikan barcode terbaca utuh atau arahkan pengemudi ke loket informasi.
            </p>

            <button 
              onClick={handleReset}
              className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-10 py-4 rounded-xl shadow-lg transition-all flex items-center gap-3 mx-auto text-base"
            >
              <RefreshCw className="w-5 h-5" />
              Scan Ulang Barcode (Spasi / Esc)
            </button>
          </div>
        )}

        {/* KONDISI 3: TIKET SUDAH CHECK IN (LAYAR KUNING) */}
        {screenState === "ALREADY_CHECKIN" && (
          <div className="w-full max-w-3xl bg-amber-950/40 border-2 border-amber-500 rounded-3xl p-12 text-center shadow-2xl backdrop-blur-md animate-in fade-in zoom-in duration-200">
            <div className="inline-flex p-4 bg-amber-500/20 text-amber-400 rounded-full mb-6 ring-8 ring-amber-500/10">
              <Clock className="w-20 h-20" />
            </div>
            
            <p className="text-sm font-bold tracking-widest text-amber-400 uppercase mb-2">Peringatan Duplikasi Masuk</p>
            <h2 className="text-3xl md:text-5xl font-black text-white mb-4 uppercase tracking-tight">
              TIKET SUDAH CHECK IN
            </h2>
            <p className="text-slate-300 text-base max-w-md mx-auto mb-8">
              Tiket ini sudah tercatat masuk dermaga dan tidak dapat ditimbang ulang. Hubungi supervisor lapangan jika terjadi salah jalur.
            </p>

            <button 
              onClick={handleReset}
              className="bg-amber-600 hover:bg-amber-500 text-white font-bold px-10 py-4 rounded-xl shadow-lg transition-all flex items-center gap-3 mx-auto text-base"
            >
              <RefreshCw className="w-5 h-5" />
              Kembali ke Layar Standby (Spasi / Esc)
            </button>
          </div>
        )}

        {/* KONDISI 4: TIKET EXPIRED (LAYAR MERAH) */}
        {screenState === "EXPIRED" && (
          <div className="w-full max-w-3xl bg-rose-950/50 border-2 border-rose-600 rounded-3xl p-12 text-center shadow-2xl backdrop-blur-md animate-in fade-in zoom-in duration-200">
            <div className="inline-flex p-4 bg-rose-600/20 text-rose-500 rounded-full mb-6 ring-8 ring-rose-600/10">
              <AlertTriangle className="w-20 h-20" />
            </div>
            
            <h2 className="text-3xl md:text-5xl font-black text-white mb-4 uppercase tracking-tight">
              TIKET EXPIRED
            </h2>
            <p className="text-slate-300 text-base max-w-md mx-auto mb-8">
              Jadwal keberangkatan tiket telah melewati batas waktu toleransi masuk pelabuhan. Arahkan pengguna jasa ke loket Go-Show.
            </p>

            <button 
              onClick={handleReset}
              className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-10 py-4 rounded-xl shadow-lg transition-all flex items-center gap-3 mx-auto text-base"
            >
              <RefreshCw className="w-5 h-5" />
              Scan Tiket Lain (Spasi / Esc)
            </button>
          </div>
        )}

        {/* KONDISI STANDBY: MENUNGGU SCAN & LIVE WEIGHT DISPLAY */}
        {screenState === "STANDBY" && (
          <div className="w-full max-w-5xl flex flex-col gap-6">
            <div className="grid grid-cols-1 md:grid-cols-12 gap-6 items-stretch">
              {/* PANEL KIRI: MONITOR INDIKATOR BOBOT TIMBANGAN */}
              <div className="md:col-span-6 bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-2xl flex flex-col justify-between min-h-[380px]">
                <div>
                  <div className="flex justify-between items-center mb-4">
                    <span className="text-xs font-bold tracking-wider text-slate-400 uppercase flex items-center gap-2">
                      <Scale className="w-4 h-4 text-blue-400" />
                      Indikator Timbangan WIM
                    </span>
                    <span className={`text-xs px-3 py-1 rounded-full font-bold ${
                      telemetry.isStable 
                        ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30" 
                        : "bg-amber-500/20 text-amber-400 border border-amber-500/30 animate-pulse"
                    }`}>
                      {telemetry.isStable ? "STABIL (STABLE)" : "BERGERAK (UNSTABLE)"}
                    </span>
                  </div>

                  <div className="bg-slate-950 rounded-2xl border border-slate-800 p-6 text-center my-auto shadow-inner">
                    <p className="text-xs text-slate-500 uppercase tracking-widest mb-1 font-semibold">Berat Kendaraan Riil</p>
                    <div className="flex items-baseline justify-center gap-3">
                      <span className="text-5xl md:text-6xl font-mono font-black text-blue-400 tracking-tight">
                        {telemetry.weight.toLocaleString("id-ID", { minimumFractionDigits: 1 })}
                      </span>
                      <span className="text-2xl font-bold text-slate-400">kg</span>
                    </div>
                  </div>
                </div>

                <div className="flex items-center justify-between text-xs text-slate-400 pt-4 border-t border-slate-800">
                  <span className="flex items-center gap-1.5">
                    <Truck className="w-4 h-4 text-slate-500" /> Sensor Sumbu Terkalibrasi
                  </span>
                  <span className="font-mono">ID: {telemetry.deviceId || "WB-MERAK-01"}</span>
                </div>
              </div>

              {/* PANEL KANAN: FORM SCANNER BARCODE */}
              <div className="md:col-span-6 bg-slate-900/90 border border-slate-800 rounded-3xl p-6 shadow-2xl flex flex-col justify-between min-h-[380px]">
                <div>
                  {/* TAB SELECTOR */}
                  <div className="grid grid-cols-3 gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800 mb-4">
                    {(["BOOKING", "TIKET", "ORDER"] as const).map(tab => (
                      <button
                        key={tab}
                        onClick={() => setActiveTab(tab)}
                        className={`text-xs font-bold py-2 rounded-lg transition-all ${
                          activeTab === tab 
                            ? "bg-blue-600 text-white shadow-md" 
                            : "text-slate-400 hover:text-white"
                        }`}
                      >
                        {tab === "BOOKING" ? "Kode Booking" : tab === "TIKET" ? "No. Tiket" : "Order ID"}
                      </button>
                    ))}
                  </div>

                  <h3 className="text-base font-bold text-white mb-1 flex items-center gap-2">
                    <Barcode className="w-5 h-5 text-orange-400" />
                    Pindai Barcode / QR Tiket
                  </h3>
                  <p className="text-xs text-slate-400 mb-4 leading-relaxed">
                    Arahkan scanner hardware 2D ke tiket. Input cepat terdeteksi otomatis tanpa tekan Enter.
                  </p>

                  <form onSubmit={handleValidate}>
                    <div className="relative mb-3">
                      <input
                        ref={inputRef}
                        type="text"
                        value={barcodeInput}
                        onChange={handleInputChange}
                        placeholder={`Scan atau ketik ${activeTab === "BOOKING" ? "Kode Booking..." : "Nomor Tiket..."}`}
                        disabled={loading}
                        className="w-full bg-slate-950 border-2 border-blue-500/50 focus:border-blue-400 rounded-xl px-4 py-3.5 text-base font-mono text-white placeholder-slate-600 outline-none transition-all shadow-inner uppercase tracking-wider"
                      />
                    </div>

                    <button
                      type="submit"
                      disabled={loading || !barcodeInput.trim()}
                      className="w-full bg-orange-600 hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3 rounded-xl shadow-lg transition-all text-sm uppercase tracking-wider flex items-center justify-center gap-2"
                    >
                      {loading ? (
                        <>
                          <RefreshCw className="w-4 h-4 animate-spin" />
                          Memvalidasi...
                        </>
                      ) : (
                        "Input Berat Kendaraan"
                      )}
                    </button>
                  </form>
                </div>

                <div className="pt-3 border-t border-slate-800 text-[11px] text-slate-500 flex justify-between">
                  <span>Auto-Scan USB Scanner: Aktif (&lt;80ms burst)</span>
                  <span className="text-slate-400 font-mono">Standby</span>
                </div>
              </div>
            </div>

            {/* TABEL RIWAYAT PENIMBANGAN TERBARU (RECENT WEIGHINGS) */}
            <div className="w-full bg-slate-900/80 border border-slate-800 rounded-2xl p-5 shadow-xl">
              <div className="flex items-center justify-between mb-3">
                <span className="text-xs font-bold tracking-wider text-slate-400 uppercase flex items-center gap-2">
                  <History className="w-4 h-4 text-blue-400" />
                  Riwayat Penimbangan Terakhir (10 Transaksi)
                </span>
                <button
                  onClick={fetchRecentWeighings}
                  className="text-xs text-slate-400 hover:text-white flex items-center gap-1 transition-colors"
                >
                  <RefreshCw className="w-3.5 h-3.5" /> Segarkan
                </button>
              </div>

              {recentWeighings.length === 0 ? (
                <div className="text-center py-6 text-xs text-slate-500 font-mono">
                  Belum ada catatan transaksi penimbangan hari ini.
                </div>
              ) : (
                <div className="overflow-x-auto">
                  <table className="w-full text-left text-xs">
                    <thead>
                      <tr className="border-b border-slate-800 text-slate-400 font-semibold">
                        <th className="py-2 px-3">Waktu</th>
                        <th className="py-2 px-3">Kode Booking</th>
                        <th className="py-2 px-3">No. Tiket</th>
                        <th className="py-2 px-3">No. Polisi</th>
                        <th className="py-2 px-3 text-right">Berat (kg)</th>
                        <th className="py-2 px-3 text-center">Status</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-800/60 font-mono">
                      {recentWeighings.map((row) => (
                        <tr key={row.id} className="hover:bg-slate-800/40 transition-colors">
                          <td className="py-2.5 px-3 text-slate-400">
                            {row.created_at ? new Date(row.created_at).toLocaleTimeString("id-ID") : "-"}
                          </td>
                          <td className="py-2.5 px-3 font-bold text-white">{row.booking_code}</td>
                          <td className="py-2.5 px-3 text-slate-300">{row.ticket_number || "-"}</td>
                          <td className="py-2.5 px-3 text-slate-300">{row.license_plate}</td>
                          <td className="py-2.5 px-3 text-right font-bold text-blue-400">
                            {row.actual_weight != null ? Math.round(row.actual_weight).toLocaleString("id-ID") : "0"}
                          </td>
                          <td className="py-2.5 px-3 text-center">
                            <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${
                              row.weigh_status === "SUCCESS"
                                ? "bg-emerald-500/20 text-emerald-400 border border-emerald-500/30"
                                : row.weigh_status === "SUPERSEDED"
                                ? "bg-slate-700 text-slate-400"
                                : "bg-rose-500/20 text-rose-400 border border-rose-500/30"
                            }`}>
                              {row.weigh_status}
                            </span>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>

      {/* FOOTER BAWAH */}
      <footer className="flex justify-between items-center text-xs text-slate-500 border-t border-slate-900 pt-4 px-2">
        <p>© 2026 PT ASDP Indonesia Ferry (Persero) • Hak Cipta Dilindungi</p>
        <div className="flex gap-6">
          <span>We Bridge The Nation</span>
          <span className="font-mono text-slate-600">v1.1.0-weighbridge-kiosk</span>
        </div>
      </footer>
    </main>
  );
}
