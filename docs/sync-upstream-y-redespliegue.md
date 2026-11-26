# Sincronizar con upstream y redesplegar en GKE

> Este fork (`origin` = `arlhey87/console-air`) **no envía PRs a upstream**
> (`akash-network/console-air`). Upstream solo se usa como fuente: se trae su `main`, se integra en
> una rama `chore/sync-upstream` y de ahí se mergea al `main` **del fork**.

## 1. Traer cambios de upstream (una vez por sync)

```bash
git remote get-url upstream || git remote add upstream https://github.com/akash-network/console-air.git
git fetch upstream --no-tags
git log --oneline main..upstream/main            # qué hay nuevo
git merge-tree --write-tree --name-only main upstream/main   # conflictos previstos, sin tocar el árbol
git switch -c chore/sync-upstream main
git merge --no-ff upstream/main
```

Al resolver conflictos, **conservar `withBasePath()`** en toda URL root-absoluta que arme el cliente
(`/api/proxy/*`, `/api/provider-proxy/*`, assets del `<head>`). Revisar también las rutas `/api/...`
**nuevas** que traiga upstream:

```bash
git diff <merge-base> upstream/main -- apps/deploy-web/src | grep -E '^\+' | grep -E "[\"'\`]/(api|images|favicon|manifest)"
```

Mantener el **fork guard** de `.github/workflows/release.yml` (`if: github.repository ==
'akash-network/console-air'` en el job `version`); sin él, cada push a `main` del fork intentaría
crear tags/releases, publicar en ghcr y desplegar en `air.akash.network`.

Verificar antes de integrar (desde Git Bash):

```bash
npm ci
cd apps/deploy-web
npx tsc --noEmit
NODE_ENV=test DEPLOYMENT_ENV=staging npx vitest run
```

> En Windows fallan `amd-crl.parser.spec.ts` y `amd-snp.service.spec.ts`: el fixture
> `amd-crl.test-fixtures.ts` escribe una ruta Windows dentro de un `ca.cnf` y `openssl` interpreta
> las `\` como escapes. Es del código de upstream y pasa en Linux (CI). No bloquea el sync.

## 2. Mergear a `main` del fork

```bash
git push -u origin chore/sync-upstream
```

**Opción A — PR en el fork (recomendada, corre el CI del fork):**
abrir `https://github.com/arlhey87/console-air/compare/main...chore/sync-upstream`.
⚠️ En un fork, GitHub propone por defecto como base `akash-network/console-air`: cambiar
**base repository** a `arlhey87/console-air` y base `main`. Mergear con **"Create a merge commit"**
(no squash: preserva la historia de upstream y facilita el próximo sync).

**Opción B — merge local:**

```bash
git switch main
git pull --ff-only origin main
git merge --ff-only chore/sync-upstream
git push origin main
```

## 3. Redesplegar en GKE

Los valores del entorno (proyecto GCP, Artifact Registry, cluster, key de la service account) **no
están versionados**: viven en `deploy/deploy.env` (gitignored). La primera vez:

```bash
cp deploy/deploy.env.example deploy/deploy.env   # y completar los <placeholders>
```

Requisitos: Docker (en Windows vía WSL: `DOCKER="wsl docker"`), `gcloud` autenticado, `kubectl`,
`envsubst` y el JSON de la service account en la ruta de `GAR_SA_KEY_FILE` (gitignored). Correr
**desde Git Bash, en la raíz del repo, con `main` actualizado**:

```bash
git switch main && git pull --ff-only origin main
bash deploy/publish-gar.sh <VERSION>      # p. ej. 1.1.1-sync.20261126
```

El script:
1. construye `deploy/Dockerfile` con `BASE_PATH` y lo etiqueta
   `<GAR_LOCATION>-docker.pkg.dev/<GCLOUD_PROJECT>/<GAR_REPOSITORY>/<IMAGE>:<VERSION>`;
2. hace login en GAR con la service account (si `GAR_SA_KEY_FILE` está definido) y `docker push`;
3. obtiene credenciales de `GKE_CLUSTER` y aplica `deploy/k8s/gke.deployment.template.yaml` vía
   `envsubst` directo a `kubectl apply` (no deja archivos renderizados).

Usar siempre un tag nuevo: con un tag repetido el manifiesto no cambia y no hay rollout.

## 4. Verificar

```bash
kubectl rollout status deploy/akash-console-air
kubectl get pods -l app=akash-console-air
kubectl logs deploy/akash-console-air --tail=100
# Prueba interna, sin nginx:
kubectl port-forward svc/akash-console-air-service 8080:8080   # → http://localhost:8080/akash-console
```

Luego en `https://<host>/akash-console`:
- carga la app y los assets (sin 404 en DevTools → Network);
- conectar wallet, ver listado de deployments (`/akash-console/api/proxy/...`);
- abrir un deployment con lease (`/akash-console/api/provider-proxy/...`);
- si hay un lease de Confidential Compute, "Validate" de la attestation debe ir a
  `/akash-console/api/confidential-compute/attestation/validate` (ruta nueva de este sync).

No hace falta tocar nginx: el bloque `location ^~ /akash-console` ya cubre las rutas API nuevas.

## 5. Rollback

```bash
kubectl rollout undo deploy/akash-console-air
kubectl rollout status deploy/akash-console-air
```

o volver a aplicar una imagen anterior que ya está en GAR, sin reconstruir:

```bash
IMAGE_NAME=<imagen>:<VERSION_ANTERIOR> REPLICAS=1   envsubst '${IMAGE_NAME} ${REPLICAS}' < deploy/k8s/gke.deployment.template.yaml | kubectl apply -f -
```
