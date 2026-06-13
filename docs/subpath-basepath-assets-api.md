# Servir Console Air bajo un subpath (`/akash-console`): assets y llamadas API

> Fecha: 2026-06-13 · Ámbito: `apps/deploy-web` + `docs/deploy/Dockerfile.subpath` + nginx (reverse proxy)

Resumen de los cambios que permiten servir Console Air bajo un subpath (p. ej.
`https://host/akash-console`) **sin delegar en nginx la reescritura de assets ni de llamadas
API hacia la raíz**. El objetivo: que todo lo que el cliente pide se consuma ya con el prefijo
del `basePath`, dejando en nginx solo el reenvío del subpath al backend.

## Contexto del problema

Next.js antepone el `basePath` **automáticamente** a `next/link`, `next/image` y los chunks
`/_next/*`. **No** lo hace para:

1. **Etiquetas manuales del `<head>`** (`<link href="/favicon.ico">`, manifest, etc.) → resolvían
   contra la raíz del origen.
2. **Llamadas del cliente a rutas absolutas desde la raíz** (`/api/proxy/*`,
   `/api/provider-proxy/*`, `/api/node-status`, `/api/blockchain-config`, `/sdl-schema.yaml`) →
   igual, resolvían contra la raíz.

Mientras el código no conociera el `basePath`, nginx tenía que **puentear** todas esas rutas de
la raíz hacia `/akash-console/...`, lo que provocó 404 (favicons) y 502 (un conflicto de
precedencia de `location`, ver §4).

## 1. Fuente única del subpath: `NEXT_PUBLIC_BASE_PATH`

Se introdujo una sola variable de entorno como fuente de verdad. De ella se derivan:
`basePath`, `images.unoptimized` y el prefijo de assets/llamadas en el código.

- **`apps/deploy-web/src/config/env-config.schema.ts`** — nueva var `NEXT_PUBLIC_BASE_PATH` con
  normalizador `subpath()`: fuerza slash inicial, quita el trailing slash; vacío = raíz.
- **`apps/deploy-web/src/config/browser-env.config.ts`** — pasa la var al validador.
- **`apps/deploy-web/next.config.js`** — lee la env (normaliza igual), y de forma condicional:
  - `basePath` (solo si no está vacía),
  - `images.unoptimized: true` (bajo subpath, el optimizador `/_next/image` no resuelve el `url`
    con prefijo y fallaría con las imágenes locales de `public/`),
  - re-exporta el valor normalizado vía `env: { NEXT_PUBLIC_BASE_PATH }` para que cliente y SSR
    vean exactamente el mismo valor que usa `basePath`.

> Esto **reemplaza** los dos `sed` que el `Dockerfile.subpath` inyectaba en `next.config.js`.

### Helper de prefijo

- **`apps/deploy-web/src/utils/basePath.ts`** *(nuevo)*:
  - `basePath` — el subpath configurado (o `""`).
  - `withBasePath(assetPath)` — antepone el `basePath` a una ruta absoluta. **Es identidad cuando
    `basePath` está vacío**, por lo que ningún cambio afecta al despliegue en la raíz.

## 2. Assets estáticos del `<head>` (favicon, manifest, …)

Prefijados con `withBasePath(...)`:

- **`apps/deploy-web/src/pages/_document.tsx`** — `favicon.ico`, `manifest.json`,
  `safari-pinned-tab.svg`, `apple-touch-icon.png`, `favicon-32x32.png`, `favicon-16x16.png`.
- **`apps/deploy-web/src/components/layout/PageHead.tsx`** — `favicon.ico`.
- **`apps/deploy-web/public/manifest.json`** — íconos (`android-chrome-*.png`) y `start_url`
  pasados a rutas **relativas**, para que el navegador los resuelva relativos a la URL del
  manifest (que ya lleva el `basePath`).

`<Image src="/images/...">` (componentes `next/image`) **no** se tocan: Next ya les aplica el
`basePath` (y con `unoptimized` sirve el estático bajo el prefijo).

## 3. Llamadas a la API (capa BFF, mismo origen)

Hallazgo clave que evita tocar el backend: **el request que recibe el upstream Next es idéntico**
ya sea que el browser pegue a `/api/proxy/...` (puenteado) o a `/akash-console/api/proxy/...`
(capturado por el catch-all). En ambos casos nginx reenvía a `:8080/akash-console/api/proxy/...`
y Next quita el `basePath` antes del handler. Por eso **los handlers de API no se modifican**;
solo se prefija la construcción de URLs en el cliente.

