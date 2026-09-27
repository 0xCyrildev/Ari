/**
 * The console's only door to a deployment, and the reason it is a door rather than CORS.
 *
 * `ari-api` listens on loopback with no `Origin` handling, and the honest way to make a
 * browser able to reach it is not to teach a payment API to trust a second scheme. A same-origin
 * proxy means the API's authentication surface is unchanged — one bearer credential, the same
 * scopes, the same refusals — and the browser never learns a host to talk to.
 *
 * What makes this a control instead of a tunnel is the table below. A generic "forward anything"
 * proxy would hand a browser tab the whole route table, including the two routes that *spend*
 * (`/v1/transactions/authorize`, `/evaluate` — an agent's credential could ride along on a
 * screen built for a human) and the three that mint authority behind the deployment's bootstrap
 * token (`/v1/organizations`, `/v1/users`, `/v1/users/:id/credentials`, which is how a person
 * with the bootstrap secret creates an approver). So the method and the path both have to
 * appear, and anything else is refused here rather than forwarded and refused downstream: a
 * refusal that names nothing is the same shape as the API's own 404s, which is deliberate.
 *
 * The upstream is configuration, never a parameter: `ARI_API_URL` is read from the environment
 * and no request can point this handler at a host of its choosing.
 */

import { NextResponse } from 'next/server'

/** The same rule `apps/cli/src/http.ts` runs on: loopback or TLS, never a plain link for a bearer secret. */
function upstream(): URL | null {
  const raw = process.env.ARI_API_URL ?? 'http://127.0.0.1:4000'
  if (!raw.startsWith('http://127.0.0.1') && !raw.startsWith('https://')) return null
  try {
    return new URL(raw)
  } catch {
    return null
  }
}

const ID = '[0-9A-Za-z_.:-]{1,120}'

/** Method and path, matched against the upstream path. Nothing in this table can move money. */
const ALLOWED: readonly { readonly method: string; readonly path: RegExp }[] = [
  { method: 'GET', path: /^\/healthz$/ },
  { method: 'GET', path: /^\/v1\/transactions$/ },
  { method: 'GET', path: new RegExp(`^\\/v1\\/transactions\\/${ID}\\/record$`) },
  { method: 'GET', path: /^\/v1\/summary$/ },
  { method: 'GET', path: /^\/v1\/wallets$/ },
  { method: 'GET', path: /^\/v1\/policies$/ },
  { method: 'GET', path: /^\/v1\/agents$/ },
  { method: 'GET', path: /^\/v1\/approvals$/ },
  { method: 'GET', path: new RegExp(`^\\/v1\\/approvals\\/${ID}$`) },
  { method: 'GET', path: /^\/v1\/audit\/events$/ },
  { method: 'POST', path: /^\/v1\/agents$/ },
  { method: 'POST', path: new RegExp(`^\\/v1\\/agents\\/${ID}\\/revoke$`) },
  { method: 'POST', path: new RegExp(`^\\/v1\\/agents\\/${ID}\\/credentials$`) },
  { method: 'POST', path: /^\/v1\/wallets$/ },
  { method: 'POST', path: new RegExp(`^\\/v1\\/agents\\/${ID}\\/wallets\\/${ID}$`) },
  { method: 'POST', path: /^\/v1\/policies$/ },
  { method: 'POST', path: new RegExp(`^\\/v1\\/approvals\\/${ID}\\/decisions$`) },
]

const permitted = (method: string, path: string): boolean =>
  ALLOWED.some((entry) => entry.method === method && entry.path.test(path))

/** The whole query string is forwarded; the upstream validates every value it reads. */
function targetFor(request: Request, base: URL, path: string): string {
  const search = new URL(request.url).search
  return `${base.origin}${path}${search}`
}

const refused = (status: number) => NextResponse.json({ code: status === 404 ? 'NOT_FOUND' : 'REFUSED' }, { status })

async function forward(request: Request, segments: string[]): Promise<NextResponse> {
  const base = upstream()
  if (base === null) return refused(502)

  const path = `/${segments.map(encodeURIComponent).join('/')}`
  const method = request.method.toUpperCase()
  if (!permitted(method, path)) return refused(404)

  // Bound before reading: the upstream's own body limit is 64 KB, and a handler that streams
  // an unbounded body into `arrayBuffer()` is a memory problem this process owns, not theirs.
  const declared = Number(request.headers.get('content-length') ?? '0')
  if (Number.isFinite(declared) && declared > 64 * 1024) return refused(413)

  const headers: Record<string, string> = {}
  const authorization = request.headers.get('authorization')
  if (authorization !== null) headers.authorization = authorization
  const body = method === 'GET' || method === 'HEAD' ? undefined : await request.arrayBuffer()
  if (body !== undefined && body.byteLength > 0) headers['content-type'] = 'application/json'

  let answer: Response
  try {
    answer = await fetch(targetFor(request, base, path), {
      method,
      headers,
      ...(body === undefined ? {} : { body }),
      cache: 'no-store',
    })
  } catch {
    // One sentence for "there is no deployment", "it refused the connection" and "it answered
    // too slowly", because which one it was is a fact about this process's network, not
    // something the person holding the credential should be told.
    return refused(502)
  }

  const text = await answer.text()
  const contentType = answer.headers.get('content-type') ?? 'application/json'
  return new NextResponse(text.length === 0 ? null : text, {
    status: answer.status,
    headers: { 'content-type': contentType, 'cache-control': 'no-store' },
  })
}

type Ctx = { readonly params: Promise<Record<string, string | string[] | undefined>> }

const segmentsFrom = async (context: Ctx): Promise<string[]> => {
  const params = await context.params
  const raw = params.path
  return Array.isArray(raw) ? raw : typeof raw === 'string' ? [raw] : []
}

export async function GET(request: Request, context: Ctx): Promise<NextResponse> {
  return forward(request, await segmentsFrom(context))
}

export async function POST(request: Request, context: Ctx): Promise<NextResponse> {
  return forward(request, await segmentsFrom(context))
}
