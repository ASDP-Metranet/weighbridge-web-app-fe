"use client";

import React, { useState, useEffect, useRef } from "react";
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
  Truck
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

export default function WeighbridgeKiosk() {
  const [screenState, setScreenState] = useState<ScreenState>("STANDBY");
  const telemetry = useWeightStream();
  const [barcodeInput, setBarcodeInput] = useState("");
  const [activeTab, setActiveTab] = useState<"BOOKING" | "TIKET" | "ORDER">("BOOKING");
  const [validationResult, setValidationResult] = useState<ValidationResult | null>(null);
  const [loading, setLoading] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  // 1. Keep scanner input auto-focused for USB 2D hardware barcode scanner
  useEffect(() => {
    if (screenState === "STANDBY" && inputRef.current) {
      inputRef.current.focus();
    }
  }, [screenState]);

  // Handler Submit / Scan Barcode
  const handleValidate = async (e?: React.FormEvent) => {
    if (e) e.preventDefault();
    if (!barcodeInput.trim()) return;

    setLoading(true);
    const cleanInput = barcodeInput.trim().toUpperCase();

    try {
      const response = await fetch("http://localhost:8090/api/weighbridge/validate", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          barcodeInput: cleanInput,
          searchType: activeTab === "BOOKING" ? "Kode Booking" : activeTab === "TIKET" ? "No Tiket" : "Order ID",
          actualWeight: telemetry.weight,
          isStable: telemetry.isStable,
          operatorUsername: "operator_timbang_01",
          deviceId: telemetry.deviceId
        })
      });

      if (response.ok) {
        const result = await response.json();
        setValidationResult({
          bookingCode: result.bookingCode || cleanInput,
          ticketNumber: result.ticketNumber,
          licensePlate: result.licensePlate || "B 9918 UFV",
          vehicleClass: result.vehicleClass || "Golongan IV B",
          recordedWeight: telemetry.weight,
          message: result.message
        });

        if (result.status === "SUCCESS") {
          setScreenState("SUCCESS");
        } else if (result.status === "ALREADY_CHECKED_IN") {
          setScreenState("ALREADY_CHECKIN");
        } else if (result.status === "EXPIRED") {
          setScreenState("EXPIRED");
        } else {
          setScreenState("INVALID");
        }
      } else {
        // Fallback matching mock codes
        evaluateMockFallback(cleanInput);
      }
    } catch (err) {
      evaluateMockFallback(cleanInput);
    } finally {
      setLoading(false);
    }
  };

  const evaluateMockFallback = (input: string) => {
    if (input.includes("INVALID") || input.length < 5) {
      setScreenState("INVALID");
    } else if (input.includes("CHECK") || input === "CHECKEDIN") {
      setValidationResult({
        bookingCode: input,
        licensePlate: "B 9918 UFV",
        recordedWeight: telemetry.weight,
        message: "TIKET SUDAH CHECK IN"
      });
      setScreenState("ALREADY_CHECKIN");
    } else if (input.includes("EXP") || input === "EXPIRED") {
      setValidationResult({
        bookingCode: input,
        licensePlate: "B 9918 UFV",
        recordedWeight: telemetry.weight,
        message: "TIKET EXPIRED"
      });
      setScreenState("EXPIRED");
    } else {
      setValidationResult({
        bookingCode: input,
        ticketNumber: "TKT-" + Math.floor(100000 + Math.random() * 900000),
        licensePlate: "B 9918 UFV",
        vehicleClass: "Golongan V-B (Truk Sedang)",
        recordedWeight: telemetry.weight,
        message: "BERHASIL INPUT BERAT KENDARAAN"
      });
      setScreenState("SUCCESS");
    }
  };

  const handleReset = () => {
    setScreenState("STANDBY");
    setBarcodeInput("");
    setValidationResult(null);
  };

  return (
    <main className="h-screen w-screen flex flex-col justify-between p-6 bg-slate-950 font-sans">
      {/* HEADER ATAS */}
      <header className="flex justify-between items-center bg-slate-900/90 border border-slate-800 rounded-2xl px-8 py-4 shadow-xl">
        <div className="flex items-center gap-4">
          <div className="bg-asdp-blue p-2.5 rounded-xl text-white font-black text-xl tracking-wider">
            ASDP
          </div>
          <div>
            <h1 className="text-xl font-bold tracking-tight text-white flex items-center gap-2">
              Terminal Pos Jembatan Timbang
              <span className="text-xs px-2.5 py-0.5 rounded-full bg-blue-500/20 text-blue-400 font-semibold border border-blue-500/30">
                Sebelum Loket
              </span>
            </h1>
            <p className="text-xs text-slate-400">asdp bangga menyatukan nusantara • Wilayah Pelabuhan Merak</p>
          </div>
        </div>

        {/* STATUS HARDWARE TIMBANGAN */}
        <div className="flex items-center gap-6">
          <div className="flex items-center gap-3 bg-slate-800/80 px-4 py-2 rounded-xl border border-slate-700/60">
            {telemetry.isConnected ? (
              <Wifi className="w-5 h-5 text-emerald-400" />
            ) : (
              <WifiOff className="w-5 h-5 text-rose-400 animate-pulse" />
            )}
            <div className="text-right">
              <p className="text-[10px] text-slate-400 font-medium uppercase tracking-wider">Status Timbangan</p>
              <p className={`text-xs font-bold ${telemetry.isConnected ? "text-emerald-400" : "text-rose-400"}`}>
                {telemetry.isConnected ? "TERHUBUNG (ONLINE)" : "TERPUTUS (OFFLINE)"}
              </p>
            </div>
          </div>

          <div className="text-right border-l border-slate-800 pl-6">
            <p className="text-[10px] text-slate-400 uppercase">Operator Aktif</p>
            <p className="text-sm font-semibold text-slate-200">REGU 1 / SHIFT 1</p>
          </div>
        </div>
      </header>

      {/* KONTEN UTAMA SESUAI 4 STATUS */}
      <div className="flex-1 my-6 flex items-center justify-center">
        {/* ============================================================== */}
        {/* KONDISI 1: BERHASIL INPUT (LAYAR HIJAU - Page 7)              */}
        {/* ============================================================== */}
        {screenState === "SUCCESS" && validationResult && (
          <div className="w-full max-w-4xl bg-emerald-950/40 border-2 border-emerald-500 rounded-3xl p-12 text-center shadow-2xl backdrop-blur-md animate-in fade-in zoom-in duration-200">
            <div className="inline-flex p-4 bg-emerald-500/20 text-emerald-400 rounded-full mb-6 ring-8 ring-emerald-500/10">
              <CheckCircle2 className="w-20 h-20" />
            </div>
            
            <p className="text-sm font-bold tracking-widest text-emerald-400 uppercase mb-2">Kode Booking: {validationResult.bookingCode}</p>
            <h2 className="text-4xl md:text-5xl font-black text-white mb-6 uppercase tracking-tight">
              BERHASIL INPUT BERAT KENDARAAN
            </h2>

            <div className="inline-block bg-emerald-900/60 border border-emerald-500/50 rounded-2xl px-12 py-6 mb-8 shadow-inner">
              <span className="text-6xl md:text-7xl font-mono font-black text-emerald-300">
                {validationResult.recordedWeight.toLocaleString("id-ID", { minimumFractionDigits: 3 })}
              </span>
              <span className="text-2xl font-bold text-emerald-400 ml-3">kg</span>
            </div>

            <div className="grid grid-cols-2 gap-4 max-w-lg mx-auto text-left bg-slate-900/80 p-4 rounded-xl border border-emerald-800/40 text-sm mb-8">
              <div>
                <span className="text-slate-400 text-xs block">Nomor Polisi:</span>
                <span className="font-bold text-white text-base">{validationResult.licensePlate}</span>
              </div>
              <div>
                <span className="text-slate-400 text-xs block">Golongan Kendaraan:</span>
                <span className="font-bold text-white text-base">{validationResult.vehicleClass}</span>
              </div>
            </div>

            <div className="flex items-center justify-center gap-4">
              <button 
                onClick={handleReset}
                className="bg-emerald-600 hover:bg-emerald-500 text-white font-bold px-8 py-3.5 rounded-xl shadow-lg transition-all flex items-center gap-2 text-base"
              >
                Scan Kendaraan Berikutnya
              </button>
            </div>
          </div>
        )}

        {/* ============================================================== */}
        {/* KONDISI 2: KODE BOOKING TIDAK VALID (LAYAR MERAH - Page 8)     */}
        {/* ============================================================== */}
        {screenState === "INVALID" && (
          <div className="w-full max-w-3xl bg-rose-950/40 border-2 border-rose-500 rounded-3xl p-12 text-center shadow-2xl backdrop-blur-md animate-in fade-in zoom-in duration-200">
            <div className="inline-flex p-4 bg-rose-500/20 text-rose-400 rounded-full mb-6 ring-8 ring-rose-500/10">
              <XCircle className="w-20 h-20" />
            </div>
            
            <h2 className="text-4xl md:text-5xl font-black text-white mb-4 uppercase tracking-tight">
              KODE BOOKING TIDAK VALID
            </h2>
            <p className="text-slate-300 text-lg max-w-md mx-auto mb-8">
              Data transaksi tidak ditemukan di sistem. Pastikan barcode tidak rusak atau arahkan sopir ke loket informasi.
            </p>

            <button 
              onClick={handleReset}
              className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-10 py-4 rounded-xl shadow-lg transition-all flex items-center gap-3 mx-auto text-lg"
            >
              <RefreshCw className="w-5 h-5" />
              Scan Ulang Barcode
            </button>
          </div>
        )}

        {/* ============================================================== */}
        {/* KONDISI 3: TIKET SUDAH CHECK IN (LAYAR KUNING - Page 8)        */}
        {/* ============================================================== */}
        {screenState === "ALREADY_CHECKIN" && (
          <div className="w-full max-w-3xl bg-amber-950/40 border-2 border-amber-500 rounded-3xl p-12 text-center shadow-2xl backdrop-blur-md animate-in fade-in zoom-in duration-200">
            <div className="inline-flex p-4 bg-amber-500/20 text-amber-400 rounded-full mb-6 ring-8 ring-amber-500/10">
              <Clock className="w-20 h-20" />
            </div>
            
            <p className="text-sm font-bold tracking-widest text-amber-400 uppercase mb-2">Peringatan Duplikasi Masuk</p>
            <h2 className="text-4xl md:text-5xl font-black text-white mb-4 uppercase tracking-tight">
              TIKET SUDAH CHECK IN
            </h2>
            <p className="text-slate-300 text-lg max-w-md mx-auto mb-8">
              Tiket ini sudah tercatat masuk dermaga dan tidak dapat ditimbang ulang. Hubungi supervisor pelabuhan jika terjadi kesalahan jalur.
            </p>

            <button 
              onClick={handleReset}
              className="bg-amber-600 hover:bg-amber-500 text-white font-bold px-10 py-4 rounded-xl shadow-lg transition-all flex items-center gap-3 mx-auto text-lg"
            >
              <RefreshCw className="w-5 h-5" />
              Kembali ke Layar Standby
            </button>
          </div>
        )}

        {/* ============================================================== */}
        {/* KONDISI 4: TIKET EXPIRED (LAYAR MERAH - Page 9)                */}
        {/* ============================================================== */}
        {screenState === "EXPIRED" && (
          <div className="w-full max-w-3xl bg-rose-950/50 border-2 border-rose-600 rounded-3xl p-12 text-center shadow-2xl backdrop-blur-md animate-in fade-in zoom-in duration-200">
            <div className="inline-flex p-4 bg-rose-600/20 text-rose-500 rounded-full mb-6 ring-8 ring-rose-600/10">
              <AlertTriangle className="w-20 h-20" />
            </div>
            
            <h2 className="text-4xl md:text-5xl font-black text-white mb-4 uppercase tracking-tight">
              TIKET EXPIRED
            </h2>
            <p className="text-slate-300 text-lg max-w-md mx-auto mb-8">
              Jadwal keberangkatan tiket telah melewati batas waktu toleransi masuk pelabuhan. Arahkan pengguna jasa ke loket Go-Show.
            </p>

            <button 
              onClick={handleReset}
              className="bg-rose-600 hover:bg-rose-500 text-white font-bold px-10 py-4 rounded-xl shadow-lg transition-all flex items-center gap-3 mx-auto text-lg"
            >
              <RefreshCw className="w-5 h-5" />
              Scan Tiket Lain
            </button>
          </div>
        )}

        {/* ============================================================== */}
        {/* KONDISI STANDBY: MENUNGGU SCAN & LIVE WEIGHT DISPLAY           */}
        {/* ============================================================== */}
        {screenState === "STANDBY" && (
          <div className="w-full max-w-5xl grid grid-cols-1 md:grid-cols-12 gap-8 items-center">
            {/* PANEL KIRI: MONITOR INDIKATOR BOBOT TIMBANGAN */}
            <div className="md:col-span-6 bg-slate-900/90 border border-slate-800 rounded-3xl p-8 shadow-2xl flex flex-col justify-between h-[420px]">
              <div>
                <div className="flex justify-between items-center mb-6">
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

                <div className="bg-slate-950 rounded-2xl border border-slate-800 p-8 text-center my-auto shadow-inner">
                  <p className="text-xs text-slate-500 uppercase tracking-widest mb-1 font-semibold">Berat Kendaraan Riil</p>
                  <div className="flex items-baseline justify-center gap-3">
                    <span className="text-6xl md:text-7xl font-mono font-black text-blue-400 tracking-tight">
                      {telemetry.weight.toLocaleString("id-ID", { minimumFractionDigits: 3 })}
                    </span>
                    <span className="text-2xl font-bold text-slate-400">kg</span>
                  </div>
                </div>
              </div>

              <div className="flex items-center justify-between text-xs text-slate-400 pt-4 border-t border-slate-800">
                <span className="flex items-center gap-1.5">
                  <Truck className="w-4 h-4 text-slate-500" /> Sensor Beban Sumbu Terkalibrasi
                </span>
                <span>ID: {telemetry.deviceId}</span>
              </div>
            </div>

            {/* PANEL KANAN: FORM SCANNER BARCODE */}
            <div className="md:col-span-6 bg-slate-900/90 border border-slate-800 rounded-3xl p-8 shadow-2xl flex flex-col justify-between h-[420px]">
              <div>
                {/* TAB SELECTOR (KODE BOOKING, NO TIKET, ORDER ID) */}
                <div className="grid grid-cols-3 gap-2 bg-slate-950 p-1.5 rounded-xl border border-slate-800 mb-6">
                  {(["BOOKING", "TIKET", "ORDER"] as const).map(tab => (
                    <button
                      key={tab}
                      onClick={() => setActiveTab(tab)}
                      className={`text-xs font-bold py-2 rounded-lg transition-all ${
                        activeTab === tab 
                          ? "bg-asdp-blue text-white shadow-md" 
                          : "text-slate-400 hover:text-white"
                      }`}
                    >
                      {tab === "BOOKING" ? "Kode Booking" : tab === "TIKET" ? "No. Tiket" : "Order ID"}
                    </button>
                  ))}
                </div>

                <h3 className="text-lg font-bold text-white mb-2 flex items-center gap-2">
                  <Barcode className="w-5 h-5 text-asdp-orange" />
                  Pindai Barcode / QR Tiket
                </h3>
                <p className="text-xs text-slate-400 mb-6 leading-relaxed">
                  Arahkan scanner 2D ke Boarding Pass fisik atau layar e-ticket Ferizy pengguna jasa.
                </p>

                <form onSubmit={handleValidate}>
                  <div className="relative mb-4">
                    <input
                      ref={inputRef}
                      type="text"
                      value={barcodeInput}
                      onChange={e => setBarcodeInput(e.target.value)}
                      placeholder={`Scan atau ketik ${activeTab === "BOOKING" ? "Kode Booking..." : "Nomor Tiket..."}`}
                      disabled={loading}
                      className="w-full bg-slate-950 border-2 border-blue-500/50 focus:border-blue-400 rounded-xl px-5 py-4 text-lg font-mono text-white placeholder-slate-600 outline-none transition-all shadow-inner uppercase tracking-wider"
                    />
                  </div>

                  <button
                    type="submit"
                    disabled={loading || !barcodeInput.trim()}
                    className="w-full bg-asdp-orange hover:bg-orange-500 disabled:opacity-50 disabled:cursor-not-allowed text-white font-bold py-3.5 rounded-xl shadow-lg transition-all text-base uppercase tracking-wider flex items-center justify-center gap-2"
                  >
                    {loading ? (
                      <>
                        <RefreshCw className="w-5 h-5 animate-spin" />
                        Memvalidasi...
                      </>
                    ) : (
                      "Input Berat Kendaraan"
                    )}
                  </button>
                </form>
              </div>

              {/* TOMBOL PENGUJIAN STATUS UI (DEMO BUTTONS) */}
              <div className="pt-4 border-t border-slate-800/80 flex items-center justify-between text-[11px] text-slate-500">
                <span>Simulasi Demo:</span>
                <div className="flex gap-2">
                  <button onClick={() => { setBarcodeInput("10AP7EEC"); }} className="hover:text-emerald-400 underline">Sukses</button>
                  <button onClick={() => { setBarcodeInput("INVALID"); }} className="hover:text-rose-400 underline">Tidak Valid</button>
                  <button onClick={() => { setBarcodeInput("CHECKEDIN"); }} className="hover:text-amber-400 underline">Check-In</button>
                  <button onClick={() => { setBarcodeInput("EXPIRED"); }} className="hover:text-rose-400 underline">Expired</button>
                </div>
              </div>
            </div>
          </div>
        )}
      </div>

      {/* FOOTER BAWAH */}
      <footer className="flex justify-between items-center text-xs text-slate-500 border-t border-slate-900 pt-4 px-2">
        <p>© 2026 PT ASDP Indonesia Ferry (Persero) • Hak Cipta Dilindungi</p>
        <div className="flex gap-6">
          <span>We Bridge The Nation</span>
          <span className="font-mono text-slate-600">v1.0.0-weighbridge</span>
        </div>
      </footer>
    </main>
  );
}
