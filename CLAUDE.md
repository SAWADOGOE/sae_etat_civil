# CLAUDE.md — Backend Express (SAE État Civil)

Ce dépôt est **autonome** : il contient (à terme) l'intégralité du backend Express qui remplace la couche API du projet legacy Next.js. Ce fichier est le seul CLAUDE.md du dépôt et fait autorité ici.

## Le dépôt legacy et comment y accéder

Le projet existant à réécrire vit dans un **autre dépôt** :

- **Dépôt** : `https://github.com/SAWADOGOE/etat_civil_saisie` — **branche `parametres`** (la seule qui fait foi).
- **Convention de notation** : dans ce fichier et dans les skills, `legacy:src/services/acteService.ts` désigne le fichier `src/services/acteService.ts` de ce dépôt-là, branche `parametres`.
- **Accès en session** : si une tâche demande de lire du code legacy et que le dossier `legacy/` n'existe pas encore, clonez-le en lecture seule à la racine de ce dépôt (il est dans `.gitignore`) :
  ```bash
  git clone --depth 1 -b parametres https://github.com/SAWADOGOE/etat_civil_saisie.git legacy
  ```
  Ne modifiez **jamais** rien sous `legacy/` : c'est une référence de lecture, pas un espace de travail.
- Les extraits legacy les plus critiques sont **vendorés** (copiés figés) dans les skills pour fonctionner même sans clone : `.claude/skills/iucec-identifiant-service/references/identifiantService.legacy.ts` et `.claude/skills/api-conventions-and-validation/references/acteSchema.legacy.ts`.

## Où on en est

**Statut : phase de cadrage, aucun code applicatif n'a encore été écrit.** Ce dépôt contient ce fichier, un README d'orientation humaine et des skills Claude Code (`.claude/skills/`) qui encodent l'analyse du legacy et les décisions d'architecture. La consigne produit est claire : ne pas toucher au frontend Next.js du dépôt legacy pour l'instant — on construit uniquement ce backend, ici.

## Pourquoi ce projet existe

Le backend actuel (`legacy:src/pages/api/`, Next.js Pages Router) est réécrit en service Express.js autonome. Trois lacunes concrètes motivent la réécriture — gardez-les en tête, elles justifient chaque choix ci-dessous :

1. **Les images d'actes numérisés sont stockées en base64 dans Postgres** (`Acte.acte_numerisee`, colonne texte) et **recompressées à chaque lecture** (`compressImage` tourne sur *chaque ligne* à chaque `GET /api/acte`, sans pagination). Ça ne passera pas à l'échelle. → skill `minio-file-storage`.
2. **Aucun cache** : les listes de référence (régions/provinces/communes/officiers), quasi statiques, sont requêtées en base à chaque appel. → skill `redis-caching-and-queues`.
3. **Aucune observabilité** : uniquement des `console.log`/`console.error` épars, pas de métriques, pas de health check exploitable en prod. → skill `logging-monitoring-observability`.

## Contraintes non négociables

Le nouveau backend est un **remplacement à l'identique** des règles métier existantes — ce n'est pas l'occasion de les réinventer :

- **Le schéma de données ne change pas de philosophie.** Même hiérarchie `Region → Province → Commune → Registre → Acte`, même table `Acte` large et dénormalisée (~110 champs). Nommage par blocs : `_pere`/`_mere` pour la naissance ; `_epoux`/`_epouse`/`_pere_epoux`/etc. pour le mariage ; pour le décès, le défunt **réutilise les champs communs** (`nom`, `prenom`, `date_naissance`…) complétés par quelques champs suffixés (`profession_defunt`, `domicile_defunt`, `nom_declarant`…) — il n'existe **pas** de préfixe `_defunt` généralisé. Détails : skill `civil-status-domain-model`.
- **L'algorithme IUCEC (identifiant à 17 caractères) doit être reproduit bit pour bit**, y compris la clé de contrôle Luhn modifié `% 97`. Toute divergence casse la compatibilité avec les identifiants déjà attribués. Des **vecteurs de test vérifiés contre le code legacy** existent et sont obligatoires : skill `iucec-identifiant-service` et skill `testing-and-parity`.
- **`IdentifiantSequence` reste l'unique source de vérité** pour le prochain `numero_ordre`, via un `UPDATE ... increment` atomique. Ne jamais le recalculer par un `COUNT()`, ne jamais le mettre en cache Redis comme source de décision.
- **La contrainte d'unicité du Registre** `(communeId, centre_registre, numero, annee, type_registre)` reste en vigueur — `centre_registre` a un défaut `"PRINCIPAL"`, ne l'omettez jamais des requêtes.
- **Les dates métier restent des `String`.** `date_naissance`, `date_deces`, `date_mariage`, `date_etablissement`, etc. sont des chaînes dont le format dépend de `article` (`le` → `jj/mm/aaaa`, `vers`/`en` → `aaaa`). Ne les convertissez **jamais** en `DateTime` Prisma ou en `Date` JS « pour moderniser » : cela casserait les données saisies, le frontend et la règle métier conditionnelle. Seuls les horodatages techniques (`createdAt`, `updatedAt`, `identifiant_attribue_le`) sont de vrais `DateTime`.
- **Pas de suppression physique d'un `Acte` ou d'un `Registre` via l'API.** La « suppression » côté nouveau backend = passage au statut `ARCHIVED` + entrée d'audit. Détails et exceptions : skill `civil-status-domain-model`, section « Politique de suppression ».
- **Aucun secret versionné, jamais.** `.env` est dans `.gitignore` ; seul `.env.example` (valeurs factices) est commité. Contexte : le dépôt legacy a exposé une clé de compte de service Google Cloud et un `NEXTAUTH_SECRET` en clair — ces valeurs sont considérées compromises et ne doivent **jamais** être réutilisées ici. Détails : skill `auth-rbac-security`, section « Secrets ».

