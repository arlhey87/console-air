# Console Air — Resumen de estructura y propósito

> Documento de síntesis del proyecto. Generado a partir del análisis del código y la documentación
> existente (`docs/`, `README.md`, `CLAUDE.md`). No modifica código fuente.

## 1. Propósito

**Console Air** es el fork **self-custody / self-hosted** de [Akash Console](https://console.akash.network),
definido por la propuesta [AEP-84](https://github.com/akash-network/AEP/tree/main/spec/aep-84)
("Console Split"). Es una **interfaz web (UI) para desplegar cargas de trabajo en la red Akash**
(marketplace descentralizado de cómputo basado en Cosmos SDK).

La diferencia esencial frente al Console gestionado:

|                      | Akash Console (gestionado)                      | **Console Air (este repo)**                                                      |
|----------------------|-------------------------------------------------|----------------------------------------------------------------------------------|
| Custodia de llaves   | Wallet gestionado (login email/social, tarjeta) | **El usuario firma con su propia wallet** (Keplr, Cosmostation, MetaMask-cosmos) |
| Backend con secretos | Sí (API gestionada)                             | **No hay backend con llaves** — no existe `apps/api`                             |
| Endpoints de cadena  | Gestionados                                     | Configurables (RPC/REST/API propios)                                             |
| Self-hosting         | No                                              | **Sí, es el objetivo**                                                           |

En una frase: *Console Air entrega la experiencia completa de despliegue en Akash sin que ningún
servidor custodie llaves; cada transacción se firma del lado del cliente.*

**Para quién es** (de `docs/index.md`): quienes tienen ACT/AKT y quieren firmar sus propias
transacciones, operar contra sus propios endpoints, o auto-hospedar toda la UI bajo su dominio.

## 2. Tecnologías principales

- **Next.js 16** (Pages Router) + **React 18** + **TypeScript** — build `output: "standalone"`.
- **Cosmos**: `@cosmos-kit/*` (conexión de wallets), `@cosmjs/*`, `@akashnetwork/chain-sdk`
  (construcción/firma de mensajes; target Cosmos SDK 53).
- **Estado**: Jotai (estado local/cliente) + TanStack Query (estado de servidor/cache).
- **UI**: MUI 5, Tailwind, Radix, `@akashnetwork/ui`, Monaco (editor SDL), Nivo/Recharts (gráficas).
- **Monorepo**: npm workspaces (`apps/*`, `packages/*`).
- **Tests**: Vitest (unit, co-localizados `*.spec.ts[x]`) + Playwright (e2e).

## 3. Estructura del monorepo

```
console-air/
├─ apps/
│  └─ deploy-web/            # ÚNICA app: la UI Next.js (no existe apps/api)
│     ├─ src/
│     │  ├─ pages/           # Rutas Next (Pages Router)
│     │  │  └─ api/          # Rutas server-side = capa BFF / proxy same-origin
│     │  ├─ components/      # Componentes React (flujos de despliegue, wallet, SDL…)
│     │  ├─ context/         # Providers (WalletProvider, CustomChainProvider, Services…)
│     │  ├─ services/        # Servicios + contenedor de Inyección de Dependencias (DI)
│     │  ├─ queries/         # Hooks de TanStack Query (claves en queryKeys.ts)
│     │  ├─ store/           # Stores Jotai (wallet, network, sdl, certificate, route…)
│     │  ├─ hooks/ lib/ utils/ config/ chains/ types/
│     │  └─ proxy.ts         # Middleware Next (modo mantenimiento, redirecciones)
│     ├─ env/                # .env.sample (todas las vars son opcionales)
│     ├─ Dockerfile          # Build multi-stage → imagen standalone (puerto 3001)
│     └─ next.config.js
├─ packages/                 # Librerías compartidas (@akashnetwork/*)
│  ├─ net                    # Config de red (RPC/REST/chainId) — GENERADA por script
│  ├─ http-sdk               # Capa HTTP (Axios) hacia las APIs de Akash
│  ├─ react-query-sdk        # Hooks de TanStack Query generados (OpenAPI)
│  ├─ react-query-proxy      # Soporte para los hooks generados
│  ├─ network-store          # Abstracción de almacenamiento del navegador
│  ├─ env-loader             # Carga de variables de entorno
│  ├─ logging                # LoggerService
│  ├─ ui                     # Librería de componentes compartida
│  └─ dev-config             # tsconfig / eslint / build compartidos
├─ deploy/k8s/               # Manifiestos Kubernetes de ejemplo
└─ docs/                     # Documentación (incluye este resumen y diagramas)
```

## 4. Arquitectura (visión general)

La app es Next.js con **Pages Router**, pero ejecuta código tanto en navegador como en servidor; la
mayoría de los módulos deben funcionar en ambos runtimes (`browser` y `nodejs`). Cuatro pilares:

### 4.1 Inyección de dependencias (DI) perezosa
`src/services/container/createContainer.ts` + `src/services/app-di-container/`. Los servicios se
resuelven como **singletons perezosos** (cada factory corre una vez, a primer acceso; detecta
dependencias circulares). Existen variantes `browser-di-container` y `server-di-container`. La mayoría
de las factories reciben `runtimeEnv: "nodejs" | "browser"` y ramifican según el entorno. Se accede a
los servicios vía el contenedor / `ServicesProvider`, no instanciándolos directamente.

### 4.2 Capa BFF / proxy same-origin
`src/pages/api/proxy/*` y `src/pages/api/provider-proxy/*`. El tráfico del navegador hacia los
endpoints de Akash (REST, RPC, provider-proxy, templates) se enruta **a través de rutas API de Next**
para que el navegador permanezca *same-origin* y evite fallos de CORS (preflight). El código
server-side llama directamente a los upstreams (CORS no aplica). **Excepción:** los WebSockets evitan
el proxy (las rutas API de Next no hacen upgrade) y van directo al upstream.

Rutas BFF observadas: `/api/blockchain-config`, `/api/node-status`,
`/api/proxy/{network}/v1/*` (market-data, providers), `/api/proxy/akash-rest/{network}/...`,
`/api/proxy/akash-rpc/{network}`, `/api/proxy/templates/...`, `/api/provider-proxy/{network}`.

### 4.3 Firma self-custody
`src/context/WalletProvider/WalletProvider.tsx`. Las wallets se conectan vía `@cosmos-kit/react`
(Keplr, Cosmostation, MetaMask-cosmos). `signAndBroadcastTx(msgs)` **estima la comisión, firma con la
wallet del usuario (opcionalmente bajo un `feeGranter`) y difunde** — todo en el cliente. Es el núcleo
del fork: **ningún servidor custodia llaves ni firma**.

### 4.4 Estado y datos
- **Jotai** (`src/store`): `walletStore`, `networkStore`, `sdlStore`, `certificateStore`,
  `routeStore`, `global-store`.
- **TanStack Query** (`src/queries`): hooks de datos de servidor, con claves centralizadas en
  `queryKeys.ts` y `QueryClient` configurado en el contenedor DI (reintentos solo en 5xx).

## 5. Flujo de datos (alto nivel)

```
Navegador (React + Jotai + TanStack Query)
   │  fetch same-origin  →  /api/proxy/* , /api/provider-proxy/*   (capa BFF de Next)
   ▼
Servidor Next (rutas API)  ──HTTP──▶  Console API · Chain REST/RPC · Provider Proxy · Templates
   ▲                                   (infraestructura pública de Akash, por defecto)
   │
Firma de transacciones: NO pasa por el backend → la wallet del usuario (extensión/WC)
firma localmente y difunde vía /api/proxy/akash-rpc/{network}.
```

## 6. Despliegue (referencia rápida)

- **Imagen**: `apps/deploy-web/Dockerfile` (multi-stage; build con heap de 6 GB; runtime
  `node:22-bookworm-slim`, usuario no-root uid 1001, **puerto 3001**, `node server.js` standalone).
- **Configuración**: todas las `NEXT_PUBLIC_*` tienen defaults de producción (apuntan a Akash
  hosteado); el contenedor arranca sin `.env`. Override solo si se opera infraestructura propia.
- **Kubernetes**: ejemplos en `deploy/k8s/` (Deployment + Service ClusterIP; sin Ingress/TLS, que es
  específico de cada clúster).
- **Bajo subpath `/akash-console` detrás de nginx en GCP**: ver el instructivo detallado en
  [`despliegue-gcp-docker-nginx.md`](./despliegue-gcp-docker-nginx.md) (hay una consideración
  importante porque la app no define `basePath`).

## 7. Documentos relacionados

| Documento                                                              | Contenido                                               |
|------------------------------------------------------------------------|---------------------------------------------------------|
| [`index.md`](./index.md)                                               | Para quién es Console Air                               |
| [`self-hosting.md`](./self-hosting.md)                                 | Ejecutar y auto-hospedar                                |
| [`self-custody.md`](./self-custody.md)                                 | Wallets, RPC custom, certificados                       |
| [`migrating-from-akash-console.md`](./migrating-from-akash-console.md) | Migración de datos locales                              |
| [`despliegue-gcp-docker-nginx.md`](./despliegue-gcp-docker-nginx.md)   | Despliegue en Docker/GCP tras nginx                     |
| [`diagramas/`](./diagramas/)                                           | Diagramas de arquitectura y componentes (SVG + draw.io) |