| Archivo | Qué prefija | Cubre |
|---|---|---|
| `src/store/networkStore.ts` | `apiBaseUrl: "/api"` | `nodesUrl` → `/api/blockchain-config` |
| `src/utils/apiUtils.ts` | `baseApiUrl` | Console API `/v1/*` (`/api/proxy/{net}`) |
| `src/services/app-di-container/browser-di-container.ts` | `consoleApiHttpClient` baseURL + `BASE_API_MAINNET_URL` | Console API (axios) |
| `src/services/app-di-container/app-di-container.ts` | templates + provider-proxy (rama `browser`) | `/api/proxy/templates`, `/api/provider-proxy/{net}` |
| `src/context/SettingsProvider/loadNodeStatus.ts` | `/api/node-status` | health check del nodo |
| `src/context/SettingsProvider/SettingsProviderContext.tsx` | `toAbsoluteEndpoint()` | chain REST/RPC + nodos de `blockchain-config` |
| `src/components/shared/Editor/Editor.tsx` | `/sdl-schema.yaml` | esquema del editor Monaco |

`toAbsoluteEndpoint()` es el chokepoint: por ahí pasan tanto los nodos que devuelve
`blockchain-config` como los fallbacks, así que un solo cambio cubre los endpoints de chain.

### Lo que **no** se toca (a propósito)

- **Handlers de API** (`pages/api/proxy/[network]/[...path].ts`, `chainProxy`,
  `blockchain-config.ts`): reciben el mismo request que hoy.
- **WebSocket del provider-proxy**: va directo al upstream (no por estas rutas).
- **Nodos custom / URLs absolutas persistidas**: `toAbsoluteEndpoint` las pasa intactas
  (`^https?://`).
- **`services/api-url/api-url.service.ts`**: devuelve URLs upstream absolutas, no proxy.

## 4. nginx (reverse proxy)

El backend de Console Air corre en `:8080` compilado con `basePath=/akash-console`. El server de
nginx (`<local-host>`) lo expone bajo el subpath.

### Config final: un solo bloque `^~` (igual en local y GCP)

Con los assets y las llamadas API ya prefijados en el código (§2 y §3), la config de nginx se
reduce a **un único `location` con prefijo prioritario `^~`** que reenvía todo el subpath al
backend, **sin reescribir la ruta** (`proxy_pass` sin URI preserva el path completo, incluido
`/akash-console`):

```nginx
location ^~ /akash-console {
    proxy_pass http://127.0.0.1:8080;   # local  (en GCP: http://akash-console-air-service:8080)
    proxy_http_version 1.1;
    proxy_read_timeout 10m;
    proxy_set_header Host               $host;
    proxy_set_header X-Real-IP          $remote_addr;
    proxy_set_header X-Forwarded-For    $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto  $scheme;        # TLS lo termina nginx
    proxy_set_header X-Forwarded-Host   $host;
    proxy_set_header Upgrade            $http_upgrade;
    proxy_set_header Connection         $connection_upgrade;
    proxy_set_header Origin             '';
}
```

Este bloque cubre páginas, `/_next/*`, assets de `public/` y **todas** las rutas API
(`/akash-console/api/...`, `/akash-console/sdl-schema.yaml`), porque el cliente ya construye esas
URLs con el prefijo. **No hacen falta** ni un bloque aparte para `_next` ni los puentes de
assets/API hacia la raíz.

> Precedencia de `location` en nginx: `=` (exacto) → **`^~` (prefijo prioritario)** → `~`/`~*`
> (regex, en orden de aparición) → prefijo normal. Un `^~` que matchea **corta la evaluación y no
> prueba ninguna regex**.

### Por qué `^~` y no regex `~` (historia del 502)

En una iteración intermedia el bloque local se escribió como regex `~ ^/akash-console(.*)` (para
reescribir con `$1`). Eso le hizo **competir por orden con las demás regex** del server compartido,
en particular con una regex **sin anclar** de otra app:

```nginx
# front.app.workspace.inc — SPA Elm → :3000
location ~ /main.+\.js { proxy_pass http://127.0.0.1:3000; }
```

