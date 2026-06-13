# Instructivo — Despliegue de Console Air en Docker / GCP detrás de nginx bajo `/akash-console`

> Objetivo: servir Console Air en `https://<host>/akash-console`, ejecutándose como
> contenedor Docker en GCP (Artifact Registry + GKE) detrás de un reverse proxy nginx.
>
> **No requiere modificar el código fuente del repositorio.** El único ajuste necesario para el
> subpath (`basePath`) se inyecta **en tiempo de build** mediante un Dockerfile alternativo incluido
> en `docs/deploy/`. Todos los archivos de apoyo viven bajo `docs/`.

---

## 0. TL;DR

```bash
# 1) Variables
export REGION=<region>
export PROJECT=<gcp-project>
export VERSION=1.0.1-canary
export IMAGE=${REGION}-docker.pkg.dev/${PROJECT}/<repo>/akash-console-air:${VERSION}

# 2) Build con subpath (basePath=/akash-console) — desde la raíz del repo
docker build -f docs/deploy/Dockerfile.subpath \
  --build-arg BASE_PATH=/akash-console \
  -t ${IMAGE} .

# 3) Push a Artifact Registry (GAR)
gcloud auth configure-docker ${REGION}-docker.pkg.dev
docker push ${IMAGE}

# 4) Desplegar en GKE
gcloud container clusters get-credentials <gke-cluster> --zone ${REGION}
# edita docs/deploy/k8s-akash-console.example.yaml con tu IMAGE y aplica:
kubectl apply -f docs/deploy/k8s-akash-console.example.yaml

# 5) nginx: usa docs/deploy/nginx-akash-console.conf (ver §6)
```

---

## 1. El reto del subpath (leer antes de construir)

Console Air es una app **Next.js** cuyo `next.config.js` **no define `basePath`** y **no lo expone por
variable de entorno**. Además, parte del JavaScript de cliente llama a rutas **absolutas desde la raíz**
(`/api/proxy/*`, `/api/provider-proxy/*`, `/sdl-schema.yaml`, `/images/*`). Por eso **no basta** con
"colgar" la app de un nginx en `/akash-console`: hay que decidir una estrategia.

Hay dos formas de lograrlo sin tocar el repositorio:

| | **Opción A (recomendada)** | **Opción B** |
|---|---|---|
| Técnica | Compilar con `basePath=/akash-console` (inyectado en build) + nginx con *bridges* | nginx *prefix-strip* (host dedicado) |
| URL en el navegador | **Persistente** bajo `/akash-console/...` (deep links y refresh funcionan) | El prefijo se pierde al navegar (SPA usa rutas de raíz) |
| Cambios | Build alternativo (`Dockerfile.subpath`); **el repo no se modifica** | Cero cambios de build/código |
| Requiere host dedicado | No (con bridges acotados) | Sí (nginx reenvía toda la raíz a la app) |
| Aptitud producción | ✅ Recomendada | Aceptable si el host es exclusivo de esta app |

> Este instructivo desarrolla la **Opción A**. La **Opción B** se documenta como alternativa en §8.

### ¿Por qué `basePath` y además *bridges*?
Con `basePath=/akash-console`, Next sirve automáticamente bajo ese prefijo las **páginas**, los assets
**`/_next`**, `next/link`, `next/router` y las **rutas API**. Lo que `basePath` **no** reescribe son las
URLs absolutas escritas como string en el código de cliente (`/api/...`, `/sdl-schema.yaml`,
`/images/...`): el navegador las pide en la raíz del host. nginx las "puentea" hacia
`/akash-console/...` (ver §6). Es un conjunto pequeño y acotado de rutas.

---

## 2. Requisitos previos

- **Docker** con buildx (sintaxis `# syntax=docker/dockerfile:1.7`).
  - Memoria del builder: el build de Next+webpack necesita heap grande; el Dockerfile fija
    `NODE_OPTIONS=--max-old-space-size=6144`. Asegura **≥ 8 GB** disponibles para el daemon de Docker
    (en Docker Desktop, súbelo en *Settings → Resources*).
- **gcloud CLI** autenticado (`gcloud auth login`) con permisos sobre el proyecto.
- **kubectl** (incluido vía `gcloud components install kubectl`).
- Acceso a un **Artifact Registry** Docker (formato `${REGION}-docker.pkg.dev/${PROJECT}/<repo>`).
- Un **clúster GKE** (en los scripts existentes: `<gke-cluster>`, zona `us-east1`).
- **Egress a Internet** desde los pods (ver §7): la app llama en runtime a `console-api.akash.network`,
  `console.akash.network`, `stats.akash.network`, `akash-templates.pages.dev` y nodos REST/RPC de Akash.

