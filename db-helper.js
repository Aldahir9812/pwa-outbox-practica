/* =========================================================================
 * db-helper.js — Mini-wrapper promisificado de IndexedDB (Vanilla JS)
 * -------------------------------------------------------------------------
 * Se carga en dos contextos:
 *   - index.html  -> <script src="./db-helper.js"></script>
 *   - sw.js       -> importScripts('./db-helper.js')
 * Por eso NO usa window ni document: solo el global `indexedDB`,
 * que existe tanto en la página como en el Service Worker.
 *
 * Regla del curso: solo Promesas explícitas (new Promise / .then / .catch).
 * ========================================================================= */

const DB_NAME = 'pwa-outbox-db';
const DB_VERSION = 1;
const STORE_NAME = 'transacciones_pendientes';

/* -------------------------------------------------------------------------
 * Pieza 1: Apertura y migración de esquema
 * onupgradeneeded solo se dispara si la BD no existe o si DB_VERSION sube.
 * Es el ÚNICO lugar donde se pueden crear/borrar Object Stores.
 * ------------------------------------------------------------------------- */
function abrirDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = (event) => {
      const db = event.target.result;
      if (!db.objectStoreNames.contains(STORE_NAME)) {
        // keyPath 'id' + autoIncrement -> IDs 1, 2, 3...
        db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
      }
    };

    request.onsuccess = (event) => resolve(event.target.result);
    request.onerror = (event) => reject(event.target.error);
  });
}

/* -------------------------------------------------------------------------
 * Pieza 2: CREATE — guardarRegistro(datos)
 * req.onsuccess nos da el ID generado, pero el dato solo está garantizado
 * en disco cuando la transacción dispara oncomplete. Por eso resolvemos ahí.
 * ------------------------------------------------------------------------- */
function guardarRegistro(datos) {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const req = store.add(datos);
      let idGenerado;

      req.onsuccess = (event) => {
        idGenerado = event.target.result;
      };

      tx.oncomplete = () => resolve(idGenerado);
      tx.onerror = (event) => reject(event.target.error);
    });
  });
}

/* -------------------------------------------------------------------------
 * Pieza 3: READ — obtenerTodosLosRegistros()
 * Transacción 'readonly' + getAll() -> arreglo con todos los objetos.
 * ------------------------------------------------------------------------- */
function obtenerTodosLosRegistros() {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readonly');
      const store = tx.objectStore(STORE_NAME);
      const req = store.getAll();

      req.onsuccess = (event) => resolve(event.target.result);
      req.onerror = (event) => reject(event.target.error);
    });
  });
}

/* -------------------------------------------------------------------------
 * Pieza 4: UPDATE — actualizarEstadoRegistro(id, nuevoEstado)
 * Dentro de UNA misma transacción 'readwrite': primero get(id) y, en su
 * onsuccess, put(registro). Con 'readonly' el put lanzaría ReadOnlyError.
 * ------------------------------------------------------------------------- */
function actualizarEstadoRegistro(id, nuevoEstado) {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      const reqGet = store.get(id);

      reqGet.onsuccess = (event) => {
        const registro = event.target.result;
        if (!registro) {
          reject(new Error(`No se encontró el registro con ID: ${id}`));
          return;
        }

        registro.estado = nuevoEstado;
        registro.fechaSincronizacion = Date.now();
        store.put(registro);
      };

      tx.oncomplete = () => resolve(true);
      tx.onerror = (event) => reject(event.target.error);
    });
  });
}

/* -------------------------------------------------------------------------
 * Pieza 5: DELETE — eliminarRegistro(id)
 * Se usa para purgar los registros ya sincronizados.
 * ------------------------------------------------------------------------- */
function eliminarRegistro(id) {
  return abrirDB().then((db) => {
    return new Promise((resolve, reject) => {
      const tx = db.transaction([STORE_NAME], 'readwrite');
      const store = tx.objectStore(STORE_NAME);

      store.delete(id);

      tx.oncomplete = () => resolve(true);
      tx.onerror = (event) => reject(event.target.error);
    });
  });
}