Esa regex matcheaba `…/chunks/main-*.js` y, al cargarse antes, le ganaba al bloque akash → los
chunks iban a `:3000` (apagado) → **502**. Se parcheó temporalmente con `location ^~
/akash-console/_next/`, pero la solución definitiva fue **volver el bloque entero a `^~`** (sin
`$1`): así vence a cualquier regex y el parche de `_next` deja de ser necesario.

En GCP (`docs/deploy/nginx-akash-console.conf`) nunca hubo 502 porque ese bloque **siempre** fue
`^~` y, además, ese server probablemente no tiene la regex de Elm.

### Dependencia con la imagen desplegada

Quitar los puentes de la raíz (`^~ /api/proxy/`, `^~ /api/provider-proxy/`, `= /api/node-status`,
`= /api/blockchain-config`, `= /sdl-schema.yaml` y los de favicons/manifest) es seguro **solo si
el contenedor `:8080` corre la imagen con los cambios de código de §2–§3**. Con una imagen
anterior, el JS de cliente aún pediría `/api/...` y `/favicon-*.png` desde la raíz y, sin puentes,
darían 404. Orden recomendado: **primero rebuild + deploy, luego limpiar la config de nginx**.

## 5. Build / despliegue

- **`docs/deploy/Dockerfile.subpath`** — los dos `sed` se reemplazan por
  `ENV NEXT_PUBLIC_BASE_PATH=${BASE_PATH}` (sigue recibiendo `--build-arg BASE_PATH=/akash-console`).
- El `Dockerfile` oficial (raíz, sin la env) compila para la raíz sin cambios.

```bash
docker build -f docs/deploy/Dockerfile.subpath \
  --build-arg BASE_PATH=/akash-console \
  -t <region>-docker.pkg.dev/<proj>/<repo>/akash-console-air:<ver> .
```

## 6. Verificación realizada

- **Assets:** con `NEXT_PUBLIC_BASE_PATH=/akash-console`, el `<head>` (SSR) emite los 6 links bajo
  `/akash-console/...` (comprobado en runtime con `next dev`).
- **API:** `type-check` sin errores nuevos y **47 unit tests** OK (`loadNodeStatus`, `chainProxy`,
  `templatesProxy`, `Editor`, `SDLEditor`). Con `basePath` vacío, `withBasePath` es identidad → sin
  regresión en el despliegue en la raíz.
- **nginx end-to-end** (config final con el único `^~ /akash-console`, `nginx -t` OK + reload):
  todas las rutas responden **200** vía HTTPS bajo el subpath —

  | Ruta | Resultado |
  |---|---|
  | `/akash-console` (página) | 200 `text/html` |
  | `/akash-console/_next/static/chunks/main-*.js` | 200 `application/javascript` |
  | `/akash-console/favicon-16x16.png` | 200 `image/png` |
  | `/akash-console/manifest.json` | 200 `application/json` |
  | `/akash-console/api/blockchain-config?network=mainnet` | 200 `application/json` |
  | `/akash-console/sdl-schema.yaml` | 200 `text/yaml` |

  El chunk `_next` resuelve sin bloque aparte: el `^~ /akash-console` vence a la regex `~ /main.+\.js` de Elm.

## 7. Nota de migración (menor)

Un usuario con nodos ya persistidos en `localStorage` sin `basePath` seguiría apuntando a la raíz
hasta que la lista de nodos se refresque. El código re-deriva desde `nodesUrl` en cada carga, así
que se **auto-corrige**; no requiere acción manual.

## Índice de archivos modificados

**Fuente (`apps/deploy-web`):**
- `src/config/env-config.schema.ts`, `src/config/browser-env.config.ts`
- `src/utils/basePath.ts` *(nuevo)*
- `next.config.js`
- `src/pages/_document.tsx`, `src/components/layout/PageHead.tsx`, `public/manifest.json`
- `src/store/networkStore.ts`, `src/utils/apiUtils.ts`
- `src/services/app-di-container/browser-di-container.ts`,
  `src/services/app-di-container/app-di-container.ts`
- `src/context/SettingsProvider/loadNodeStatus.ts`,
  `src/context/SettingsProvider/SettingsProviderContext.tsx`
- `src/components/shared/Editor/Editor.tsx`

**Deploy:**
- `docs/deploy/Dockerfile.subpath`
- nginx: `docs/deploy/nginx-akash-console.conf` (referencia) / la config viva del server.