## Gouvernance du schéma Prisma (décision structurante)

Les deux dépôts étant séparés, il faut un unique propriétaire du schéma. **C'est ce dépôt.**

- `prisma/schema.prisma` et `prisma/migrations/` vivent **ici** : au bootstrap, copiez `legacy:prisma/schema.prisma` et `legacy:prisma/migrations/` tels quels (commit dédié « import du schéma legacy », zéro modification), puis toute évolution ultérieure (ex. `acte_numerisee` → clé MinIO, table `RefreshToken`, table `JournalAudit`) se fait **ici** par migration Prisma classique, documentée et réversible.
- Le dépôt legacy devient **lecteur** du schéma : sa copie ne reçoit plus de nouvelle migration. Au moment de la bascule production, désactivez `prisma migrate deploy` dans `legacy:entrypoint.sh` — les migrations ne s'appliquent plus que depuis ce backend. D'ici là, si une migration urgente devait partir du legacy, elle doit être répliquée ici immédiatement (à éviter : préférez la faire ici directement, la base est partagée).
- Ce backend est une réécriture de la **couche API**, pas une migration de données : on se branche sur la base PostgreSQL existante.

## Stack technique cible

Ce tableau est **la** source de vérité des choix de stack (les skills y renvoient, ne le dupliquez pas ailleurs) :

| Domaine | Choix | Pourquoi |
|---|---|---|
| Runtime | Node.js 22 LTS (`.nvmrc` + `engines`), TypeScript 5.x strict | aligné avec le frontend existant |
| Framework HTTP | Express 5 | gestion native des erreurs async, dernière branche stable |
| ORM | Prisma (schéma désormais propriété de ce dépôt, voir gouvernance) | zéro migration de données |
| Validation | Zod | même bibliothèque que `legacy:src/app/sae/enregistrement/acteSchema.ts` — les règles métier (ex. format de date selon `article`) se portent telles quelles |
| Stockage fichiers | MinIO (SDK `minio`, compatible S3) | remplace le base64 en base ; skill `minio-file-storage` |
| Cache & files d'attente | Redis (`ioredis` + BullMQ) | cache de référence + jobs d'import/traitement d'image ; skill `redis-caching-and-queues` |
| Auth | JWT maison (`jsonwebtoken` + `bcryptjs`) + refresh tokens persistés | remplace NextAuth ; skill `auth-rbac-security` |
| Logs | Pino + `pino-http` | logs structurés JSON, redaction des champs sensibles |
| Monitoring | `prom-client` (`/metrics`) + OpenTelemetry (optionnel) | skill `logging-monitoring-observability` |
| Tests | Vitest + Supertest + Testcontainers | skill `testing-and-parity` |
| Doc d'API | OpenAPI générée depuis les schémas Zod — **livrable obligatoire** | interopérabilité ; skill `api-conventions-and-validation` |
| Package manager | npm | cohérent avec le legacy (`npm ci` dans son Dockerfile) |

Structure de dossiers, conventions de code, Docker de dev : skill `express-backend-architecture` (source de vérité pour ces sujets — non répétés ici).

## API : décisions de contrat

