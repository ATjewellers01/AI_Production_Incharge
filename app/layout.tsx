import type { Metadata } from 'next';
import './globals.css';

export const metadata: Metadata = {
  title: 'AI Production Incharge — O2D',
  description: 'Read-only production insights and Q&A for Order-to-Delivery',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
