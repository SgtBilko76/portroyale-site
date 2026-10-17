// Port Royale APK relay (Cloudflare Worker).
// GitHub release downloads send no CORS headers, so a web page can't fetch an
// APK itself. This worker fetches it and streams it back with CORS headers.
// It only relays APKs from SgtBilko76's own GitHub releases.
// Deploy: cd installer/relay && npx wrangler deploy

const ALLOWED_ORIGINS = [
  "https://portroyale.online",
  "https://www.portroyale.online",
  "https://sgtbilko76.github.io",
  "https://csvr.online",
  "https://www.csvr.online",
  "http://localhost:8000",
  "http://127.0.0.1:8000",
];
const ALLOWED_URL = /^https:\/\/github\.com\/SgtBilko76\/[A-Za-z0-9._-]+\/releases\/download\/[^?#]+\.apk$/;

export default {
  async fetch(request) {
    const origin = request.headers.get("Origin") || "";
    const cors = {
      "Access-Control-Allow-Origin": ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
      "Access-Control-Expose-Headers": "Content-Length",
      "Vary": "Origin",
    };
    if (request.method === "OPTIONS") {
      return new Response(null, { headers: { ...cors, "Access-Control-Allow-Methods": "GET, HEAD", "Access-Control-Max-Age": "86400" } });
    }
    if (request.method !== "GET" && request.method !== "HEAD") {
      return new Response("method not allowed", { status: 405, headers: cors });
    }
    const target = new URL(request.url).searchParams.get("url") || "";
    if (!ALLOWED_URL.test(target)) {
      return new Response("Port Royale APK relay: only SgtBilko76 release APKs are relayed.", { status: 400, headers: cors });
    }
    const upstream = await fetch(target, { method: request.method, redirect: "follow" });
    if (!upstream.ok) {
      return new Response(`upstream returned ${upstream.status}`, { status: 502, headers: cors });
    }
    const headers = new Headers(cors);
    headers.set("Content-Type", "application/vnd.android.package-archive");
    headers.set("Cache-Control", "no-store");
    const len = upstream.headers.get("Content-Length");
    if (len) headers.set("Content-Length", len);
    return new Response(upstream.body, { status: 200, headers });
  },
};
