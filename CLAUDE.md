# CLAUDE.md — Backend Express (SAE État Civil)

Ce fichier guide Claude Code pour tout travail effectué **dans `backend/`**. Il est chargé automatiquement en plus de celui à la racine du dépôt. En cas de conflit sur un sujet purement backend, ce fichier fait autorité pour ce dossier.

## Où on en est

**Statut : phase de cadrage, aucun code n'a encore été écrit.** Ce dossier contient pour l'instant uniquement des *skills* Claude Code (`.claude/skills/`) et ce fichier : des instructions et des bonnes pratiques pour que les prochaines sessions (humaines ou agents) construisent ce backend de façon cohérente, plutôt qu'une implémentation. La consigne du produit propriétaire est claire : ne pas toucher au frontend Next.js existant pour l'instant, se concentrer uniquement sur ce backend.

Quand l'implémentation démarrera, elle vivra entièrement sous `backend/` (nouveau `package.json`, propre à ce dossier — ne pas mélanger avec les dépendances Next.js à la racine).

## Pourquoi ce projet existe

Le backend actuel de l'application (`../src/pages/api/`, Next.js Pages Router) est repris ici en un service Express.js autonome, avec latest-gen tooling. Trois lacunes concrètes motivent la réécriture — gardez-les en tête, elles justifient chaque choix ci-dessous :

1. **Les images d'actes numérisés sont stockées en base64 dans Postgres** (`Acte.acte_numerisee`, colonne texte) et **recompressées à chaque lecture** (`compressImage` tourne sur *chaque ligne* à chaque `GET /api/acte`, sans pagination). Ça ne passera pas à l'échelle. → objet du skill [[minio-file-storage]].
2. **Aucun cache** : les listes de référence (régions/provinces/communes/officiers), quasi statiques, sont requêtées en base à chaque appel. → objet du skill [[redis-caching-and-queues]].
3. **Aucune observabilité** : uniquement des `console.log`/`console.error` épars, pas de métriques, pas de health check exploitable en prod. → objet du skill [[logging-monitoring-observability]].

## Contraintes non négociables

Le nouveau backend doit rester un **remplacement à l'identique** des règles métier existantes — ce n'est pas l'occasion de les réinventer :

