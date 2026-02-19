# Next.js Image Transformation (Improved Fork)

> Forked from [coollabsio/next-image-transformation](https://github.com/coollabsio/next-image-transformation) with bug fixes and improvements.

An open-source & self-hostable image optimization service, a drop-in replacement for Vercel's Image Optimization. Built with [Bun](https://bun.sh/) and [imgproxy](https://imgproxy.net/).

## What's Improved

This fork fixes critical issues and adds features missing from the original:

### Bug Fixes
- **Proper error status codes** — The original returns `200 OK` for failed image fetches (e.g., "Source image is unreachable"), causing CDNs like Cloudflare to cache broken responses. This fork returns proper `4xx`/`5xx` status codes.
- **`Cache-Control: no-store` on errors** — Error responses include `no-store` headers so CDNs never cache failures.
- **Invalid URL handling** — Malformed image URLs return `400 Bad Request` instead of crashing.

### New Features
- **WebP/AVIF auto-negotiation** — Forwards the browser's `Accept` header to imgproxy so it can serve the optimal format (WebP, AVIF) based on browser support, instead of hardcoding the Accept header.
- **Configurable cache TTL** — Set `CACHE_TTL` env var to control how long successful images are cached (default: 30 days).
- **`Cache-Control` on success** — Successful responses include proper `Cache-Control` headers with `stale-while-revalidate` for optimal CDN behavior.
- **SVG/GIF/ICO passthrough** — These formats bypass imgproxy processing (which would break them) and are proxied directly from the source.
- **`fit` mode support** — Map Next.js `objectFit` values (`cover`, `contain`, `fill`, `none`) to imgproxy resize types via the `fit` query parameter.

## Supported Transformations

| Parameter | Description | Default |
|-----------|-------------|---------|
| `width` | Target width in pixels | `0` (original) |
| `height` | Target height in pixels | `0` (original) |
| `quality` | Image quality (1-100) | `75` |
| `fit` | Resize mode: `cover`, `contain`, `fill`, `none` | `cover` |

## Environment Variables

| Variable | Description | Default |
|----------|-------------|---------|
| `IMGPROXY_URL` | URL of the imgproxy service | `http://imgproxy:8080` |
| `ALLOWED_REMOTE_DOMAINS` | Comma-separated list of allowed source domains. Use `*` for all. Supports wildcards (e.g., `*.example.com`) | `*` |
| `CACHE_TTL` | Cache TTL in seconds for successful responses | `2592000` (30 days) |

## How to Deploy with Coolify

1. Login to your [Coolify](https://coolify.io) instance or the [cloud](https://app.coolify.io).
2. Create a new Docker Compose service using this repo's `docker-compose.yaml`.
3. Change the image from `ghcr.io/coollabsio/next-image-transformation` to `ghcr.io/rkcreative/next-image-transformation`.
4. Optional: Set `ALLOWED_REMOTE_DOMAINS` to restrict which domains can be optimized.
5. Set your `<domain>` on the service.
6. Deploy.

## How to Use in Next.js

1. In `next.config.js`, configure a custom image loader:

```javascript
module.exports = {
  images: {
    loader: 'custom',
    loaderFile: './src/lib/imageLoader.ts', // or ./loader.js
  },
}
```

2. Create the loader file:

```typescript
interface ImageLoaderProps {
  src: string;
  width: number;
  quality?: number;
}

export default function imageLoader({ src, width, quality }: ImageLoaderProps): string {
  const imageServiceUrl = process.env.NEXT_PUBLIC_IMAGE_SERVICE_URL;

  if (!imageServiceUrl) {
    return src;
  }

  let imageUrl = src;
  if (src.startsWith('/')) {
    const baseUrl = process.env.NEXT_PUBLIC_SITE_URL || 'https://example.com';
    imageUrl = `${baseUrl}${src}`;
  }

  const params = new URLSearchParams();
  params.set('width', width.toString());
  if (quality) params.set('quality', quality.toString());

  return `${imageServiceUrl}/image/${imageUrl}?${params.toString()}`;
}
```

## Includes

1. **Next Image Transformation API** — A Bun server that transforms incoming requests to imgproxy format.
2. **imgproxy** — A fast image processing service that resizes, crops, and converts images on the fly.

## Self-Hosting with Docker Compose

```bash
docker compose up -d
```

The service will be available at `http://localhost:3000`.

## License

Same as the original — see [LICENSE](LICENSE).
