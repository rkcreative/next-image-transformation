import { afterAll, beforeAll, describe, expect, test } from "bun:test";

// Stand-in for imgproxy: honours an explicit `f:<format>` processing option
// and otherwise negotiates the format from the Accept header, the way
// imgproxy does with WebP/AVIF detection enabled.
const formatTypes = { avif: "image/avif", webp: "image/webp", jpeg: "image/jpeg" };
let imgproxy;
let handleRequest;

beforeAll(async () => {
  imgproxy = Bun.serve({
    port: 0,
    fetch(req) {
      const { pathname } = new URL(req.url);
      const explicit = pathname.match(/\/f:([a-z]+)\//)?.[1];
      const accept = req.headers.get("Accept") || "";
      const format =
        explicit ||
        (accept.includes("image/avif")
          ? "avif"
          : accept.includes("image/webp")
            ? "webp"
            : "jpeg");
      return new Response(`fake ${format} bytes`, {
        headers: { "Content-Type": formatTypes[format] },
      });
    },
  });
  process.env.IMGPROXY_URL = `http://localhost:${imgproxy.port}`;
  ({ handleRequest } = await import("./index.js"));
});

afterAll(() => {
  imgproxy?.stop(true);
});

const imageUrl =
  "http://localhost:3000/image/https://example.com/photos/a.jpg?width=640&quality=75";

async function fetchImage(accept) {
  const res = await handleRequest(
    new Request(imageUrl, accept ? { headers: { Accept: accept } } : {})
  );
  return { status: res.status, type: res.headers.get("Content-Type"), body: await res.text() };
}

describe("raster output format", () => {
  test("is WebP regardless of the Accept header", async () => {
    const avifBrowser = await fetchImage("image/avif,image/webp,image/apng,*/*;q=0.8");
    const webpOnlyBrowser = await fetchImage("image/webp,*/*");
    const noAccept = await fetchImage();

    for (const res of [avifBrowser, webpOnlyBrowser, noAccept]) {
      expect(res.status).toBe(200);
      expect(res.type).toBe("image/webp");
      expect(res.body).toBe("fake webp bytes");
    }
  });
});