---

## 3. Construcción de la imagen (con subpath)

Desde la **raíz del repositorio**:

```bash
export REGION=<region>
export PROJECT=<gcp-project>
export VERSION=1.0.1-canary
export IMAGE=${REGION}-docker.pkg.dev/${PROJECT}/<repo>/akash-console-air:${VERSION}

docker build -f docs/deploy/Dockerfile.subpath \
  --build-arg BASE_PATH=/akash-console \
  -t ${IMAGE} .
```

`docs/deploy/Dockerfile.subpath` es idéntico al `apps/deploy-web/Dockerfile` oficial salvo por una línea
`sed` que inserta `basePath: "/akash-console"` en `next.config.js` **dentro del contenedor de build**
(no toca el archivo del repo). El resultado es la misma imagen *standalone* (`node server.js`, puerto
**3001**, usuario no-root uid 1001), pero con todas las rutas bajo `/akash-console`.

**Prueba local rápida** (antes de subir):

```bash
docker run --rm -p 8080:3001 ${IMAGE}
# Abre http://localhost:8080/akash-console  → debe cargar la app
# http://localhost:8080/        → 404 esperado (no hay nada en la raíz con basePath)
```

> Variables `NEXT_PUBLIC_*`: no son necesarias para arrancar — la app trae *defaults* de producción que
> apuntan a la infraestructura pública de Akash. Configúralas solo si operas tu propia Console API / RPC
> (ver `apps/deploy-web/env/.env.sample`). Las `NEXT_PUBLIC_*` se **hornean en build**; si necesitas
> personalizarlas, pásalas como `--build-arg`/`ENV` en el build, no en runtime.

---

## 4. Publicación en Artifact Registry (GAR)

```bash
# Autenticación del daemon Docker contra GAR (una vez por host)
gcloud auth configure-docker ${REGION}-docker.pkg.dev

# (Alternativa por service account, como en deploy/publish-gar.sh)
# cat deploy/<sa-key>.json | docker login -u _json_key --password-stdin https://${REGION}-docker.pkg.dev

docker push ${IMAGE}
```

Verifica:

```bash
gcloud artifacts docker images list ${REGION}-docker.pkg.dev/${PROJECT}/<repo> --include-tags
```

---

## 5. Despliegue en GKE

```bash
gcloud container clusters get-credentials <gke-cluster> --zone ${REGION} --project ${PROJECT}
```

Edita `docs/deploy/k8s-akash-console.example.yaml` y reemplaza `<REGION>`, `<PROJECT>`, `<VERSION>`
(o usa `envsubst`/`sed`). Puntos clave del manifiesto:

- `containerPort: 3001` (puerto del contenedor).
- **`readinessProbe.httpGet.path: /akash-console`** — con `basePath`, el índice vive ahí (no en `/`).
- `livenessProbe` por `tcpSocket` al puerto (evita falsos negativos si `/` devuelve 404).
- `securityContext` no-root (uid 1001), sin escalado de privilegios, capabilities `drop: ["ALL"]`.
- `resources`: requests 100m CPU / 256Mi; limits 1 CPU / 1Gi (el SSR es liviano; el consumo alto es de
  build, no de runtime).

Aplica y verifica:

```bash
kubectl apply -f docs/deploy/k8s-akash-console.example.yaml
kubectl rollout status deploy/akash-console-air
kubectl get pods -l app=akash-console-air
# Prueba interna (sin pasar por nginx):
kubectl port-forward svc/akash-console-air-service 8080:8080
#   → http://localhost:8080/akash-console
```

> El `Service` queda `ClusterIP` (interno). La exposición pública la hace nginx (§6). Si prefieres
> `ingress-nginx` en lugar de un nginx externo, hay un bloque `Ingress` comentado al final del YAML.

---

## 6. nginx (reverse proxy) bajo `/akash-console`

> `<host>` es un **host de plataforma compartido** (su `server {}` incluye las configs de otras apps
> y servicios). El `akash-console.conf` se **incluye dentro**
> de ese `server {}`. Por eso la config de nginx no es un `server` nuevo, sino un conjunto de
> `location` que se agregan al server existente.

Usa `docs/deploy/nginx-akash-console.conf` como drop-in (cópialo a
`<nginx-includes-dir>/akash-console.conf`). Lógica:

