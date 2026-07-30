---
name: redis-caching-and-queues
description: Patterns Redis pour ce backend, cache-aside pour les donnees de reference (region/province/commune/officier) et les statistiques, files d'attente BullMQ pour l'import CSV et la compression d'image en tache de fond, et ce qu'il ne faut jamais mettre en cache (le compteur IdentifiantSequence). Utiliser pour toute tache de cache, performance, job asynchrone ou limitation de debit.
metadata:
  author: sae-backend
  version: 1.0.0
  category: infrastructure
---

# Redis — cache et files d'attente

Redis a deux usages distincts dans ce backend. Ne les mélangez pas dans la même instance de client sans le documenter : le cache tolère la perte de données (c'est un raccourci vers Postgres), les files d'attente BullMQ non (un job perdu = un import qui ne se termine jamais). En développement une seule instance Redis suffit ; en production, envisagez deux `db` logiques (`REDIS_URL` avec `/0` pour le cache, `/1` pour BullMQ) ou deux instances si le volume le justifie.

## Client singleton

```ts
// lib/redis.ts
import { Redis } from 'ioredis';
export const redis = new Redis(env.REDIS_URL);
```

Un seul client cache dans `src/lib/redis.ts` — même règle que Prisma et MinIO.

## Convention de clés

```
sae:cache:<domaine>:<identifiant>       # ex. sae:cache:commune:12
sae:cache:list:<domaine>:<hash-filtres>  # ex. sae:cache:list:region:all
sae:job:<queue>:<jobId>                    # géré par BullMQ, ne pas manipuler manuellement
```

## Ce qui mérite d'être caché (cache-aside)

| Donnée | TTL indicatif | Invalidation |
|---|---|---|
| Listes Region / Province / Commune / Officier | 1h | à l'écriture (create/update/delete sur la ressource) |
| Détail d'une Commune (avec `code_ecc`) | 1h | idem |
| Statistiques dashboard (comptes par statut, par commune) | 1–5 min | pas d'invalidation active, TTL court suffit vu la fréquence de lecture |
| URL présignée MinIO déjà générée | légèrement < durée de validité de l'URL | expiration naturelle |

```ts
async function getCommunes() {
  const cached = await redis.get('sae:cache:list:commune:all');
  if (cached) return JSON.parse(cached);
  const communes = await prisma.commune.findMany({ include: { province: true } });
  await redis.set('sae:cache:list:commune:all', JSON.stringify(communes), 'EX', 3600);
  return communes;
}
```

Invalidez explicitement (`redis.del(...)`) dans le même service qui fait le `create`/`update`/`delete` — ne comptez pas uniquement sur le TTL pour la cohérence des données de référence, un administrateur qui vient de corriger une commune doit voir le changement immédiatement.

## Ce qu'il ne faut JAMAIS mettre en cache

**Le compteur `IdentifiantSequence.dernier_numero` ne doit jamais transiter par Redis comme source de décision.** Voir [[iucec-identifiant-service]] : l'incrément est un `UPDATE ... increment` atomique en base, seule garantie contre la génération de deux identifiants identiques par deux instances Express concurrentes. Un cache Redis introduirait une fenêtre de désynchronisation. Le seul usage Redis toléré ici est un cache **en lecture seule et à courte durée** pour l'endpoint `/identifiant/statistiques` (affichage), jamais pour décider du prochain `numero_ordre`.

Ne cachez pas non plus les `Acte` individuels : ils sont mutables fréquemment (workflow de statut, validation), la fraîcheur prime sur la performance de lecture pour cette ressource. Cachez plutôt les objets qui en dépendent peu et changent rarement (listes de référence, statistiques agrégées).

## Files d'attente BullMQ

Le traitement synchrone actuel (import CSV ligne par ligne dans le handler) bloque la requête et échoue par timeout sur de gros volumes. Dans le nouveau backend, ces traitements deviennent des jobs :

| Queue | Déclenché par | Détail |
|---|---|---|
| `csv-import` | `POST /admin/actes/import` | le endpoint répond immédiatement avec un `jobId`, le résultat (comptes importés/échecs par ligne) est consultable via `GET /jobs/:jobId` |
| `image-processing` | upload d'acte, génération de miniature | découplé de la requête d'upload si le volume par lot est important (jusqu'à 300 fichiers aujourd'hui, `MAX_FILES`) |

```ts
// jobs/queues.ts
import { Queue } from 'bullmq';
export const csvImportQueue = new Queue('csv-import', { connection: redisConnection });
```

Chaque worker vit dans `src/jobs/*.worker.ts`, tourne dans le même process au démarrage ou dans un process dédié selon la charge — décidez au moment de l'implémentation selon le volume réel constaté, ne sur-architecturez pas dès le départ un déploiement multi-process s'il n'y a pas encore de charge mesurée.

## Endpoint de statut de job

Prévoir `GET /jobs/:id` (ou namespacé par ressource, ex. `GET /admin/actes/import/:jobId`) qui interroge l'état BullMQ (`waiting | active | completed | failed`) — c'est le remplacement direct de la réponse synchrone `{ importedCount, failedCount, errors }` que l'endpoint actuel renvoie tout de suite ; avec une file d'attente, cette même forme de réponse devient le résultat consultable après coup, pas la réponse HTTP immédiate.
