/**
 * @deepseek-ai/dsh-host-frontend-static — SPA dist server over the webserver
 * fallback seat: serves the built frontend directory with explicit index
 * entry points. A readable index renders at the dist root and configured index
 * path; missing paths return 404, traversal outside the dist root is 403,
 * unknown extensions ship as octet-stream, and non-GET/HEAD is 405. Every
 * index response first passes Connection's browser authentication, then the
 * webserver's index render (structured injection rows, then raw taps).
 * Non-index assets stay public. The dist location is workspace knowledge of
 * the composing application, so `distIndex` is typically supplied through a
 * `!!js` expression, never hardcoded by a deployment.
 * @module @deepseek-ai/dsh-host-frontend-static
 */

import type { ServerResponse } from 'node:http'
import { createHash, randomBytes } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { dirname, extname, join, normalize, resolve, sep } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-client-connection'
import type {} from '@deepseek-ai/dsh-host-webserver'

/** Stable Cordis plugin name. */
export const name = 'frontend-static'

/** Services required before the authenticated fallback seat can be claimed. */
export const inject = ['webServer', 'connection']

/** Plugin config: the dist anchor. */
export interface Config {
  /** Absolute path of index.html inside the dist root. */
  distIndex: string
}

export const Config: z<Config> = z.object({
  distIndex: z.string().required(),
})

const HTML_MIME = 'text/html; charset=utf-8'

const MIME: Record<string, string> = {
  '.html': HTML_MIME,
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  // The packed VFS image. Served as its own bytes, never as a Content-Encoding:
  // the worker inflates the body itself, and a transport-level encoding would
  // leave it inflating an already-decoded archive.
  '.gz': 'application/gzip',
}

const STATIC_MISS_CODES: ReadonlySet<string | undefined> = new Set([
  'ENOENT',
  'EISDIR',
  'ENOTDIR',
])

/**
 * Restrict executable page resources to local assets and exact inline blocks.
 *
 * The policy deliberately keeps `'unsafe-eval'` in `script-src` (the client
 * module system compiles `!!js` patch expressions with `new Function` at boot)
 * and ships `'unsafe-inline'` styles **without** a nonce or hash source: a
 * present nonce/hash would silently disable `'unsafe-inline'` per the CSP
 * spec, and every plugin injects its stylesheets as runtime `<style>`
 * elements that can never carry the page nonce. Dropping the nonce there was
 * the fix for plugin layouts collapsing into the page flow.
 */
function pageContentSecurityPolicy(html: string, scriptNonce: string): string {
  const hashes = (tag: 'script' | 'style'): string[] => {
    const expression = tag === 'script'
      ? /<script\b([^>]*)>([\s\S]*?)<\/script\s*>/giu
      : /<style\b([^>]*)>([\s\S]*?)<\/style\s*>/giu
    const values = new Set<string>()
    for (const match of html.matchAll(expression)) {
      const attributes = match[1] ?? ''
      const content = match[2] ?? ''
      if (tag === 'script' && /(?:^|\s)src\s*=/iu.test(attributes)) continue
      const digest = createHash('sha256').update(content.replace(/\r\n?/gu, '\n')).digest('base64')
      values.add(`'sha256-${digest}'`)
    }
    return [...values]
  }
  const scriptHashes = hashes('script')
  return [
    "default-src 'self'",
    `script-src 'self' 'unsafe-eval' 'wasm-unsafe-eval' 'nonce-${scriptNonce}' ${scriptHashes.join(' ')}`.trim(),
    'script-src-attr \'none\'',
    "style-src 'self' 'unsafe-inline'",
    "style-src-attr 'unsafe-inline'",
    "connect-src 'self'",
    "img-src 'self' data: blob:",
    "font-src 'self' data:",
    "media-src 'self' data: blob:",
    "worker-src 'self' blob:",
    "frame-src 'self' blob:",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'self'",
    "frame-ancestors 'none'",
  ].join('; ')
}