```nginx
# 1) App + páginas + /_next + rutas API (todo bajo /akash-console gracias a basePath)
location ~ ^/akash-console(.*) {
    proxy_pass http://akash-console-air-service:8080/akash-console$1$is_args$args;
    # ... cabeceras ...
}

# 2) BRIDGES: el JS de cliente llama estas rutas en la RAÍZ (no conocen basePath).
#    Se puentean SOLO estos subpaths específicos hacia /akash-console/...
location ^~ /api/proxy/          { proxy_pass http://akash-console-air-service:8080/akash-console/api/proxy/; ... }
location ^~ /api/provider-proxy/ { proxy_pass http://akash-console-air-service:8080/akash-console/api/provider-proxy/; ... }
location = /api/node-status      { proxy_pass http://akash-console-air-service:8080/akash-console/api/node-status$is_args$args; ... }
location = /api/blockchain-config{ proxy_pass http://akash-console-air-service:8080/akash-console/api/blockchain-config$is_args$args; ... }
location = /sdl-schema.yaml      { proxy_pass http://akash-console-air-service:8080/akash-console/sdl-schema.yaml; ... }
```

> Las `/images/*` usan `next/image`, que **sí** aplica basePath → quedan bajo `/akash-console`. No
> necesitan puente. El **WebSocket** del provider-proxy va **directo** al upstream (no por este nginx).

Requisitos:
- `$connection_upgrade` definido a nivel `http {}` (normalmente ya existe en la plataforma):
  ```nginx
  map $http_upgrade $connection_upgrade { default upgrade; "" close; }
  ```
- Recargar tras validar: `nginx -t && nginx -s reload`.

> **Colisiones:** si el server compartido ya tiene un handler de `/api` que es un regex catch-all
> (p. ej. `~ ^/api/(.+)`), por precedencia de nginx los bridges `^~ /api/proxy/`,
> `^~ /api/provider-proxy/` y los `= /api/node-status`, `= /api/blockchain-config`,
> `= /sdl-schema.yaml` **ganan a ese regex** e interceptan primero. Haz grep de los `location` de los
> includes del server para confirmar que ningún otro prefijo choca. Como el `akash-console.conf` se
> incluye solo dentro de ese `server {}`, no afecta a otros hosts.
>
> **Único punto a confirmar (riesgo bajo):** que el backend del catch-all de `/api` no sirva endpoints
> reales llamados `/api/proxy`, `/api/provider-proxy`, `/api/node-status` o `/api/blockchain-config`.
> Si los usara → **subdominio dedicado** (§8).

---

## 7. Red y egress (GCP)

La app **necesita salida a Internet** en runtime para hablar con los upstreams de Akash. Si tus nodos
GKE **no** tienen IP pública (clúster privado), configura **Cloud NAT**:

```bash
gcloud compute routers create <nat-router> --network <VPC> --region ${REGION}
gcloud compute routers nats create <nat> \
  --router <nat-router> --region ${REGION} \
  --nat-all-subnet-ip-ranges --auto-allocate-nat-external-ips
```

Si hay `NetworkPolicy` restrictiva, permite el egress 443 hacia Internet (o al menos a los dominios
upstream). Comprobación rápida desde un pod:

```bash
kubectl exec -it deploy/akash-console-air -- \
  sh -c "wget -qO- https://console-api.akash.network/v1/network-version || echo FALLO_EGRESS"
```

---

## 8. Opción B (alternativa) — subdominio dedicado, sin build especial

En un **host de plataforma compartido** como `<host>`, el *prefix-strip* (app interna en
`/`, nginx mapeando `/akash-console/` → `/`) **no es viable**: la app referencia `/_next/*`, `/api/*`,
etc. en la **raíz**, y reenviar `location / { ... }` completo a la app secuestraría todo el host (rompe
las demás apps del host). Por eso, si **no** quieres compilar con `basePath`, la alternativa limpia es un
**subdominio dedicado** donde la app sea dueña de toda la raíz:

```nginx
server {
    listen 443 ssl;
    server_name akash-console.<domain>;   # subdominio propio
    # ... TLS y cabeceras ...

    location / {
        proxy_pass http://akash-console-air-service:8080;   # imagen OFICIAL (sin basePath)
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-Proto $scheme;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection $connection_upgrade;
    }
}
```

- **Ventaja:** cero cambios de build/código (imagen oficial `apps/deploy-web/Dockerfile`), cero bridges,
  cero colisiones; el prefijo no aplica porque la app vive en `/` de su propio host.
- **Desventaja:** la URL es `https://akash-console.<domain>/`, **no** `…/akash-console`.
- En este modo, `readinessProbe` apunta a `/` (no a `/akash-console`) y NO se usa `Dockerfile.subpath`.

> Resumen de decisión: **¿el path `/akash-console` es obligatorio?** → Opción A (§3–§6, basePath +
> bridges, verificando colisiones). **¿Se acepta un subdominio?** → Opción B (más simple y robusta).

---

## 9. Verificación post-despliegue

