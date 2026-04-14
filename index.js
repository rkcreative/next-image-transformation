const version = "0.2.0";

let allowedDomains = process?.env?.ALLOWED_REMOTE_DOMAINS?.split(",") || ["*"];
let imgproxyUrl = process?.env?.IMGPROXY_URL || "http://imgproxy:8080";
const cacheTtl =
  parseInt(process?.env?.CACHE_TTL || "2592000", 10) || 2592000;
const fetchTimeout =
  parseInt(process?.env?.FETCH_TIMEOUT || "10000", 10) || 10000;
if (process.env.NODE_ENV === "development") {
  imgproxyUrl = "http://localhost:8888";
}
allowedDomains = allowedDomains.map((d) => d.trim());

// Map Next.js objectFit values to imgproxy resize types
const fitMap = {
  cover: "fill",
  contain: "fit",
  fill: "force",
  none: "auto",
};

// Extensions that should bypass imgproxy processing
const passthroughExtensions = [".svg", ".gif", ".ico"];

// Headers safe to forward from upstream responses
const safeForwardHeaders = [
  "content-type",
  "content-length",
  "etag",
  "last-modified",
];

// Max dimensions to prevent resource abuse
const MAX_DIMENSION = 4096;
const MAX_QUALITY = 100;
const MIN_QUALITY = 1;

const errorHeaders = {
  "Cache-Control": "no-store, must-revalidate",
  "Content-Type": "text/plain",
};

Bun.serve({
  port: 3000,
  async fetch(req) {
    const url = new URL(req.url);
    if (url.pathname === "/") {
      return new Response(
        `<h3>Next Image Transformation v${version}</h3>More info <a href="https://github.com/rkcreative/next-image-transformation">https://github.com/rkcreative/next-image-transformation</a>.`,
        {
          headers: {
            "Content-Type": "text/html",
            "X-Content-Type-Options": "nosniff",
          },
        }
      );
    }

    if (url.pathname === "/health") {
      return new Response("OK");
    }
    // Handle CORS preflight requests
    if (req.method === "OPTIONS") {
      const origin = req.headers.get("Origin");
      const headers = new Headers();
      if (origin && isOriginAllowed(origin)) {
        headers.set("Access-Control-Allow-Origin", origin);
        headers.set("Access-Control-Allow-Methods", "GET, OPTIONS");
        headers.set("Access-Control-Allow-Headers", "Accept, Content-Type");
        headers.set("Access-Control-Max-Age", "86400");
        headers.set("Vary", "Origin");
      }
      return new Response(null, { status: 204, headers });
    }

    if (url.pathname.startsWith("/image/"))
      return await resize(url, req.headers, req.headers.get("Origin"));
    return Response.redirect(
      "https://github.com/rkcreative/next-image-transformation",
      302
    );
  },
});

