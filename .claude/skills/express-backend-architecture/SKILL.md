---
name: express-backend-architecture
description: Definit l'architecture cible du backend Express.js (Node 22, TypeScript, structure de dossiers routes/controllers/services/middleware, gestion d'erreurs centralisee, conventions de code) qui remplace l'API Next.js Pages Router historique. Utiliser au demarrage de toute tache de developpement backend, pour creer une route, un controleur, un service, un middleware, configurer le projet Express, ou decider ou placer un nouveau fichier.
metadata:
  author: sae-backend
  version: 1.0.0
  category: architecture
---

# Architecture du backend Express

## Principe directeur

Ce backend remplace la couche `../src/pages/api/*` (Next.js Pages Router) et réutilise `../src/services/*.ts` comme point de départ métier (`acteService`, `registreService`, `communeService`, `provinceService`, `regionService`, `officierService`, `identifiantService`) — portez leur logique, ne la réinventez pas. `textExtractionService` et `decesExtractionService` (extraction OCR) sont hors périmètre de cette version, voir la section « Ce qui est hors périmètre » de `../CLAUDE.md`. Ce qui change, c'est la couche transport (Express au lieu de handlers Next.js), le stockage fichier (MinIO au lieu du base64 en base), le cache (Redis, absent aujourd'hui) et l'observabilité (absente aujourd'hui).

## Stack (voir aussi `../CLAUDE.md`)

Node 22 LTS · TypeScript 5 strict · Express 5 · Prisma (schéma partagé, ne pas dupliquer) · Zod · `ioredis` + BullMQ · SDK `minio` · Pino · `prom-client` · Vitest + Supertest.

## Structure de dossiers

```
backend/
├── package.json              # indépendant de la racine — ne mélangez pas les deux node_modules
├── tsconfig.json
├── src/
│   ├── server.ts              # bootstrap : écoute le port, gère SIGTERM proprement
│   ├── app.ts                 # construit l'app Express (middlewares globaux, montage des routes)
│   ├── config/
│   │   └── env.ts             # schéma Zod des variables d'env, parse au démarrage, crash si invalide
│   ├── lib/
│   │   ├── prisma.ts          # export const prisma = new PrismaClient() — SINGLETON, jamais `new` ailleurs
│   │   ├── redis.ts           # singleton ioredis
│   │   ├── minio.ts           # singleton client MinIO
│   │   └── logger.ts          # singleton Pino
│   ├── middleware/
│   │   ├── auth.ts            # requireAuth, requireRole(...) — voir [[auth-rbac-security]]
│   │   ├── validate.ts        # wrap Zod schema -> middleware Express
│   │   ├── errorHandler.ts    # dernier middleware, centralise le formatage d'erreur
│   │   └── requestContext.ts  # request-id + logger enfant par requête
│   ├── errors/
│   │   └── AppError.ts        # NotFoundError, ValidationError, ConflictError, UnauthorizedError...
│   ├── routes/                # un fichier par ressource : acte.routes.ts, registre.routes.ts, ...
│   ├── controllers/           # (req, res, next) -> appelle un service, ne contient pas de logique métier
│   ├── services/               # logique métier portée depuis ../src/services
│   ├── jobs/                   # workers BullMQ : csvImport.worker.ts, imageCompress.worker.ts
│   └── openapi/                # (optionnel) génération de doc à partir des schémas Zod
└── test/
    ├── unit/
    └── integration/            # Supertest contre une DB de test
```

## Couches et responsabilités

```
route → middleware validation (Zod) → controller → service → prisma / redis / minio
```

- **Route** : déclare uniquement le verbe HTTP, le chemin, la chaîne de middlewares. Zéro logique.
- **Controller** : extrait `req.params`/`req.body`/`req.query` déjà validés, appelle un service, choisit le code HTTP et la forme de réponse (voir [[api-conventions-and-validation]]). Ne fait pas de requête Prisma directement.
- **Service** : logique métier pure, testable sans Express (pas de `req`/`res` en paramètre). C'est ici que vivent les règles décrites dans [[civil-status-domain-model]] et [[iucec-identifiant-service]].
- **Job (BullMQ worker)** : même règle que service, mais déclenché de façon asynchrone — voir [[redis-caching-and-queues]].

