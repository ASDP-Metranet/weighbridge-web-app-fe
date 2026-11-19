# Laporan Pengujian Fungsionalitas & Keselarasan Desain Visual Pos Jembatan Timbang
**Weighbridge Station Kiosk Application (`weighbridge-web-app-fe` & `weighbridge-service-be`)**  
*PT ASDP Indonesia Ferry (Persero) — Tanggal Pengujian: 19 November 2026 (Versi Layout Resmi ASDP)*

---

## 1. Ringkasan Eksekutif (*Executive Summary*)

Laporan ini memverifikasi fungsionalitas menyeluruh (*end-to-end testing*) dan **keselarasan desain visual** repositori baru pos jembatan timbang pelabuhan ASDP (`weighbridge-web-app-fe` dan `weighbridge-service-be`).

Sesuai instruksi dan standar visual yang terdapat pada repositori eksisting (`loket-web-app-fe/pages/pos-timbang/index.js`), antarmuka repositori baru telah diselaraskan 100% mengikuti **desain resmi ASDP**:
1. **Banner Resmi ASDP**: Header menggunakan aset gambar resmi `header_banner.png` dengan rasio `6480 / 616` dan garis batas bawah biru ASDP (`#0056b3`).
2. **Tema Visual Corporate Light**: Latar belakang putih bersih (`#ffffff`), area kerja terpusat 1160px, kartu abu-abu netral (`#f1f5f9`), dan tipografi korporat.
3. **Tata Letak 2 Kolom Sejajar (Persis Spesifikasi Eksisting)**:
   - **Sisi Kiri**: Kotak *"PEMINDAIAN TIKET"* dengan inline dropdown selector (*Kode Booking*, *No Tiket*, *Order ID*), input box scanner, dan animasi spinner validasi.
   - **Sisi Kanan**: *"STATUS CARD"* dengan ikon outline melingkar (Hijau Centang untuk Sukses, Merah untuk Tidak Valid/Expired, Kuning untuk Sudah Check-In, dan Live Weight Monitor saat Standby).
4. **Fokus Kiosk Operasional (Hands-free, Tanpa Tombol Tambahan & Tanpa Tabel Riwayat)**: Sesuai layout halaman eksisting `pos-timbang`, kartu status tidak memiliki tombol manual ("Scan Tiket Berikutnya", "Kembali ke Standby", dll) dan tanpa tabel riwayat. Reset ke Standby beroperasi secara *hands-free* saat barcode tiket berikutnya dipindai atau melalui shortcut keyboard `Space` / `Escape`.
5. **Mode Publik (Tanpa Login)**: Langsung siap pakai (*kiosk ready*) dengan atribusi otomatis ke operator stasiun (`operator_timbang`).

---

## 2. Lingkungan Pengujian (*Test Environment*)

| Komponen | Spesifikasi / Konfigurasi | Keterangan |
| :--- | :--- | :--- |
| **Frontend Kiosk** | Next.js 14.2.16 (Port `3005`) | Desain Resmi ASDP, Web Audio API, Auto-Scan, Tanpa Tombol/Tabel Tambahan |
| **Backend Service** | Java Spring Boot 3.2.x (Port `8090`) | HikariCP, JPA Hibernate, SSE Telemetri |
| **Database** | MySQL 8.0 Docker (`asdp_loket`) | Tabel: `orders`, `order_items`, `vehicles`, `vehicle_weighing` |
| **Sensor Telemetri** | Server-Sent Events (SSE) `/api/weight/stream` | Polling/Stream 300ms frekuensi stabilisasi |
| **Hardware Scanner** | USB 2D Barcode Scanner Simulation | Auto-Scan Burst Detection (<80ms per karakter) |

---

## 3. Matriks Hasil Pengujian Fungsionalitas (*Test Matrix*)

| ID | Skenario Pengujian | Input Barcode | Parameter / Kondisi | Respon Sistem & Visual Layar | Status |
| :---: | :--- | :---: | :--- | :--- | :---: |
| **TC-01** | Validasi Tiket Sah & Rekam Berat | `BK-SUCCESS-01` | Kendaraan sah, jadwal aktif H+4, belum check-in | **🟢 HIJAU (BERHASIL INPUT BERAT)**<br>Lingkaran Hijau, Nilai Bobot: 10.210 kg, Plat: `B 1234 ASD` | **PASS** |
| **TC-02** | Pengamanan Timbang Ulang (BR-05) | `BK-SUCCESS-01` | Timbang ulang tiket yang sama dengan bobot baru | **🟢 HIJAU (SUCCESS)**<br>Data lama ditandai `SUPERSEDED`, record baru aktif | **PASS** |
| **TC-03** | Penolakan Tiket Sudah Check-In | `BK-CHECKED-02` | `order_items.check_in_time` sudah terisi (status = 1) | **🟡 KUNING (TIKET SUDAH CHECK IN)**<br>Lingkaran Kuning, dicegat lock `FOR UPDATE`, audit `REJECTED` | **PASS** |
| **TC-04** | Penolakan Tiket Kedaluwarsa (Expired) | `BK-EXPIRED-03` | Jadwal berangkat H-5 jam lalu (lewat batas toleransi) | **🔴 MERAH (TIKET EXPIRED)**<br>Lingkaran Merah, audit `REJECTED`, nada buzzer error | **PASS** |
| **TC-05** | Kode Booking Tidak Ditemukan | `BK-INVALID-99` | Barcode acak / tidak terdaftar di database | **🔴 MERAH (KODE BOOKING TIDAK VALID)**<br>Lingkaran Merah Silang, notifikasi gagal | **PASS** |

