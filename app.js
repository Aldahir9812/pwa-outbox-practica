/* =========================================================================
 * app.js — Hilo principal (UI)
 * -------------------------------------------------------------------------
 * - Envío resiliente (CREATE) con fallback a IndexedDB  -> Patrón Outbox
 * - Render de la bandeja (READ)
 * - Purga de sincronizados (DELETE)
 * - Registro de Background Sync ('sync-reportes') al fallar el POST
 * - Fallback con evento 'online' SOLO si no existe SyncManager (Safari/iOS)
 * - Escucha de postMessage del Service Worker para repintar la tabla
 *
 * Regla del curso: solo Promesas explícitas (new Promise / .then / .catch).
 * Depende de db-helper.js (cargado antes en index.html).
 * ========================================================================= */

const ENDPOINT = 'https://jsonplaceholder.typicode.com/posts';
const SYNC_TAG = 'sync-reportes';

const formIncidencia = document.getElementById('form-incidencia');
const inputTitulo = document.getElementById('titulo');
const inputDescripcion = document.getElementById('descripcion');
const listaOutbox = document.getElementById('lista-outbox');
const btnPurgar = document.getElementById('btn-purgar');
const badgeRed = document.getElementById('badge-red');
const textoResumen = document.getElementById('resumen');
const textoModoSync = document.getElementById('modo-sync');

const soportaBackgroundSync = ('serviceWorker' in navigator) && ('SyncManager' in window);

// Si el navegador expone SyncManager pero register() falla (ej. Background Sync
// deshabilitado por el usuario o por la plataforma), activamos el respaldo.
let backgroundSyncFallo = false;

/* -------------------------------------------------------------------------
 * Fragmento G: Puente SW -> UI (recepción de postMessage)
 * El SW no tiene acceso al DOM, así que nos avisa con postMessage y aquí
 * repintamos la bandeja.
 * ------------------------------------------------------------------------- */
if ('serviceWorker' in navigator) {
  navigator.serviceWorker.addEventListener('message', (event) => {
    if (event.data && event.data.tipo === 'OUTBOX_SINCRONIZADO') {
      console.log('[UI] Confirmación recibida del Service Worker. Actualizando bandeja...');
      renderizarColaOutbox();
    }
  });

  // Ruta RELATIVA: en GitHub Pages '/sw.js' apuntaría a la raíz del dominio (404)
  navigator.serviceWorker.register('./sw.js')
    .then((registro) => {
      console.log('[SW] Registrado con scope:', registro.scope);
    })
    .catch((error) => {
      console.error('[SW] Error al registrar el Service Worker:', error);
    });
}

/* -------------------------------------------------------------------------
 * Indicador visual de conectividad
 * ------------------------------------------------------------------------- */
function actualizarIndicadorRed() {
  if (navigator.onLine) {
    badgeRed.textContent = 'En Línea';
    badgeRed.className = 'badge online';
  } else {
    badgeRed.textContent = 'Sin Conexión';
    badgeRed.className = 'badge offline';
  }
}

function formatearHora(timestamp) {
  if (!timestamp) return '—';
  return new Date(timestamp).toLocaleString('es-MX', {
    day: '2-digit',
    month: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  });
}

/* -------------------------------------------------------------------------
 * READ: renderizarColaOutbox()
 * Lee IndexedDB, limpia el <ul> y crea un <li> por registro.
 * Se usa textContent (no innerHTML) para no inyectar HTML del usuario.
 * ------------------------------------------------------------------------- */
