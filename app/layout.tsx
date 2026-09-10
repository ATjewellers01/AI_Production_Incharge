import type { Metadata } from 'next';
import { DM_Sans } from 'next/font/google';
import './globals.css';

// Matches at-order-to-dispatch-frontend's own font choice (DM Sans via
// next/font/google), so this app's typography reads as part of the same
// O2D product family.
const dmSans = DM_Sans({ subsets: ['latin'], variable: '--font-dm-sans' });

export const metadata: Metadata = {
  title: 'AI Production Incharge — O2D',
  description: 'Read-only production insights and Q&A for Order-to-Delivery',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en" className={dmSans.variable}>
      <body className="min-h-dvh font-sans antialiased">{children}</body>
    </html>
  );
}