/**
 * Serve one GET/HEAD static request from the dist root.
 * @param pathname - decoded URL pathname of the request.
 * @param res - the node:http response to write.
 * @param distRoot - absolute dist root directory (resolved by the caller).
 * @param distIndex - absolute path of index.html inside distRoot.
 * @param authorizeIndex - authenticates an index response before its bytes are read.
 * @param renderIndex - produces the index.html body (structured injection
 * rendering) for the dist root and configured index path.
 */
export async function serveStatic(
  pathname: string, res: ServerResponse, distRoot: string, distIndex: string,
  authorizeIndex: () => boolean,
  renderIndex: () => Promise<string>,
): Promise<void> {
  const target = resolve(normalize(join(distRoot, pathname)))
  // Traversal rejection: the target must be distRoot itself (`/`) or stay under
  // it. `sep`, not '/': resolve() emits backslash paths on Windows, where a '/'
  // suffix would reject every legitimate subpath as traversal.
  if (target !== distRoot && !target.startsWith(distRoot + sep)) {
    res.writeHead(403)
    res.end()
    return
  }
  let body: string | Buffer
  let type: string
  let contentSecurityPolicy: string | undefined
  try {
    if (target === distRoot || target === distIndex) {
      if (!authorizeIndex()) return
      const styleNonce = randomBytes(18).toString('base64')
      const scriptNonce = randomBytes(18).toString('base64')
      body = await renderIndex()
      const head = /<head(?:\s[^>]*)?>/iu
      if (!head.test(body)) throw new Error('Rendered index must contain a head element for runtime nonces.')
      body = body.replace(head, open => `${open}<meta name="dsh-style-nonce" content="${styleNonce}"><meta name="dsh-script-nonce" content="${scriptNonce}">`)
      type = HTML_MIME
      contentSecurityPolicy = pageContentSecurityPolicy(body, scriptNonce)
    } else {
      body = await readFile(target)
      type = MIME[extname(target)] ?? 'application/octet-stream'
    }
  } catch (error) {
    // Only absent or non-file targets are 404; other filesystem failures reach
    // the webserver's request-failure handling.
    if (!STATIC_MISS_CODES.has((error as NodeJS.ErrnoException).code)) throw error
    res.writeHead(404)
    res.end()
    return
  }
  res.writeHead(200, {
    'content-type': type,
    ...(contentSecurityPolicy === undefined ? {} : { 'content-security-policy': contentSecurityPolicy }),
  })
  res.end(body)
}

/**
 * Claim the webserver fallback seat and serve the dist.
 * @param ctx - plugin context carrying the webServer service.
 * @param config - validated {@link Config}.
 */
export function apply(ctx: Context, config: Config): void {
  const distIndex = config.distIndex
  const distRoot = dirname(distIndex)
  // The dist is built with a relative base so the same files mount under any
  // static directory; served pages also answer deep SPA-fallback paths, where
  // relative asset URLs would resolve under the request directory, so the
  // served form anchors them at the site root ahead of every URL-bearing tag.
  const renderIndex = async (): Promise<string> => {
    const body = ctx.webServer.renderIndex(await readFile(distIndex, 'utf8'))
    return body.replace(/<head(?:\s[^>]*)?>/i, open => `${open}<base href="/">`)
  }
  ctx.effect(() => ctx.webServer.registerFallback(async (req, res) => {
    // Non-GET/HEAD without a matching named route is 405 (fallback-only
    // semantics: named routes own their method handling).
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      res.writeHead(405)
      res.end()
      return
    }
    /* v8 ignore next -- node:http always sets url on server requests */
    const rawPath = new URL(req.url ?? '/', 'http://x').pathname
    await serveStatic(
      decodeURIComponent(rawPath),
      res,
      distRoot,
      distIndex,
      () => ctx.connection.authorizeIndex(req, res),
      renderIndex,
    )
  }), 'frontend-static: fallback seat')
}
