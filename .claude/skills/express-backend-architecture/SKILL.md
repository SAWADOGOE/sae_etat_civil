---
name: express-backend-architecture
description: Definit l'architecture cible du backend Express.js (structure de dossiers routes/controllers/services/middleware, gestion d'erreurs centralisee, conventions de code, docker-compose de developpement) qui remplace l'API Next.js Pages Router du depot legacy. Utiliser systematiquement au demarrage de toute tache de developpement backend, pour bootstrapper le projet, creer une route, un controleur, un service, un middleware, ou decider ou placer un nouveau fichier — meme si la demande ne mentionne pas le mot architecture.
metadata:
  author: sae-backend
  version: 1.1.0
  category: architecture
---

# Architecture du backend Express

## Principe directeur

Ce backend remplace la couche `legacy:src/pages/api/*` (Next.js Pages Router) et réutilise `legacy:src/services/*.ts` comme point de départ métier (`acteService`, `registreService`, `communeService`, `provinceService`, `regionService`, `officierService`, `identifiantService`) — portez leur logique, ne la réinventez pas. Pour lire ces fichiers, clonez le legacy dans `./legacy/` comme décrit dans `CLAUDE.md`, section « Le dépôt legacy ». `textExtractionService` et `decesExtractionService` (extraction OCR) sont hors périmètre — voir la section « Hors périmètre » de `CLAUDE.md`.