- **Toutes les routes sous `/api/v1`.** Le versionnement d'URL est acté dès la première route.
- **Ressources en français, au pluriel, kebab-case** : `/api/v1/actes`, `/registres`, `/communes`, `/provinces`, `/regions`, `/officiers`, `/utilisateurs`, `/identifiants/...`, `/auth/...`. Table de correspondance legacy → v1 : tenue dans l'inventaire de la skill `api-conventions-and-validation`.
- Enveloppe de réponse, format d'erreur, pagination obligatoire, conventions de filtres/tri, OpenAPI : skill `api-conventions-and-validation`.

## Qualité et CI — non négociable

Le legacy a `next.config.ts` qui **avale** les erreurs TypeScript et ESLint au build (`ignoreBuildErrors`). Ce péché originel ne se reproduit pas ici :

- CI bloquante sur : `tsc --noEmit`, `eslint .`, `vitest run` (unitaires + intégration), build Docker.
- Aucune option de build qui masque des erreurs. Un `tsc` rouge = PR rouge.
- Toute route portée doit être couverte par au moins un test d'intégration **avant** d'être cochée « migrée » dans l'inventaire — règle détaillée dans la skill `testing-and-parity`.
- Tout le nommage (identifiants de code, messages d'erreur, copies API) reste **en français**, comme dans le legacy. Préservez ce choix en éditant.

## Stratégie de bascule (strangler fig)

Le frontend Next.js ne doit pas être modifié tant que la phase 1 n'est pas terminée et validée.

1. **Phase 1 — construction à blanc** : ce backend est développé complet, testé (unitaires, intégration, parité contre le legacy tournant en local — voir skill `testing-and-parity`), sans aucun changement côté legacy.
2. **Phase 2 — couche de compatibilité** : en plus des routes `/api/v1/*`, ce backend expose des routes-adaptateurs à l'ancienne forme (`/api/acte`, `/api/registre/...`) qui délèguent aux mêmes controllers v1. Ainsi la bascule ne demande **aucune modification des composants** frontend.
3. **Phase 3 — bascule route par route** : des `rewrites` dans `legacy:next.config.ts` redirigent les chemins `/api/*` choisis vers ce backend, un groupe de routes à la fois (ordre conseillé : référentiels géo → auth → registres → actes lecture → actes écriture/upload → imports/exports/statistiques). Chaque groupe basculé est observé (logs, métriques, erreurs) avant le suivant. C'est la seule modification legacy autorisée, et elle nécessite validation produit explicite.
4. **Phase 4 — nettoyage** : le frontend migre vers `/api/v1` natif, les adaptateurs sont supprimés, les handlers `legacy:src/pages/api/*` sont retirés, `prisma migrate deploy` est désactivé côté legacy (voir gouvernance).

## Les skills disponibles dans ce dépôt

Chargées automatiquement quand c'est pertinent. Chemin : `.claude/skills/<nom>/SKILL.md`.

- **civil-status-domain-model** — modèle métier état civil (hiérarchie géographique, table Acte, workflow de statut, dates String, politique de suppression).
- **iucec-identifiant-service** — algorithme exact de l'identifiant unique à 17 caractères + vecteurs de test vérifiés.
- **express-backend-architecture** — structure de projet, conventions de code, gestion d'erreurs, Docker de dev.
- **testing-and-parity** — stratégie de tests, base de test, tests de parité contre le legacy, CI.
- **minio-file-storage** — stockage objet pour les images d'actes et logos de commune.
- **redis-caching-and-queues** — cache et files d'attente.
- **auth-rbac-security** — authentification JWT + refresh, RBAC, audit trail, secrets, conformité données personnelles.
- **logging-monitoring-observability** — logs structurés, métriques, health checks.
- **api-conventions-and-validation** — versionnement, forme des réponses, validation, OpenAPI, inventaire des endpoints legacy à migrer.

## Hors périmètre (pour cette version)

- **Pas de code Next.js, pas de composants React** — le frontend reste hors périmètre tant que ce n'est pas demandé explicitement (voir la stratégie de bascule pour la seule exception, phase 3).
- **Pas d'extraction OCR.** Les deux moteurs existants côté legacy (`legacy:src/pages/api/extract-text.ts` en Tesseract.js local, `legacy:src/pages/api/extract-text-ocrspace.ts` en OCR.space hébergé) ne sont **pas portés**. `Acte.extractedText` reste un champ texte du schéma mais n'est alimenté par aucun job de ce backend. Ne créez pas de route, de service ou de job d'extraction de texte sans validation explicite du produit — si le besoin revient, il aura sa propre skill dédiée à ce moment-là.
- **Pas de purge/refonte du dépôt legacy** depuis ce dépôt : les actions de nettoyage et de sécurité côté legacy sont listées à part et exécutées manuellement par le propriétaire du projet.
