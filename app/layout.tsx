import type { Metadata } from "next";
import { Inter, Plus_Jakarta_Sans } from "next/font/google";
import Script from "next/script";
import "./globals.css";
import AppShell from "@/components/AppShell";
import { ThemeProvider } from "@/components/ThemeProvider";

const inter = Inter({ subsets: ["latin"], variable: "--font-inter" });
const plusJakarta = Plus_Jakarta_Sans({
  subsets: ["latin"],
  variable: "--font-display",
});

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
    <html lang="en" suppressHydrationWarning>
      <body
        className={`${inter.className} ${inter.variable} ${plusJakarta.variable} flex h-screen min-h-0 w-full flex-col overflow-hidden bg-background antialiased`}
        suppressHydrationWarning
      >
        <Script id="admin-theme-init" strategy="beforeInteractive">
          {`(function(){try{var t=localStorage.getItem('admin-theme');var m=t==='light'?'light':'dark';var r=document.documentElement;r.classList.remove('light','dark');r.classList.add(m);r.style.colorScheme=m==='dark'?'dark':'light';}catch(e){document.documentElement.classList.add('dark');}})();`}
        </Script>
        <ThemeProvider>
          <AppShell>{children}</AppShell>
        </ThemeProvider>
      </body>
    </html>
  );
}
