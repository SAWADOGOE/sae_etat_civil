---
name: logging-monitoring-observability
description: Configure les logs structures (Pino), les metriques Prometheus, le tracage OpenTelemetry et les health checks pour ce backend Express. Utiliser des qu'on ajoute du logging, un endpoint /health ou /metrics, du monitoring, de la gestion d'erreurs observable, ou qu'on discute d'incidents ou de debogage en production.
metadata:
  author: sae-backend
  version: 1.0.0
  category: observability
---

# Logs, métriques et santé du service

## Point de départ : il n'y a rien aujourd'hui

Le code actuel s'appuie uniquement sur `console.log`/`console.error`, parfois avec des emojis (`✓`, `🔄`), sans structure, sans niveau, sans corrélation entre les lignes d'une même requête. Il n'y a ni `/health`, ni métriques, ni traçage. Ce skill part de zéro, pas d'un existant à porter — c'est une des vraies plus-values de la réécriture.

## Logs structurés (Pino)

```ts
// lib/logger.ts
import pino from 'pino';
export const logger = pino({
  level: env.NODE_ENV === 'production' ? 'info' : 'debug',
  redact: ['req.headers.authorization', 'body.password', 'body.acte_numerisee', 'body.base64Image'],
});
```

- **Redaction obligatoire** des champs sensibles ou volumineux : mots de passe, tokens, et surtout **les blobs base64 d'images** — le code actuel logue déjà des tailles (`Taille: X KB → Y KB`) ce qui est utile et à conserver, mais ne jamais logger le contenu base64 lui-même (ça a explosé la taille des logs plus d'une fois dans ce genre d'app).
- `pino-http` comme middleware Express pour logger automatiquement chaque requête (méthode, chemin, statut, durée) avec un `req.id` corrélé.
- Niveaux : `error` pour les échecs métier/infra, `warn` pour les cas dégradés mais gérés (ex. cache Redis indisponible, bascule en lecture directe base), `info` pour les événements métier notables (acte validé, import CSV terminé), `debug` pour le détail de dev.

## Request ID / corrélation

```ts
// middleware/requestContext.ts
app.use((req, res, next) => {
  req.id = req.headers['x-request-id']?.toString() ?? randomUUID();
  res.setHeader('x-request-id', req.id);
  req.log = logger.child({ requestId: req.id });
  next();
});
```

Chaque service/controller utilise `req.log` (ou le logger propagé via `AsyncLocalStorage` si vous préférez éviter de faire transiter `req` jusqu'au service) plutôt que `console.log` — objectif : pouvoir filtrer tous les logs d'une requête précise en production quand un utilisateur signale un problème.

## Métriques Prometheus

```ts
// lib/metrics.ts
import client from 'prom-client';
client.collectDefaultMetrics(); // CPU, mémoire, event loop lag

export const httpDuration = new client.Histogram({
  name: 'http_request_duration_seconds',
  help: 'Durée des requêtes HTTP',
  labelNames: ['method', 'route', 'status'],
});

export const queueDepth = new client.Gauge({
  name: 'bullmq_queue_depth',
  help: 'Nombre de jobs en attente par queue',
  labelNames: ['queue'],
});
```

Exposez `GET /metrics` (format texte Prometheus, `client.register.metrics()`) — **non authentifié par JWT mais restreint au réseau interne** (pas exposé publiquement), c'est la convention Prometheus standard (scrape interne).

Métriques prioritaires à instrumenter en premier, par ordre de valeur pour ce projet précis :
1. Durée et taux d'erreur HTTP par route.
2. Profondeur des files BullMQ (`csv-import`, `image-processing`) — signal direct de retard de traitement.
3. Taux de hit/miss du cache Redis (données de référence) — valide que le cache sert à quelque chose.

## Health checks

```
GET /health/live    → 200 si le process tourne (pas de dépendance externe vérifiée)
GET /health/ready    → 200 seulement si Postgres (Prisma), Redis et MinIO répondent
```

`/health/live` sert au restart automatique du conteneur (liveness probe), `/health/ready` sert à ne recevoir du trafic qu'une fois les dépendances up (readiness probe) — ne fusionnez pas les deux, un Postgres momentanément indisponible ne doit pas provoquer un restart en boucle du conteneur applicatif, seulement le retirer temporairement du load balancing.

## Traçage (optionnel, à activer si la complexité le justifie)

OpenTelemetry SDK pour instrumenter Express + Prisma + `ioredis` automatiquement (`@opentelemetry/auto-instrumentations-node`) si le besoin de tracer une requête à travers plusieurs services (Express → job BullMQ → MinIO) devient concret. Ne l'introduisez pas en même temps que le reste de la stack d'observabilité si personne ne l'exploite encore — Pino + Prometheus + health checks couvrent déjà l'essentiel des besoins de debug initial.

## Infra Docker

Étendre `docker-compose.yml` (pattern existant : un service par dépendance, healthcheck, réseau `mynetwork` partagé) avec, a minima, `prometheus` scrapant `backend:PORT/metrics`. `grafana` est optionnel en local (dashboards utiles surtout en environnement partagé/prod) ; en alternative, un service hébergé (Grafana Cloud) évite de maintenir cette brique soi-même. Sentry (ou équivalent) reste une option complémentaire pour l'agrégation d'erreurs côté produit si le volume d'incidents le justifie — pas un prérequis du MVP d'observabilité.
