# PWA Outbox — Registro de Incidencias en Campo

PWA en **JavaScript Vanilla** (sin librerías, sin `async/await`) que implementa:

- **Tema 5.1** — Mini-wrapper promisificado de IndexedDB (`db-helper.js`).
- **Tema 5.2** — Patrón Outbox (CRUD offline) y despliegue en GitHub Pages con rutas relativas.
- **Tema 5.3** — Background Sync API en `sw.js`, aviso a la UI con `postMessage` y respaldo con el evento `online` para navegadores sin `SyncManager` (Safari/iOS, Firefox).

## Estructura

```
pwa-outbox-practica/
├── index.html      # UI (carga db-helper.js ANTES que app.js)
├── styles.css
├── db-helper.js    # abrirDB, guardarRegistro, obtenerTodosLosRegistros, actualizarEstadoRegistro, eliminarRegistro
├── app.js          # UI, envío resiliente, registro de sync, fallback 'online', purga
├── sw.js           # App Shell + evento 'sync' + postMessage
├── manifest.json   # start_url y scope relativos
└── icons/          # icon-192.png, icon-512.png
```

## Flujo CRUD

| Operación | Dónde | Qué hace |
|---|---|---|
| CREATE | `procesarEnvioReporte()` (app.js) | `fetch` POST; si falla, `.catch()` guarda en IndexedDB como `'pendiente'` y registra `sync-reportes` |
| READ | `renderizarColaOutbox()` (app.js) | `obtenerTodosLosRegistros()` y pinta un `<li>` por registro |
| UPDATE | `sincronizarPendientesSW()` (sw.js) / `sincronizarPendientesFallback()` (app.js) | reenvía pendientes con `Promise.all()` y marca `'sincronizado'` |
| DELETE | botón `#btn-purgar` (app.js) | elimina los `'sincronizado'` con `Promise.all(eliminarRegistro…)` |

## Probar en local

Los Service Workers requieren `http://localhost` o HTTPS (no funcionan abriendo el archivo con doble clic):

```bash
python -m http.server 8080
```

Abrir `http://localhost:8080`.

## Publicar en GitHub Pages

1. Crear el repositorio `pwa-outbox-practica` (público) en GitHub.
2. Subir los archivos a la rama `main`.
3. **Settings → Pages → Source: Deploy from a branch → `main` / `(root)` → Save.**
4. Esperar ~2 min. URL: `https://<usuario>.github.io/pwa-outbox-practica/`
5. En Chrome → DevTools → Application verificar: Manifest sin advertencias, Service Worker `activated and is running` con scope `/pwa-outbox-practica/`, y Cache Storage `static-outbox-v2` con el App Shell completo.

> Si cambias código después de publicar, **sube la versión** de `CACHE_STATIC_NAME` en `sw.js` (`v3`, `v4`…). El App Shell es *cache first*, así que sin cambio de versión el navegador seguirá sirviendo los archivos viejos.

## Prueba de la pestaña cerrada (Chrome)

1. DevTools → Application → Background Services → **Background Sync** → Record.
2. Network → **Offline**. Enviar dos reportes (quedan `pendiente`).
3. Aparece *Registered sync* con la etiqueta `sync-reportes`.
4. Cerrar la pestaña de la PWA. Quitar Offline.
5. Abrir de nuevo la URL: los reportes aparecen como `sincronizado` (los envió `sincronizarPendientesSW()` desde `sw.js`).

---

## Guía para la defensa oral

**¿Por qué IndexedDB y no localStorage?** `localStorage` es síncrono, solo guarda strings y **no existe en el Service Worker**. IndexedDB es asíncrona, guarda objetos y es compartida entre `app.js` y `sw.js`.

**`req.onsuccess` vs `tx.oncomplete`** — `req.onsuccess` solo indica que la operación se aceptó y nos da el ID; el dato está garantizado en disco hasta `tx.oncomplete`. Si la transacción se aborta después, habríamos resuelto con un ID que no existe.

**Agregar un store sin subir `DB_VERSION`** — `onupgradeneeded` no se vuelve a disparar porque la versión no cambió, así que el store `logs_errores` nunca se crea; al usarlo, `db.transaction(['logs_errores'])` lanza `NotFoundError`. Hay que subir a `DB_VERSION = 2`.

**Quitar el `return` antes de `new Promise`** — el `.then()` devolvería `undefined` de inmediato; quien llama recibiría `undefined` en lugar del ID y continuaría antes de que termine la escritura, y los errores de esa promesa no llegarían a su `.catch()`.

**Cargar `db-helper.js` en el SW** — `importScripts('./db-helper.js')`.

**`get` + `put` en la misma transacción `readwrite`** — garantiza atomicidad: nadie modifica el registro entre la lectura y la escritura. Con `'readonly'` el `store.put()` lanza `ReadOnlyError`.

**¿Por qué `Promise.all()`?** — `pendientes.map(...)` convierte el arreglo de objetos en un arreglo de promesas (fetch + actualizar estado); `Promise.all` las ejecuta en paralelo y espera a que **todas** terminen (o falla en cuanto una falla) antes de repintar/notificar.

**¿Qué promesa rescata los registros al abrir sin red?** — `renderizarColaOutbox()` al final de `app.js`, que llama a `obtenerTodosLosRegistros()`. IndexedDB persiste aunque se cierre la pestaña; el App Shell sale de Cache Storage.

**`register('/sw.js')` en GitHub Pages** — el navegador pediría `https://<usuario>.github.io/sw.js` (raíz del dominio) → 404, el SW no se instala y no hay modo offline ni Background Sync. Además el scope máximo sería incorrecto.

**Race condition (`!('SyncManager' in window)`)** — en Chrome el SW ya sincroniza con el evento `sync`. Si `app.js` también sincronizara con `online`, ambos leerían los mismos pendientes al mismo tiempo y enviarían **POST duplicados**. Por eso el fallback solo corre si no hay `SyncManager` (o si el registro de la sync falló).

**¿Por qué no llamar `renderizarColaOutbox()` desde `sw.js`?** — el SW corre en otro hilo sin `window` ni `document`. El puente es: `cliente.postMessage({ tipo: 'OUTBOX_SINCRONIZADO' })` en `notificarClientesActualizacion()` (sw.js) ↔ `navigator.serviceWorker.addEventListener('message', ...)` al inicio de `app.js`.

**`throw error` dentro del `sync`** — la promesa de `event.waitUntil()` queda rechazada, el navegador marca la sync como fallida y **programa un reintento** automático. Con solo `console.error()` la promesa se resolvería y la tarea se daría por completada, perdiendo el reintento.
