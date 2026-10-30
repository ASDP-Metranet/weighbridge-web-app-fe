import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "ASDP - Terminal Pos Jembatan Timbang",
  description: "Aplikasi Khusus Pos Jembatan Timbang Pelabuhan ASDP",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="id">
      <body className="antialiased min-h-screen bg-slate-900 text-white">
        {children}
      </body>
    </html>
  );
}
