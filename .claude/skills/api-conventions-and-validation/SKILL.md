---
name: api-conventions-and-validation
description: Conventions REST du backend (versionnement /api/v1, nommage des ressources en francais, enveloppe de reponse, format d'erreur, pagination, filtres et tri, formats de dates), validation Zod cote serveur en miroir des schemas frontend legacy, generation OpenAPI obligatoire, et inventaire des 40+ endpoints Next.js a migrer. Utiliser pour creer, nommer ou documenter un endpoint, ecrire un schema de validation, choisir un code HTTP, ou planifier la migration d'une route legacy vers Express.
metadata:
  author: sae-backend
  version: 1.1.0
  category: api-design
---

# Conventions API et validation

## Versionnement et nommage des ressources (décisions actées)

- **Toutes les routes vivent sous `/api/v1`.** Pas d'exception, dès la première route. Une future rupture de contrat créera `/api/v2` — jamais de changement cassant silencieux dans v1.
- **Ressources en français, au pluriel, kebab-case** — table canonique :

| Ressource | Base v1 | Legacy correspondant |
|---|---|---|
| Actes | `/api/v1/actes` | `/api/acte`, `/api/updateActe`, `/api/updateDeces`, `/api/lastActe`, `/api/lastDeces` |
| Registres | `/api/v1/registres` | `/api/registre/*`, `/api/registres-sans-actes` |
| Communes | `/api/v1/communes` | `/api/commune/*` |
| Provinces | `/api/v1/provinces` | `/api/province/*` |
| Régions | `/api/v1/regions` | `/api/region/*` |
| Officiers | `/api/v1/officiers` | `/api/officier/*` |
| Utilisateurs | `/api/v1/utilisateurs` | `/api/users`, `/api/users/[id]`, `/api/register` |
| Identifiants IUCEC | `/api/v1/identifiants/{generer,verifier,statistiques}` | `/api/identifiant/*` |
| Auth | `/api/v1/auth/{login,refresh,logout}` | `/api/auth/*` |
| Admin (imports/exports/stats) | `/api/v1/admin/...` | `/api/admin/*` |
| Jobs asynchrones | `/api/v1/jobs/:id` | (nouveau — voir skill `redis-caching-and-queues`) |

La correspondance fine route par route est tenue dans `references/legacy-endpoints-inventory.md` (colonne à compléter au fil du portage). Les routes-adaptateurs à l'ancienne forme, prévues pour la bascule strangler (phase 2, voir `CLAUDE.md`), sont de simples délégations vers les controllers v1 — jamais une deuxième implémentation.

## Forme de réponse

Le code legacy renvoie des formes hétérogènes selon le fichier (`res.status(200).json(users)` ici, `{ success, actesCreees, message }` là, `{ error, message, details }` ailleurs). Le nouveau backend adopte une enveloppe unique :

```ts
// succès
{ "data": ... }
{ "data": [...], "meta": { "page": 1, "pageSize": 50, "total": 4213 } } // listes paginées

// erreur (produite uniquement par le middleware d'erreur central, voir skill express-backend-architecture)
{ "error": { "code": "NOT_FOUND", "message": "Registre introuvable", "requestId": "..." } }
```

`code` vient des classes `AppError` (`NOT_FOUND`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`...) — le frontend (actuel ou futur) distingue les cas sans parser des messages en français. Le `message`, lui, reste en français, cohérent avec le reste de l'app.

## Formats de dates dans les réponses

- **Horodatages techniques** (`createdAt`, `updatedAt`, `identifiant_attribue_le`) : sérialisés en **ISO 8601 UTC** (comportement JSON par défaut des `Date` Prisma). Ne les reformatez pas côté serveur — l'affichage localisé est l'affaire du client.
- **Dates métier** (`date_naissance`, `date_deces`, `date_mariage`, etc.) : ce sont des `String` au format conditionné par `article` (voir skill `civil-status-domain-model`) — renvoyées **telles quelles**, jamais reparsées ni reformatées. Toute « normalisation » casserait la parité avec le legacy.

## Pagination — obligatoire sur toute liste

`getAllActes()` et `getActesByRegistreId()` legacy chargent **la table entière** sans `take`/`skip`, en recompressant chaque image à la volée (voir skill `minio-file-storage` pour la partie image). Dans le nouveau backend, **aucun endpoint de liste ne doit être écrit sans pagination** dès le départ — `?page=1&pageSize=50` (défauts : page 1, pageSize 50, max 200), validé par Zod (`page: z.coerce.number().int().min(1).default(1)`), traduit en `skip`/`take` Prisma. Ce n'est pas une optimisation à ajouter plus tard, c'est une règle d'écriture dès la première version de chaque route de liste.

## Filtres et tri — convention unique

- Filtres : query params nommés comme les champs, en français, validés par Zod avec **whitelist explicite** par ressource. Ex. `GET /api/v1/actes?statut=PENDING&registreId=...&communeId=...`. Un paramètre inconnu → `VALIDATION_ERROR`, pas ignoré silencieusement.
- Tri : `?sort=champ:asc|desc` (un seul champ en v1), whitelist par ressource (ex. `createdAt`, `numero_acte`). Jamais d'interpolation directe d'un paramètre dans un `orderBy`.
- Recherche plein-texte simple : `?q=` quand la ressource le justifie (actes par nom), implémentée en `contains` insensible à la casse — documentée dans l'OpenAPI comme telle.

## OpenAPI — livrable obligatoire, pas une option

L'interopérabilité est un objectif du projet (voir `CLAUDE.md`) : le contrat doit être **lisible par des tiers sans lire le code**.

- Chaque schéma Zod de route est enregistré dans un registre OpenAPI (`src/openapi/`, via `@asteasolutions/zod-to-openapi` ou équivalent maintenu) : une route sans schéma enregistré ne passe pas en revue.
- Le document est servi par le backend : `GET /api/v1/openapi.json` (spec) et `GET /api/v1/docs` (UI Swagger/Scalar), tous deux hors auth mais restreints au réseau interne en production si le produit le demande.
- La CI génère la spec et échoue si la génération casse (voir skill `testing-and-parity`). La spec versionnée suit le code : pas de doc maintenue à la main en parallèle.
- Les codes d'erreur (`error.code`) exposés font partie du contrat : toute nouvelle valeur est ajoutée à l'enum documentée dans la spec.

## Validation Zod — miroir serveur des règles déjà définies côté client

`legacy:src/app/sae/enregistrement/acteSchema.ts` — copie figée vendorée ici : `references/acteSchema.legacy.ts` — définit les règles de saisie d'un acte côté formulaire, avec une règle conditionnelle notable :

```ts
// article === 'le'  → date_naissance doit matcher /^(\d{2})\/(\d{2})\/(\d{4})$/
// article === 'vers' | 'en' → date_naissance doit matcher /^\d{4}$/
```

Cette règle n'existe **que côté client** aujourd'hui — aucune route API legacy ne la revalide. C'est un vrai trou : un appel API direct (hors formulaire) peut écrire une date dans n'importe quel format. Le nouveau backend porte un schéma Zod serveur équivalent (`.superRefine` sur `article`) et l'applique via le middleware `validate()` (skill `express-backend-architecture`) sur toute route de création/édition d'acte — ne faites pas confiance à la validation client seule.

Note d'implémentation : le fichier vendoré contient du texte à l'encodage cassé (`renseignÃ©` au lieu de `renseigné`) dans les messages d'erreur — mojibake d'origine, conservé tel quel dans la copie de référence. En portant ce schéma côté serveur, **écrivez les messages correctement encodés** dans le nouveau code ; la consigne legacy de ne pas « réparer » le mojibake ne vaut que pour les fichiers du dépôt legacy, pas pour du code neuf.

Découpez les schémas selon la structure décrite dans la skill `civil-status-domain-model` (`references/acte-fields.md`) : un schéma par type de registre (`NAISSANCE`/`MARIAGE`/`DECES`), pas un unique schéma géant à 110+ champs optionnels.

## Erreurs et codes HTTP

| Situation | Code | Exemple legacy à corriger |
|---|---|---|
| Ressource introuvable | 404 | plusieurs endpoints legacy renvoient 400 pour un ID introuvable (ex. `commune introuvable` dans l'import CSV) — corriger en 404 ici |
| Corps de requête invalide | 400 | conserver |
| Non authentifié | 401 | inexistant aujourd'hui de façon systématique — RBAC quasi absent au niveau route |
| Authentifié mais rôle insuffisant | 403 | idem |
| Conflit (ex. doublon registre) | 409 | l'unicité `(communeId, centre_registre, numero, annee, type_registre)` doit remonter en 409, pas en 500 générique Prisma |
| Erreur serveur inattendue | 500 | seulement pour l'imprévu, jamais pour une règle métier connue |

Ces corrections de codes (400→404, 500→409) sont des **divergences volontaires** vis-à-vis du legacy : notez-les dans l'inventaire au moment du portage de chaque route concernée, et prévoyez-les dans la normalisation des tests de parité (skill `testing-and-parity`).

## Inventaire des endpoints legacy à migrer

L'API legacy (`legacy:src/pages/api/**`) compte 41 fichiers. Avant d'écrire une route Express, consultez `references/legacy-endpoints-inventory.md` pour vérifier si un équivalent existe déjà et quel service/contrat il faut reproduire — ne redécouvrez pas le contrat d'un endpoint en devinant : le comportement actuel (y compris ses incohérences notées dans l'inventaire) est la spécification de fait tant que le produit ne dit pas explicitement de le changer.