Ce qui change : la couche transport (Express au lieu de handlers Next.js), le stockage fichier (MinIO au lieu du base64 en base), le cache (Redis, absent aujourd'hui) et l'observabilité (absente aujourd'hui).

## Stack

La liste des choix de stack et leurs justifications vivent dans `CLAUDE.md` (source de vérité unique) — ne la dupliquez pas ici. Cette skill détaille *comment* structurer le code avec cette stack.

## Structure de dossiers (racine du dépôt)

```
sae_etat_civil/                 ← racine de CE dépôt
├── CLAUDE.md
├── README.md
├── .claude/skills/
├── .gitignore                   # inclut .env, legacy/, node_modules/
├── .env.example                 # toutes les variables, valeurs factices — commité
├── .nvmrc                       # 22
├── package.json
├── tsconfig.json
├── docker-compose.yml           # services de DEV de ce backend (voir section Docker)
├── prisma/
│   ├── schema.prisma            # importé du legacy, désormais propriété de CE dépôt
│   └── migrations/              # idem — voir « Gouvernance du schéma » dans CLAUDE.md
├── src/
│   ├── server.ts                # bootstrap : écoute le port, gère SIGTERM proprement
│   ├── app.ts                   # construit l'app Express (middlewares globaux, montage des routes)
│   ├── config/
│   │   └── env.ts               # schéma Zod des variables d'env, parse au démarrage, crash si invalide
│   ├── lib/
│   │   ├── prisma.ts            # export const prisma = new PrismaClient() — SINGLETON, jamais `new` ailleurs
│   │   ├── redis.ts             # singleton ioredis
│   │   ├── minio.ts             # singleton client MinIO
│   │   └── logger.ts            # singleton Pino
│   ├── middleware/
│   │   ├── auth.ts              # requireAuth, requireRole(...) — voir skill auth-rbac-security
│   │   ├── validate.ts          # wrap Zod schema -> middleware Express
│   │   ├── errorHandler.ts      # dernier middleware, centralise le formatage d'erreur
│   │   └── requestContext.ts    # request-id + logger enfant par requête
│   ├── errors/
│   │   └── AppError.ts          # NotFoundError, ValidationError, ConflictError, UnauthorizedError...
│   ├── routes/                  # un fichier par ressource : actes.routes.ts, registres.routes.ts, ...
│   ├── controllers/             # (req, res, next) -> appelle un service, ne contient pas de logique métier
│   ├── services/                # logique métier portée depuis legacy:src/services
│   ├── jobs/                    # workers BullMQ : csvImport.worker.ts, imageCompress.worker.ts
│   └── openapi/                 # registre des schémas OpenAPI — voir skill api-conventions-and-validation
└── test/
    ├── unit/
    ├── integration/             # Supertest contre une DB de test — voir skill testing-and-parity
    └── parity/                  # harnais de comparaison avec le legacy — idem
```

## Couches et responsabilités

```
route → middleware validation (Zod) → controller → service → prisma / redis / minio
```

- **Route** : déclare uniquement le verbe HTTP, le chemin, la chaîne de middlewares. Zéro logique.
- **Controller** : extrait `req.params`/`req.body`/`req.query` déjà validés, appelle un service, choisit le code HTTP et la forme de réponse (voir skill `api-conventions-and-validation`). Ne fait pas de requête Prisma directement.
- **Service** : logique métier pure, testable sans Express (pas de `req`/`res` en paramètre). C'est ici que vivent les règles décrites dans les skills `civil-status-domain-model` et `iucec-identifiant-service`.
- **Job (worker BullMQ)** : même règle que service, mais déclenché de façon asynchrone — voir skill `redis-caching-and-queues`.

## Gestion d'erreurs centralisée

Le code legacy répète `try/catch` + `res.status(500).json({error: ...})` dans chaque handler, avec des messages incohérents d'un fichier à l'autre. Dans ce backend :

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
- Un unique middleware d'erreur (dernier de la chaîne dans `app.ts`) formate la réponse JSON (format dans la skill `api-conventions-and-validation`), logue via Pino avec le request-id, et ne fuit **jamais** la stack trace en production — le legacy a ce réflexe ponctuellement (`process.env.NODE_ENV === 'development' ? error.message : undefined`) : généralisez-le ici au lieu de le répéter route par route.
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

Le service legacy `registreService.ts` valide « à la main » (`if (!data.numero || ...) throw new Error(...)`) directement dans la fonction métier — ne reproduisez pas ce pattern : la validation de forme appartient au middleware, le service ne gère que les règles métier (unicité, cohérence entre champs).

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

Chaque variable ajoutée ici doit apparaître dans `.env.example` avec une valeur factice et un commentaire. Jamais de valeur réelle commitée — voir `CLAUDE.md`, contrainte « Aucun secret versionné ».

## Docker de développement (propre à ce dépôt)

Ce dépôt a **son propre** `docker-compose.yml` de dev — on n'étend pas celui du legacy (dépôts séparés). Services : `postgres` (image `postgres:15-alpine`, cohérente avec le legacy), `redis`, `minio` (+ console), et plus tard `prometheus` en option (voir skill `logging-monitoring-observability`).

**Ports hôte à décaler pour coexister avec le compose legacy** qui occupe déjà 5432 (postgres), 3000 (app) et 8080 (adminer) : exposez ici `postgres` sur **5433**, `redis` sur 6379, `minio` sur 9000/9001, le backend sur **4000**. Ainsi les deux environnements tournent côte à côte — indispensable pour les tests de parité (skill `testing-and-parity`).

Deux modes de branchement base de données en dev, à choisir explicitement dans `.env` :
- `DATABASE_URL` → le postgres de CE compose (port 5433) : base vierge, isolée, pour développer librement.
- `DATABASE_URL` → le postgres du compose legacy (port 5432) : mêmes données que l'app Next.js, pour vérifier le comportement sur données réelles. En lecture surtout — toute migration se lance depuis ce dépôt uniquement (gouvernance, voir `CLAUDE.md`).

## Ce qu'il ne faut pas faire

- Ne pas instancier `new PrismaClient()` dans plus d'un fichier (`src/lib/prisma.ts`). Le legacy le fait exceptionnellement dans `identifiantService.ts` pour des raisons historiques Next.js (hot-reload) qui ne s'appliquent plus ici — lors du portage de ce service, utilisez le singleton.
- Ne pas mettre de logique métier dans les routes ou les controllers.
- Ne pas modifier quoi que ce soit sous `legacy/` (clone en lecture seule) ni proposer de PR sur le dépôt legacy depuis une session de travail sur ce dépôt.
- Ne pas créer de nouvelle migration Prisma « en douce » dans une PR de feature : toute évolution de schéma est une décision explicite, nommée, documentée dans le message de migration (voir gouvernance dans `CLAUDE.md`).
