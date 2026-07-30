---
name: api-conventions-and-validation
description: Conventions REST du backend, forme des reponses JSON, format d'erreur, pagination, validation Zod cote serveur en miroir des schemas frontend comme acteSchema.ts, et inventaire des 40+ endpoints Next.js existants a migrer. Utiliser pour creer ou documenter un endpoint, ecrire un schema de validation, ou planifier la migration d'une route legacy vers Express.
metadata:
  author: sae-backend
  version: 1.0.0
  category: api-design
---

# Conventions API et validation

## Forme de réponse

Le code actuel renvoie des formes hétérogènes selon le fichier (`res.status(200).json(users)` ici, `{ success, actesCreees, message }` là, `{ error, message, details }` ailleurs). Le nouveau backend adopte une enveloppe unique :

```ts
// succès
{ "data": ... }
{ "data": [...], "meta": { "page": 1, "pageSize": 50, "total": 4213 } } // listes paginées

// erreur (produite uniquement par le middleware d'erreur central, voir [[express-backend-architecture]])
{ "error": { "code": "NOT_FOUND", "message": "Registre introuvable", "requestId": "..." } }
```

`code` vient des classes `AppError` (`NOT_FOUND`, `VALIDATION_ERROR`, `UNAUTHORIZED`, `FORBIDDEN`, `CONFLICT`...) — le frontend (actuel ou futur) peut alors distinguer les cas sans parser des messages en français. Le `message`, lui, reste en français, cohérent avec le reste de l'app.

## Pagination — obligatoire sur toute liste

`getAllActes()` et `getActesByRegistreId()` aujourd'hui chargent **la table entière** sans `take`/`skip`, en recompressant chaque image à la volée (voir [[minio-file-storage]] pour la partie image). Dans le nouveau backend, **aucun endpoint de liste ne doit être écrit sans pagination** dès le départ — `?page=1&pageSize=50`, validé par Zod (`page: z.coerce.number().int().min(1).default(1)`), traduit en `skip`/`take` Prisma. Ce n'est pas une optimisation à ajouter plus tard, c'est une règle d'écriture dès la première version de chaque route de liste.

## Validation Zod — miroir serveur des règles déjà définies côté client

`../src/app/sae/enregistrement/acteSchema.ts` définit déjà les règles de saisie d'un acte côté formulaire, avec une règle conditionnelle notable :

```ts
// article === 'le'  → date_naissance doit matcher /^(\d{2})\/(\d{2})\/(\d{4})$/
// article === 'vers' | 'en' → date_naissance doit matcher /^\d{4}$/
```

Cette règle n'existe **que côté client** aujourd'hui — aucune route API actuelle ne la revalide. C'est un vrai gap : un appel API direct (hors formulaire) peut aujourd'hui écrire une date dans n'importe quel format. Le nouveau backend doit porter un schéma Zod serveur équivalent (`.superRefine` sur `article`) et l'appliquer via le middleware `validate()` (voir [[express-backend-architecture]]) sur toute route de création/édition d'acte — ne faites pas confiance à la validation client seule.

Note d'implémentation : le fichier source contient du texte avec un encodage cassé (`renseignÃ©` au lieu de `renseigné`) dans les messages d'erreur. En portant ce schéma côté serveur, **corrigez l'encodage** (ce n'est pas le fichier frontend visé par l'avertissement de non-modification du `CLAUDE.md` racine, qui concerne uniquement les fichiers existants dans `src/`) plutôt que de reproduire le mojibake dans le nouveau code.

Découpez les schémas selon la structure décrite dans [[civil-status-domain-model]] (`references/acte-fields.md`) : un schéma par type de registre (`NAISSANCE`/`MARIAGE`/`DECES`), pas un unique schéma géant à 150 champs optionnels.

## Erreurs et codes HTTP

| Situation | Code | Exemple actuel à corriger |
|---|---|---|
| Ressource introuvable | 404 | plusieurs endpoints actuels renvoient 400 pour un ID introuvable (ex. `commune introuvable` dans l'import CSV) — à corriger en 404 dans le nouveau backend |
| Corps de requête invalide | 400 | conserver |
| Non authentifié | 401 | inexistant aujourd'hui de façon systématique — RBAC entièrement absent au niveau route |
| Authentifié mais rôle insuffisant | 403 | idem |
| Conflit (ex. doublon registre) | 409 | l'unicité `(communeId, centre_registre, numero, annee, type_registre)` doit remonter en 409, pas en 500 générique Prisma |
| Erreur serveur inattendue | 500 | seulement pour l'imprévu, jamais pour une règle métier connue |

## Inventaire des endpoints existants à migrer

L'API actuelle (`../src/pages/api/**`) compte plus de 40 fichiers. Avant d'écrire une route Express, consultez `references/legacy-endpoints-inventory.md` pour vérifier si un équivalent existe déjà côté Next.js et quel service/contrat il faut reproduire — ne redécouvrez pas le contrat d'un endpoint en devinant, le comportement actuel (y compris ses incohérences notées dans l'inventaire) est la spécification de fait tant que le produit ne dit pas explicitement de le changer.
