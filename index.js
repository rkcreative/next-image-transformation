const version = "0.1.0";

let allowedDomains = process?.env?.ALLOWED_REMOTE_DOMAINS?.split(",") || ["*"];
let imgproxyUrl = process?.env?.IMGPROXY_URL || "http://imgproxy:8080";
const cacheTtl = parseInt(process?.env?.CACHE_TTL || "2592000", 10); // default 30 days
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
          },
        }
      );
    }

    if (url.pathname === "/health") {
      return new Response("OK");
    }
    if (url.pathname.startsWith("/image/"))
      return await resize(url, req.headers);
    return Response.redirect(
      "https://github.com/rkcreative/next-image-transformation",
      302
    );
  },
});

async function resize(url, requestHeaders) {
  const src = url.pathname.split("/").slice(2).join("/");

  let origin;
  try {
    origin = new URL(src).hostname;
  } catch {
    return new Response("Invalid image URL", {
      status: 400,
      headers: { "Cache-Control": "no-store, must-revalidate" },
    });
  }

  const allowed = allowedDomains.filter((domain) => {
    if (domain === "*") return true;
    if (domain === origin) return true;
    if (domain.startsWith("*.") && origin.endsWith(domain.split("*.").pop()))
      return true;
    return false;
  });
  if (allowed.length === 0) {
    return new Response(
      `Domain (${origin}) not allowed. More details here: https://github.com/rkcreative/next-image-transformation`,
      {
        status: 403,
        headers: { "Cache-Control": "no-store, must-revalidate" },
      }
    );
  }

  // Check if the file should bypass imgproxy (SVG, GIF, ICO)
  const srcLower = src.split("?")[0].toLowerCase();
  const shouldPassthrough = passthroughExtensions.some((ext) =>
    srcLower.endsWith(ext)
  );

  if (shouldPassthrough) {
    try {
      const response = await fetch(src);
      if (!response.ok) {
        return new Response(`Source image is unreachable`, {
          status: response.status,
          headers: { "Cache-Control": "no-store, must-revalidate" },
        });
      }
      const headers = new Headers(response.headers);
      headers.set("Server", "NextImageTransformation");
      headers.set(
        "Cache-Control",
        `public, max-age=${cacheTtl}, stale-while-revalidate=86400`
      );
      return new Response(response.body, { headers });
    } catch (e) {
      console.error("Passthrough fetch error:", e);
      return new Response("Error fetching image", {
        status: 502,
        headers: { "Cache-Control": "no-store, must-revalidate" },
      });
    }
  }

  const width = url.searchParams.get("width") || 0;
  const height = url.searchParams.get("height") || 0;
  const quality = url.searchParams.get("quality") || 75;
  const fit = url.searchParams.get("fit") || "cover";
  const resizeType = fitMap[fit] || "fill";

  try {
    const preset = "pr:sharp";
    const imgproxyPath = `${imgproxyUrl}/${preset}/resize:${resizeType}:${width}:${height}/q:${quality}/plain/${src}`;

    // Forward the browser's Accept header so imgproxy can negotiate format (WebP/AVIF)
    const accept =
      requestHeaders.get("Accept") || "image/avif,image/webp,image/apng,*/*";

    const image = await fetch(imgproxyPath, {
      headers: {
        Accept: accept,
      },
    });

    const headers = new Headers(image.headers);
    headers.set("Server", "NextImageTransformation");

    // If imgproxy returned an error, pass it through with no-cache
    if (!image.ok) {
      headers.set("Cache-Control", "no-store, must-revalidate");
      return new Response(image.body, {
        status: image.status,
        headers,
      });
    }

    // Set cache headers for successful responses
    headers.set(
      "Cache-Control",
      `public, max-age=${cacheTtl}, stale-while-revalidate=86400`
    );

    return new Response(image.body, { headers });
  } catch (e) {
    console.error("Image resize error:", e);
    return new Response("Error resizing image", {
      status: 502,
      headers: { "Cache-Control": "no-store, must-revalidate" },
    });
  }
}
