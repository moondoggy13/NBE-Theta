import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/sonner";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  metadataBase: new URL("https://nbetechnology.com"),
  title: {
    default: "NB&E Technologies",
    template: "%s | NB&E Technologies",
  },
  description:
    "Research, systems, and operating infrastructure for the markets ahead.",
  openGraph: {
    title: "NB&E Technologies — Observe the signal.",
    description:
      "Research, systems, and operating infrastructure for the markets ahead.",
    url: "/",
    siteName: "NB&E Technologies",
    type: "website",
  },
  twitter: {
    card: "summary_large_image",
    title: "NB&E Technologies — Observe the signal.",
    description:
      "Research, systems, and operating infrastructure for the markets ahead.",
  },
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="en" className={`${geistSans.variable} ${geistMono.variable} h-full antialiased`}>
      <body className="min-h-full text-slate-800">
        <TooltipProvider>{children}</TooltipProvider>
        <Toaster />
      </body>
    </html>
  );
}