```bash
# Página principal bajo el subpath
curl -kIs https://<host>/akash-console/ | head -n1     # → HTTP/2 200

# Assets _next servidos bajo el prefijo (Opción A)
curl -kIs https://<host>/akash-console/_next/static/ | head -n1

# Bridge de la capa BFF
curl -kIs "https://<host>/api/proxy/mainnet/v1/market-data" | head -n1  # → 200
```

En el navegador, abre `https://<host>/akash-console`, abre DevTools → **Network** y
confirma que **no haya 404** de recursos en la raíz. Si aparece alguno, añade un *bridge* equivalente en
nginx (ver comentario al final de `nginx-akash-console.conf`).

Wallets: conecta Keplr (extensión). Para habilitar wallets **móviles** (WalletConnect), define
`NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` (project ID gratuito en cloud.reown.com) — debe pasarse en
**build** porque es `NEXT_PUBLIC_*`.

---

## 9.1 Troubleshooting

### `⨯ The requested resource isn't a valid image for /images/<x>.png received null`

Síntoma (en logs del contenedor con build `basePath`):

```
⨯ The requested resource isn't a valid image for /images/ubuntu.png received null
⨯ The requested resource isn't a valid image for /images/docker-logo.png received null
...
```

**Causa:** el optimizador de `next/image` (`/akash-console/_next/image`) recibe el parámetro `url` **sin
el prefijo** `basePath` (`/images/ubuntu.png`) y lo resuelve **internamente** (server-side). Como con
`basePath` los archivos de `public/` se sirven bajo `/akash-console/images/...`, la ruta sin prefijo da
404 → `null`. Los archivos **sí existen** (iconos de plantillas/SO en `TemplateList`); es un fallo de
resolución, **no** de archivo faltante. Como la resolución es interna al contenedor, **nginx no lo
arregla** mientras el optimizador esté activo. Impacto: **cosmético** (la app funciona; solo no se ven
esos iconos).

**Solución (ya incluida en `Dockerfile.subpath`):** inyectar `images.unoptimized: true` en el build.
`next/image` deja de pasar por el optimizador y el navegador pide el archivo estático directo (servido
bajo `basePath`). Reconstruir y volver a publicar la imagen:

```bash
docker build -f docs/deploy/Dockerfile.subpath --build-arg BASE_PATH=/akash-console -t ${IMAGE} .
docker push ${IMAGE}
kubectl rollout restart deploy/akash-console-air   # o statefulset, según tu manifiesto
```

**Fallback** (solo si tras lo anterior algún `/images/*` aún diera 404 en DevTools → Network, lo que
indicaría que el `src` quedó sin prefijo): añade un bridge en `nginx-akash-console.conf`:

```nginx
location ^~ /images/ {
    proxy_pass http://akash-console-air-service:8080/akash-console/images/;
}
```
(Verifica que la plataforma no use ya `/images/` en la raíz de `<host>`, igual que con los demás
bridges.)

---

## 10. Checklist

- [ ] Daemon de Docker con ≥ 8 GB para el build.
- [ ] Imagen construida con `--build-arg BASE_PATH=/akash-console` (Opción A) → inyecta `basePath` + `images.unoptimized`.
- [ ] Prueba local: `http://localhost:8080/akash-console` carga; `/` da 404.
- [ ] Sin errores `isn't a valid image …` en los logs del contenedor (ver §9.1).
- [ ] Imagen publicada en GAR y referenciada en el Deployment.
- [ ] `readinessProbe` → `/akash-console` (Opción A) o `/` (Opción B).
- [ ] Egress a Internet (Cloud NAT / NetworkPolicy) verificado desde un pod.
- [ ] nginx: location `/akash-console/` + bridges `/api/proxy/`, `/api/provider-proxy/`, `/api/node-status`, `/api/blockchain-config`, `/sdl-schema.yaml`.
- [ ] `map $http_upgrade $connection_upgrade` presente en el `http {}` de nginx.
- [ ] DevTools → Network sin 404 de recursos en la raíz.
- [ ] (Opcional) `NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID` para wallets móviles.

---

## Archivos de apoyo (en `docs/deploy/`)

| Archivo | Propósito |
|---|---|
| [`deploy/Dockerfile.subpath`](./deploy/Dockerfile.subpath) | Build con `basePath` inyectado (no toca el repo) |
| [`deploy/nginx-akash-console.conf`](./deploy/nginx-akash-console.conf) | Config nginx (Opción A) con bridges |
| [`deploy/k8s-akash-console.example.yaml`](./deploy/k8s-akash-console.example.yaml) | Deployment + Service (+ Ingress comentado) |

Ver también: [`resumen-proyecto.md`](./resumen-proyecto.md).