## Gestion d'erreurs centralisée

Le code actuel répète `try/catch` + `res.status(500).json({error: ...})` dans chaque handler, avec des messages incohérents d'un fichier à l'autre. Dans le nouveau backend :

```ts
// errors/AppError.ts
export class AppError extends Error {
  constructor(public status: number, message: string, public code?: string) {
    super(message);
  }
}
export class NotFoundError extends AppError {
  constructor(resource: string) { super(404, `${resource} introuvable`, 'NOT_FOUND'); }
}
```

- Les controllers/services **lancent** ces erreurs (`throw new NotFoundError('Registre')`), ils ne construisent jamais eux-mêmes une réponse d'erreur.
- Un unique middleware d'erreur (dernier de la chaîne dans `app.ts`) formate la réponse JSON (voir le format dans [[api-conventions-and-validation]]), logue via Pino avec le request-id, et ne fuit **jamais** la stack trace en production — reproduisez le réflexe déjà présent dans le code actuel (`process.env.NODE_ENV === 'development' ? error.message : undefined`), généralisez-le au lieu de le répéter route par route.
- Express 5 propage nativement les rejets de promesse vers ce middleware (pas besoin d'un wrapper `asyncHandler` comme en Express 4) — vérifiez la version installée avant d'ajouter un tel wrapper par réflexe.

## Validation Zod en middleware, pas dans les controllers

```ts
// middleware/validate.ts
export const validate = (schema: ZodSchema) => (req, res, next) => {
  const result = schema.safeParse(req.body);
  if (!result.success) return next(new ValidationError(result.error));
  req.body = result.data;
  next();
};
```

Le service actuel `registreService.ts` valide "à la main" (`if (!data.numero || ...) throw new Error(...)`) directement dans la fonction métier — ne reproduisez pas ce pattern dans le nouveau backend, la validation de forme appartient au middleware, le service ne doit gérer que les règles métier (unicité, cohérence entre champs).

## Configuration et variables d'environnement

Validez les variables d'env avec Zod **au démarrage**, échouez vite (`process.exit(1)`) plutôt que de laisser une variable manquante provoquer une erreur obscure au premier appel Redis/MinIO en production :

```ts
const envSchema = z.object({
  DATABASE_URL: z.string().url(),
  JWT_SECRET: z.string().min(32),
  REDIS_URL: z.string(),
  MINIO_ENDPOINT: z.string(),
  MINIO_ACCESS_KEY: z.string(),
  MINIO_SECRET_KEY: z.string(),
  PORT: z.coerce.number().default(4000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
});
export const env = envSchema.parse(process.env);
```

## Docker

Étendre le `docker-compose.yml` racine (pattern déjà en place : service + healthcheck + réseau `mynetwork`) avec `redis`, `minio`, et le nouveau service `backend` — pas le remplacer. Voir [[minio-file-storage]] et [[redis-caching-and-queues]] pour les services à ajouter, et [[logging-monitoring-observability]] pour un éventuel `prometheus`/`grafana`.

## Ce qu'il ne faut pas faire

- Ne pas instancier `new PrismaClient()` dans plus d'un fichier (`src/lib/prisma.ts`) — le code actuel le fait exceptionnellement dans `identifiantService.ts` pour des raisons historiques Next.js (hot-reload) qui ne s'appliquent plus ici.
- Ne pas mettre de logique métier dans les routes ou les controllers.
- Ne pas dupliquer `prisma/schema.prisma` — référencez-le (`backend/prisma` peut être un lien symbolique ou un chemin relatif dans `schema.prisma` `datasource`), ne divergez pas du schéma racine sans migration coordonnée.
