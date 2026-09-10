/**
 * Zero-dependency diagnostic page — no client hooks, no API calls, no
 * imports beyond React/Next itself. Plain server-rendered HTML, using the
 * app's existing root layout (which already provides <html>/<body>).
 *
 * Purpose: /api/ping already proved a bare API route 502s exactly like
 * every other route on this service. This does the same test for the
 * FRONTEND (page) rendering path, in case Next.js routes API vs. page
 * requests differently at the platform layer. If /hello ALSO 502s
 * identically, every request path on this service is broken — conclusive
 * proof this is Render's platform/routing layer, not anything in this
 * repo's application code.
 */
export default function HelloPage() {
  return (
    <div style={{ fontFamily: 'sans-serif', padding: 40 }}>
      <h1>hello world</h1>
      <p>If you can see this, the deployed container is reachable and rendering.</p>
      <p suppressHydrationWarning>Server time: {new Date().toISOString()}</p>
    </div>
  );
}