- **Le schéma de données ne change pas de philosophie.** Même hiérarchie `Region → Province → Commune → Registre → Acte`, même table `Acte` large et dénormalisée avec des champs préfixés par type d'acte (`_epoux`, `_epouse`, `_pere_epoux` pour mariage ; `_defunt`/`_declarant` pour décès). Voir [[civil-status-domain-model]].
- **L'algorithme IUCEC (identifiant à 17 caractères) doit être reproduit bit pour bit**, y compris la clé de contrôle Luhn modifié `% 97`. Toute divergence casse la compatibilité avec les identifiants déjà attribués. Voir [[iucec-identifiant-service]].
- **`IdentifiantSequence` reste l'unique source de vérité** pour le prochain `numero_ordre`, via un `UPDATE ... increment` atomique. Ne jamais le recalculer par un `COUNT()`, ne jamais le mettre en cache Redis comme source de vérité.
- **La contrainte d'unicité du Registre** `(communeId, centre_registre, numero, annee, type_registre)` reste en vigueur — `centre_registre` a un défaut `"PRINCIPAL"`, ne l'omettez jamais des requêtes.
- **On réutilise la base PostgreSQL et le schéma Prisma existants** (`../prisma/schema.prisma`). Ce backend est une réécriture de la couche API, pas une migration de données. Toute évolution du schéma (ex. remplacer `acte_numerisee` base64 par une clé d'objet MinIO) passe par une migration Prisma classique, documentée et réversible.

## Stack technique cible

| Domaine | Choix | Pourquoi |
|---|---|---|
| Runtime | Node.js 22 LTS, TypeScript 5.x strict | aligné avec le frontend existant |
| Framework HTTP | Express 5 | gestion native des erreurs async, dernière branche stable |
| ORM | Prisma (même schéma que l'app actuelle) | zéro migration de données, `prisma generate` déjà dans le flux CI |
| Validation | Zod | même bibliothèque que `acteSchema.ts` côté frontend — les règles métier (ex. format de date selon `article`) doivent pouvoir être partagées/portées telles quelles |
| Stockage fichiers | MinIO (SDK `minio`, compatible S3) | remplace le base64 en base ; voir [[minio-file-storage]] |
| Cache & files d'attente | Redis (`ioredis` + BullMQ) | cache de référence + jobs d'import/traitement d'image en tâche de fond ; voir [[redis-caching-and-queues]] |
| Auth | JWT maison (`jsonwebtoken` + `bcryptjs`/`argon2`) | remplace NextAuth, qui n'a plus de sens hors Next.js ; voir [[auth-rbac-security]] |
| Logs | Pino + `pino-http` | logs structurés JSON, redaction des champs sensibles |
| Monitoring | `prom-client` (`/metrics`) + OpenTelemetry (optionnel) | voir [[logging-monitoring-observability]] |
| Tests | Vitest + Supertest | rapide, ESM natif |
| Package manager | npm | le dépôt racine reste sur npm (`npm ci` dans le Dockerfile) — rester cohérent |

## Structure de dossiers cible

```
backend/
├── CLAUDE.md                  # ce fichier
├── README.md                  # orientation humaine
├── .claude/skills/            # les skills listées plus bas
├── package.json                # indépendant de la racine
├── src/
│   ├── config/                 # validation des variables d'env (zod), constantes
│   ├── lib/                    # clients singleton: prisma, redis, minio, logger
│   ├── middleware/              # auth, error handler, request-id, validation
│   ├── routes/                  # définition Express des endpoints, par ressource
│   ├── controllers/             # (req, res) -> appelle un service, formate la réponse
│   ├── services/                 # logique métier, ports depuis src/services/*.ts existant
│   ├── jobs/                     # workers BullMQ (import CSV, compression image)
│   ├── errors/                   # classes d'erreurs custom + handler centralisé
│   └── app.ts / server.ts
├── prisma -> ../prisma            # même schéma, ne pas dupliquer
└── test/
```

Détails et conventions de code : voir le skill [[express-backend-architecture]].

## Les skills disponibles dans ce dossier

Claude Code les charge automatiquement quand c'est pertinent (`.claude/skills/<nom>/SKILL.md`). Vue d'ensemble :

- **[[civil-status-domain-model]]** — le modèle métier état civil (hiérarchie géographique, table Acte, workflow de statut).
- **[[iucec-identifiant-service]]** — l'algorithme exact de l'identifiant unique à 17 caractères.
- **[[express-backend-architecture]]** — structure de projet, conventions de code, gestion d'erreurs.
- **[[minio-file-storage]]** — stockage objet pour les images d'actes et logos de commune.
- **[[redis-caching-and-queues]]** — cache et files d'attente.
- **[[auth-rbac-security]]** — authentification JWT et contrôle d'accès par rôle.
- **[[logging-monitoring-observability]]** — logs structurés, métriques, health checks.
- **[[api-conventions-and-validation]]** — forme des réponses, validation, inventaire des endpoints existants à migrer.

## Hors périmètre (pour cette version)

- **Pas de code Next.js, pas de composants React** — le frontend reste hors périmètre tant que ce n'est pas demandé explicitement.
- **Pas encore de `package.json` ni de code Express exécutable** — cette étape suivra une fois les skills validées.
- **Pas d'extraction OCR.** Les deux moteurs existants côté Next.js (`extract-text.ts` en Tesseract.js local, `extract-text-ocrspace.ts` en OCR.space hébergé) ne sont **pas portés** dans cette version du backend. `Acte.extractedText` reste un champ texte du schéma mais n'est alimenté par aucun job de ce backend pour l'instant. Ne créez pas de route, de service ou de job d'extraction de texte sans validation explicite du produit — si le besoin revient, il aura probablement sa propre skill dédiée à ce moment-là plutôt que d'être ajouté au fil de l'eau dans les skills existantes.
