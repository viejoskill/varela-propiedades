
---

## Incidente 2026-07-31: sitio no cargaba propiedades

**Sintoma:** "Cargando propiedades..." colgado indefinidamente. Console mostraba:
`Uncaught SyntaxError: Unexpected identifier 'supabase'` y `ReferenceError: supabase is not defined`.

**Causa raiz (dos bugs independientes en index.html):**

1. **Linea 3:** comentario HTML sin abrir (`<!--` faltante) con texto suelto que mencionaba
   `<script>` — el navegador lo interpreto como HTML/script real, rompiendo el parseo del
   `<head>` completo. Fix: se elimino el comentario huerfano (lineas 3-5).

2. **Linea 57:** `<script src=".../supabase-js@2" defer>` — el `defer` hacia que la libreria
   cargara *despues* del script inline (linea ~807) que ya la necesitaba para
   `supabase.createClient()`. Fix: se removio `defer`.

**Commits:** `7621be3` (fix comentario), `7ec0a11` (fix defer).

**Leccion:** nunca dejar comentarios HTML de trabajo sin cerrar. Si se agrega `defer`/`async`
a un script de libreria (CDN), verificar que TODO script que dependa de esa libreria tambien
sea `defer`, o sacarle el defer a ambos.
