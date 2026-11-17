/* =========================================================================
 * sw.js — Service Worker (hilo en segundo plano)
 * -------------------------------------------------------------------------
 * - App Shell en Cache Storage con rutas RELATIVAS (GitHub Pages)
 * - Motor de sincronización con Background Sync API (evento 'sync')
 * - Aviso a las pestañas abiertas con postMessage
 *
 * Aquí NO existen window ni document. Para usar IndexedDB importamos
 * el mismo mini-wrapper que usa la página.
 * Regla del curso: solo Promesas explícitas (new Promise / .then / .catch).
 * ========================================================================= */

// Fragmento A: importar el helper con ruta relativa
importScripts('./db-helper.js');

const CACHE_STATIC_NAME = 'static-outbox-v2';
const STATIC_FILES = [
  './',
  './index.html',
  './styles.css',
  './db-helper.js',
  './app.js',
  './manifest.json',
  './icons/icon-192.png',
  './icons/icon-512.png'
];

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const SYNC_TAG = 'sync-reportes';

/* -------------------------------------------------------------------------
 * INSTALL: precache del App Shell
 * ------------------------------------------------------------------------- */
self.addEventListener('install', (event) => {
  console.log('[SW] Instalando', CACHE_STATIC_NAME);
  event.waitUntil(
    caches.open(CACHE_STATIC_NAME)
      .then((cache) => cache.addAll(STATIC_FILES))
      .then(() => self.skipWaiting())
  );
});

/* -------------------------------------------------------------------------
 * ACTIVATE: borrar cachés de versiones anteriores
 * ------------------------------------------------------------------------- */
self.addEventListener('activate', (event) => {
  console.log('[SW] Activando', CACHE_STATIC_NAME);
  event.waitUntil(
    caches.keys()
      .then((nombres) => {
        return Promise.all(
          nombres
            .filter((nombre) => nombre !== CACHE_STATIC_NAME)
            .map((nombre) => caches.delete(nombre))
        );
      })
      .then(() => self.clients.claim())
  );
});

/* -------------------------------------------------------------------------
 * FETCH: Cache First solo para GET del propio origen.
 * Los POST (y la API externa) pasan directo a la red: si fallan, el
 * .catch() de app.js los encola en IndexedDB (Patrón Outbox).
 * ------------------------------------------------------------------------- */
self.addEventListener('fetch', (event) => {
  const peticion = event.request;

  if (peticion.method !== 'GET') return;
  if (new URL(peticion.url).origin !== self.location.origin) return;

  event.respondWith(
    caches.match(peticion, { ignoreSearch: true })
      .then((respuestaCache) => {
        if (respuestaCache) return respuestaCache;

        return fetch(peticion)
          .then((respuestaRed) => {
            if (respuestaRed && respuestaRed.ok) {
              const copia = respuestaRed.clone();
              caches.open(CACHE_STATIC_NAME).then((cache) => cache.put(peticion, copia));
            }
            return respuestaRed;
          })
          .catch(() => {
            // Sin red y sin caché: si es una navegación, servimos el App Shell
            if (peticion.mode === 'navigate') {
              return caches.match('./index.html');
            }
            return new Response('', { status: 503, statusText: 'Offline' });
          });
      })
  );
});

/* -------------------------------------------------------------------------
 * Fragmento B: avisar a todas las pestañas abiertas (postMessage)
 * ------------------------------------------------------------------------- */
function notificarClientesActualizacion() {
  return self.clients.matchAll({ type: 'window', includeUncontrolled: true })
    .then((clientes) => {
      clientes.forEach((cliente) => {
        cliente.postMessage({
          tipo: 'OUTBOX_SINCRONIZADO',
          timestamp: Date.now()
        });
      });
    });
}

/* -------------------------------------------------------------------------
 * Fragmento C: motor de sincronización en segundo plano
 * Se retorna TODA la cadena para que event.waitUntil() sepa cuándo terminó.
 * ------------------------------------------------------------------------- */
function sincronizarPendientesSW() {
  console.log('[SW-Sync] Ejecutando barrido de transacciones pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[SW-Sync] Cola limpia. Nada por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            title: item.titulo,
            body: item.descripcion
          })
        })
          .then((respuesta) => {
            if (!respuesta.ok) {
              throw new Error(`Error HTTP ${respuesta.status} al sincronizar ID ${item.id}`);
            }
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio)
        .then(() => notificarClientesActualizacion());
    });
}

/* -------------------------------------------------------------------------
 * Fragmento D: evento 'sync'
 * Relanzar el error (throw) marca la sync como fallida y el navegador
 * programa un reintento automático (backoff). Si solo hiciéramos
 * console.error, la promesa se resolvería y la tarea se daría por buena.
 * ------------------------------------------------------------------------- */
self.addEventListener('sync', (event) => {
  console.log('[SW-Sync] Evento sync disparado con etiqueta:', event.tag);

  if (event.tag === SYNC_TAG) {
    event.waitUntil(
      sincronizarPendientesSW()
        .catch((error) => {
          console.error('[SW-Sync] Falla en sincronización; el navegador reintentará luego:', error);
          throw error;
        })
    );
  }
});