function renderizarColaOutbox() {
  return obtenerTodosLosRegistros()
    .then((registros) => {
      listaOutbox.innerHTML = '';

      // Más recientes primero
      registros.sort((a, b) => b.fechaCreacion - a.fechaCreacion);

      const totalPendientes = registros.filter((r) => r.estado === 'pendiente').length;
      const totalSincronizados = registros.length - totalPendientes;
      textoResumen.textContent =
        `${registros.length} registro(s) · ${totalPendientes} pendiente(s) · ${totalSincronizados} sincronizado(s)`;

      if (registros.length === 0) {
        const vacio = document.createElement('li');
        vacio.className = 'vacio';
        vacio.textContent = 'La bandeja de salida está vacía.';
        listaOutbox.appendChild(vacio);
        return;
      }

      registros.forEach((registro) => {
        const li = document.createElement('li');

        const info = document.createElement('div');
        info.className = 'item-info';

        const titulo = document.createElement('span');
        titulo.className = 'item-titulo';
        titulo.textContent = `#${registro.id} · ${registro.titulo}`;

        const meta = document.createElement('span');
        meta.className = 'item-meta';
        let textoMeta = `Creado: ${formatearHora(registro.fechaCreacion)}`;
        if (registro.fechaSincronizacion) {
          textoMeta += ` · Sincronizado: ${formatearHora(registro.fechaSincronizacion)}`;
        }
        meta.textContent = textoMeta;

        info.appendChild(titulo);
        info.appendChild(meta);

        const estado = document.createElement('span');
        estado.className = `estado ${registro.estado}`;
        estado.textContent = registro.estado;

        li.appendChild(info);
        li.appendChild(estado);
        listaOutbox.appendChild(li);
      });
    })
    .catch((error) => {
      console.error('[UI] Error al leer IndexedDB:', error);
    });
}

/* -------------------------------------------------------------------------
 * Registro de la etiqueta de Background Sync en el SW
 * ------------------------------------------------------------------------- */
function registrarBackgroundSync() {
  if (!soportaBackgroundSync) {
    return Promise.resolve(false);
  }
  return navigator.serviceWorker.ready
    .then((registro) => {
      console.log(`[Outbox] Registrando etiqueta ${SYNC_TAG} en el SW...`);
      return registro.sync.register(SYNC_TAG);
    })
    .then(() => true)
    .catch((error) => {
      console.warn('[Outbox] No se pudo registrar Background Sync. Se usará el respaldo por evento online:', error);
      backgroundSyncFallo = true;
      actualizarTextoModoSync();
      return false;
    });
}

/* -------------------------------------------------------------------------
 * CREATE: procesarEnvioReporte(datosFormulario)
 * Intenta el POST. Si hay red -> guarda como 'sincronizado'.
 * Si falla (.catch) -> guarda como 'pendiente' y registra el sync en el SW.
 * ------------------------------------------------------------------------- */
function procesarEnvioReporte(datosFormulario) {
  return fetch(ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: datosFormulario.titulo, body: datosFormulario.descripcion })
  })
    .then((respuesta) => {
      if (!respuesta.ok) throw new Error('Error HTTP del servidor');
      return respuesta.json();
    })
    .then(() => {
      // Envío exitoso en vivo: bitácora local como 'sincronizado'
      return guardarRegistro({
        ...datosFormulario,
        estado: 'sincronizado',
        fechaCreacion: Date.now(),
        fechaSincronizacion: Date.now()
      });
    })
    .catch(() => {
      console.warn('[Outbox] Sin conexión. Encolando en IndexedDB...');

      // Fragmento E: guardar como pendiente y delegar el reenvío al SW
      return guardarRegistro({
        ...datosFormulario,
        estado: 'pendiente',
        fechaCreacion: Date.now()
      })
        .then(() => registrarBackgroundSync());
    })
    .then(() => {
      // Repintar la lista en ambos escenarios
      return renderizarColaOutbox();
    });
}

/* -------------------------------------------------------------------------
 * UPDATE (fallback): sincronizarPendientesFallback()
 * Se usa SOLO en navegadores sin SyncManager (Safari/iOS, Firefox).
 * Convierte el arreglo de pendientes en un arreglo de promesas HTTP y
 * espera a todas con Promise.all().
 * ------------------------------------------------------------------------- */