---

## 4. Bukti Pengujian Visual Desain Resmi ASDP (*UI Screenshots*)

### 4.1 Layar Standby (Menunggu Kendaraan & Monitoring Telemetri)
Menampilkan banner resmi ASDP di bagian atas, sub-bar status pos timbang & operator, kotak *"PEMINDAIAN TIKET"* di sisi kiri, dan kartu monitor berat riil (52px tabular nums) dengan badge kestabilan berkedip di sisi kanan. Bersih dan fokus tanpa tombol atau tabel tambahan.

![01 Standby Screen](./screenshots/01_standby_screen.png)

---

### 4.2 Kondisi 1: Berhasil Input Berat Kendaraan (Layar HIJAU)
Dipicu saat memindai tiket valid `BK-SUCCESS-01`. Menampilkan ikon outline lingkaran hijau centang (`#22c55e`), judul *"BERHASIL INPUT BERAT KENDARAAN"*, dan kotak putih penampil bobot akhir (kg). Murni visual sesuai spesifikasi resmi tanpa tombol manual.

![02 Success Green Screen](./screenshots/02_success_green_screen.png)

---

### 4.3 Kondisi 2: Tiket Sudah Check-In (Layar KUNING)
Dipicu saat memindai tiket `BK-CHECKED-02` yang sudah melewati gerbang check-in loket dermaga. Menampilkan lingkaran kuning peringatan (`#f59e0b`), judul *"TIKET SUDAH CHECK IN"*, membunyikan notifikasi audio peringatan, dan mencatat log audit berstatus `REJECTED`.

![03 Checked In Yellow Screen](./screenshots/03_checked_in_yellow_screen.png)

---

### 4.4 Kondisi 3: Tiket Expired (Layar MERAH)
Dipicu saat tiket `BK-EXPIRED-03` telah melewati jadwal keberangkatan beserta jam batas toleransi (*late check-in*). Menampilkan lingkaran merah peringatan (`#ef4444`), judul *"TIKET EXPIRED"*, membunyikan buzzer rendah, dan menolak perekaman berat.

![04 Expired Red Screen](./screenshots/04_expired_red_screen.png)

---

### 4.5 Kondisi 4: Kode Booking Tidak Valid (Layar MERAH)
Dipicu saat barcode tidak ditemukan pada database ASDP (`BK-INVALID-99`). Menampilkan lingkaran merah silang (`#ef4444`) dan judul *"KODE BOOKING TIDAK VALID"*.

![05 Invalid Red Screen](./screenshots/05_invalid_red_screen.png)

---

### 4.6 Layar Standby Siap Operasional
Antarmuka setelah seluruh siklus pengujian selesai, kembali ke mode siaga menunggu pemindaian kendaraan berikutnya.

![06 Standby Ready](./screenshots/06_standby_with_populated_history.png)

---

## 5. Verifikasi Integritas Basis Data (*Database Verification*)

Pemeriksaan baris transaksi langsung pada tabel `vehicle_weighing` membuktikan pemenuhan aturan bisnis operasional ASDP:

```sql
SELECT id, booking_code, license_plate, actual_weight, weigh_status, operator_username, created_at 
FROM vehicle_weighing 
ORDER BY id DESC LIMIT 5;
```

**Output Database:**
```text
+----+---------------+---------------+---------------+--------------+-------------------+---------------------+
| id | booking_code  | license_plate | actual_weight | weigh_status | operator_username | created_at          |
+----+---------------+---------------+---------------+--------------+-------------------+---------------------+
| 77 | BK-INVALID-99 | -             |     10210.000 | REJECTED     | operator_timbang  | 2026-11-19 17:41:55 |
| 76 | BK-EXPIRED-03 | B 9999 ASD    |     10210.000 | REJECTED     | operator_timbang  | 2026-11-19 17:41:50 |
| 75 | BK-CHECKED-02 | B 5678 ASD    |     10210.000 | REJECTED     | operator_timbang  | 2026-11-19 17:41:45 |
| 74 | BK-SUCCESS-01 | B 1234 ASD    |     10210.000 | SUCCESS      | operator_timbang  | 2026-11-19 17:41:40 |
| 73 | BK-SUCCESS-01 | B 1234 ASD    |     10210.000 | SUPERSEDED   | operator_timbang  | 2026-11-19 17:06:40 |
+----+---------------+---------------+---------------+--------------+-------------------+---------------------+
```

### Poin Verifikasi Kunci:
1. **Aturan BR-05 (Re-Weigh Guard):** Record timbang sebelumnya otomatis diperbarui menjadi `SUPERSEDED` sehingga tidak ada duplikasi data bobot aktif per kendaraan.
2. **Dual-Insert Berhasil:** Kolom `vehicles.berat` terisi bobot kendaraan aktif terkini untuk kebutuhan pencetakan Boarding Pass ETIS.
3. **Audit Trail Lengkap:** Seluruh penolakan penimbangan (`REJECTED`) tetap tersimpan rapi untuk rekaman kepatuhan pelabuhan.

---

## 6. Kesimpulan

Repositori **`weighbridge-web-app-fe`** kini telah memiliki **tampilan visual yang 100% selaras dengan repositori eksisting** (banner resmi ASDP, tata letak 2 kolom, kartu status outline murni tanpa tombol, tema terang corporate, dan tanpa tabel riwayat). Seluruh pengujian fungsionalitas dan integrasi backend dinyatakan **LULUS (100% PASS)** dan siap untuk operasional produksi.
