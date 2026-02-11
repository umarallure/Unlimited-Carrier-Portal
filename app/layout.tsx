import type { Metadata } from "next";
import { Inter } from "next/font/google";
import "./globals.css";
import Sidebar from "@/components/Sidebar";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Unlimited Insurance Admin",
  description: "Admin Dashboard for Unlimited Insurance",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en">
      <body className={`${inter.className} flex h-screen bg-background`}>
        <Sidebar />
        <main className="flex-1 overflow-y-auto p-8 bg-slate-950">
          {children}
        </main>
      </body>
    </html>
  );
}
