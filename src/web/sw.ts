interface WorkerScope {
  skipWaiting(): Promise<void>
  clients: { claim(): Promise<void> }
  addEventListener(type: 'install' | 'activate', listener: (event: { waitUntil(promise: Promise<unknown>): void }) => void): void
  addEventListener(type: 'fetch', listener: (event: { request: Request; respondWith(response: Promise<Response> | Response): void }) => void): void
}

declare const __HEDDLEWORK_BUILD_HASH__: string
declare const __HEDDLEWORK_PRECACHE__: string[]

const worker = self as unknown as WorkerScope
const CACHE = 'heddlework-' + __HEDDLEWORK_BUILD_HASH__
const PRECACHE = __HEDDLEWORK_PRECACHE__

worker.addEventListener('install', (event) => {
  event.waitUntil(caches.open(CACHE).then((cache) => cache.addAll(PRECACHE)).then(() => worker.skipWaiting()))
})

worker.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key !== CACHE).map((key) => caches.delete(key)))
    await worker.clients.claim()
  })())
})

worker.addEventListener('fetch', (event) => {
  const request = event.request
  const url = new URL(request.url)
  if (request.method !== 'GET') return
  if (url.protocol === 'ws:' || url.protocol === 'wss:') return
  if (url.pathname === '/ws' || url.pathname === '/health') return
  if (url.pathname === '/' || url.pathname === '/index.html') {
    event.respondWith(networkFirst(request))
    return
  }
  event.respondWith(cacheFirst(request))
})

async function networkFirst(request: Request): Promise<Response> {
  try {
    const response = await fetch(request)
    const cache = await caches.open(CACHE)
    await cache.put(request, response.clone())
    return response
  } catch {
    const cached = await caches.match(request)
    if (cached) return cached
    throw new Error('Offline and no cached app shell')
  }
}

async function cacheFirst(request: Request): Promise<Response> {
  const cached = await caches.match(request)
  if (cached) return cached
  return fetch(request)
}