async function resize(url, requestHeaders, requestOrigin) {
  const src = url.pathname.split("/").slice(2).join("/");

  let parsedSrc;
  try {
    parsedSrc = new URL(src);
  } catch {
    return new Response("Invalid image URL", { status: 400, headers: errorHeaders });
  }

  // Only allow http/https protocols to prevent SSRF via file://, data://, etc.
  if (!["http:", "https:"].includes(parsedSrc.protocol)) {
    return new Response("Invalid protocol", { status: 400, headers: errorHeaders });
  }

  const origin = parsedSrc.hostname;

  const allowed = allowedDomains.filter((domain) => {
    if (domain === "*") return true;
    if (domain === origin) return true;
    // Wildcard match: *.example.com should match sub.example.com but NOT malicious-example.com
    if (domain.startsWith("*.")) {
      const suffix = domain.slice(1); // ".example.com"
      return origin === domain.slice(2) || origin.endsWith(suffix);
    }
    return false;
  });
  if (allowed.length === 0) {
    return new Response(
      "Domain not allowed",
      { status: 403, headers: errorHeaders }
    );
  }

  // Check if the file should bypass imgproxy (SVG, GIF, ICO)
  const srcPath = parsedSrc.pathname.toLowerCase();
  const shouldPassthrough = passthroughExtensions.some((ext) =>
    srcPath.endsWith(ext)
  );

  // Compute stale-while-revalidate proportional to cache TTL (max 1 day)
  const swr = Math.min(86400, Math.floor(cacheTtl / 10));
  const cacheHeader = `public, max-age=${cacheTtl}, stale-while-revalidate=${swr}`;

  if (shouldPassthrough) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), fetchTimeout);
      let response;
      try {
        response = await fetch(src, { signal: controller.signal });
      } finally {
        clearTimeout(timeout);
      }

      if (!response.ok) {
        return new Response("Source image is unreachable", {
          status: response.status,
          headers: errorHeaders,
        });
      }

      // Verify the response is actually an image
      const contentType = response.headers.get("content-type") || "";
      if (!contentType.startsWith("image/") && !contentType.includes("svg")) {
        return new Response("Unexpected content type", {
          status: 400,
          headers: errorHeaders,
        });
      }

      const headers = buildSafeHeaders(response.headers, requestOrigin);
      headers.set("Cache-Control", cacheHeader);
      return new Response(response.body, { headers });
    } catch (e) {
      console.error("Passthrough fetch error:", e);
      const status = e.name === "AbortError" ? 504 : 502;
      return new Response("Error fetching image", {
        status,
        headers: errorHeaders,
      });
    }
  }

  // Validate and clamp numeric parameters
  const width = Math.min(
    Math.max(parseInt(url.searchParams.get("width"), 10) || 0, 0),
    MAX_DIMENSION
  );
  const height = Math.min(
    Math.max(parseInt(url.searchParams.get("height"), 10) || 0, 0),
    MAX_DIMENSION
  );
  const quality = Math.min(
    Math.max(parseInt(url.searchParams.get("quality"), 10) || 75, MIN_QUALITY),
    MAX_QUALITY
  );
  const fit = url.searchParams.get("fit") || "cover";
  const resizeType = fitMap[fit] || "fill";

  try {
    const preset = "pr:sharp";
    const imgproxyPath = `${imgproxyUrl}/${preset}/resize:${resizeType}:${width}:${height}/q:${quality}/plain/${src}`;

    // Forward the browser's Accept header so imgproxy can negotiate format (WebP/AVIF)
    const accept =
      requestHeaders.get("Accept") || "image/avif,image/webp,image/apng,*/*";

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), fetchTimeout);
    let image;
    try {
      image = await fetch(imgproxyPath, {
        headers: { Accept: accept },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timeout);
    }

    const headers = buildSafeHeaders(image.headers, requestOrigin);

    // If imgproxy returned an error, pass it through with no-cache
    if (!image.ok) {
      headers.set("Cache-Control", "no-store, must-revalidate");
      return new Response(image.body, {
        status: image.status,
        headers,
      });
    }

    // Set cache headers for successful responses
    headers.set("Cache-Control", cacheHeader);

    return new Response(image.body, { headers });
  } catch (e) {
    console.error("Image resize error:", e);
    const status = e.name === "AbortError" ? 504 : 502;
    return new Response("Error resizing image", {
      status,
      headers: errorHeaders,
    });
  }
}

// Allowed CORS origins — derived from ALLOWED_REMOTE_DOMAINS
// e.g., *.swingular.com allows https://swingular.com, https://cdn.swingular.com, etc.
const allowedCorsOrigins = process?.env?.ALLOWED_CORS_ORIGINS?.split(",").map(d => d.trim()) || ["*"];

function isOriginAllowed(origin) {
  if (!origin) return false;
  for (const pattern of allowedCorsOrigins) {
    if (pattern === "*") return true;
    if (pattern === origin) return true;
    // Wildcard: *.swingular.com matches https://swingular.com and https://sub.swingular.com
    if (pattern.startsWith("*.")) {
      const domain = pattern.slice(2); // "swingular.com"
      try {
        const originHost = new URL(origin).hostname;
        if (originHost === domain || originHost.endsWith("." + domain)) return true;
      } catch {}
    }
  }
  return false;
}

// Build a new Headers object with only safe headers forwarded from upstream
function buildSafeHeaders(sourceHeaders, requestOrigin) {
  const headers = new Headers();
  for (const name of safeForwardHeaders) {
    const value = sourceHeaders.get(name);
    if (value) headers.set(name, value);
  }
  headers.set("Server", "NextImageTransformation");
  headers.set("X-Content-Type-Options", "nosniff");

  // CORS: Allow requests from permitted origins
  if (requestOrigin && isOriginAllowed(requestOrigin)) {
    headers.set("Access-Control-Allow-Origin", requestOrigin);
    headers.set("Vary", "Origin");
  } else if (allowedCorsOrigins.includes("*")) {
    headers.set("Access-Control-Allow-Origin", "*");
  }

  return headers;
}