function sincronizarPendientesFallback() {
  console.log('[Outbox] Conexión detectada. Buscando registros pendientes...');

  return obtenerTodosLosRegistros()
    .then((registros) => {
      const pendientes = registros.filter((item) => item.estado === 'pendiente');

      if (pendientes.length === 0) {
        console.log('[Outbox] No hay transacciones pendientes por sincronizar.');
        return;
      }

      const promesasDeEnvio = pendientes.map((item) => {
        return fetch(ENDPOINT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ title: item.titulo, body: item.descripcion })
        })
          .then((res) => {
            if (!res.ok) throw new Error('Falla al reintentar envío');
            return actualizarEstadoRegistro(item.id, 'sincronizado');
          });
      });

      return Promise.all(promesasDeEnvio);
    })
    .then(() => {
      return renderizarColaOutbox();
    })
    .catch((error) => {
      console.error('[Outbox] Error durante la sincronización masiva:', error);
    });
}

/* -------------------------------------------------------------------------
 * Fragmento F: eventos de red con degradación elegante
 * En Chrome (con SyncManager) quien sincroniza es sw.js; si app.js también
 * lo hiciera habría POST duplicados (race condition).
 * ------------------------------------------------------------------------- */
window.addEventListener('online', () => {
  actualizarIndicadorRed();

  if (!('SyncManager' in window) || backgroundSyncFallo) {
    console.log('[Outbox] Navegador sin SyncManager. Ejecutando fallback por evento online...');
    sincronizarPendientesFallback();
  }
});

window.addEventListener('offline', actualizarIndicadorRed);

/* -------------------------------------------------------------------------
 * Conexión del formulario (submit)
 * ------------------------------------------------------------------------- */
formIncidencia.addEventListener('submit', (e) => {
  e.preventDefault();

  const datosFormulario = {
    titulo: inputTitulo.value.trim(),
    descripcion: inputDescripcion.value.trim()
  };

  if (!datosFormulario.titulo || !datosFormulario.descripcion) return;

  procesarEnvioReporte(datosFormulario)
    .then(() => {
      formIncidencia.reset();
      inputTitulo.focus();
    })
    .catch((error) => {
      console.error('[UI] No se pudo procesar el reporte:', error);
    });
});

/* -------------------------------------------------------------------------
 * DELETE: purga de registros sincronizados
 * ------------------------------------------------------------------------- */
btnPurgar.addEventListener('click', () => {
  obtenerTodosLosRegistros()
    .then((registros) => {
      const sincronizados = registros.filter((item) => item.estado === 'sincronizado');
      return Promise.all(sincronizados.map((item) => eliminarRegistro(item.id)));
    })
    .then((resultados) => {
      console.log(`[Outbox] Purgados ${resultados.length} registro(s) sincronizado(s).`);
      return renderizarColaOutbox();
    })
    .catch((error) => {
      console.error('[Outbox] Error al purgar registros:', error);
    });
});

/* -------------------------------------------------------------------------
 * Arranque: pintar la bandeja desde IndexedDB (sobrevive a cerrar la
 * pestaña) y, si hay red y quedaron pendientes, volver a pedir la sync.
 * ------------------------------------------------------------------------- */
function actualizarTextoModoSync() {
  textoModoSync.textContent = (soportaBackgroundSync && !backgroundSyncFallo)
    ? 'Modo de sincronización: Background Sync API (Service Worker).'
    : 'Modo de sincronización: respaldo por evento "online" (sin Background Sync).';
}

actualizarIndicadorRed();
actualizarTextoModoSync();

renderizarColaOutbox()
  .then(() => obtenerTodosLosRegistros())
  .then((registros) => {
    const hayPendientes = registros.some((item) => item.estado === 'pendiente');
    if (!hayPendientes || !navigator.onLine) return;

    // Hay pendientes y hay red: pedimos la sync al SW; si no se puede,
    // sincronizamos desde la página.
    return registrarBackgroundSync()
      .then((registrado) => {
        if (!registrado) return sincronizarPendientesFallback();
      });
  })
  .catch((error) => {
    console.error('[UI] Error en el arranque:', error);
  });
