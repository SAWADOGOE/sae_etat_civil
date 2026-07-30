# Inventaire des endpoints legacy (`legacy:src/pages/api`)

Source : dépôt `SAWADOGOE/etat_civil_saisie`, **branche `parametres`**, dossier `src/pages/api` (41 fichiers au moment du relevé). Pour lire un fichier source : clonez le legacy dans `./legacy/` comme décrit dans `CLAUDE.md`, section « Le dépôt legacy ».

Les entrées marquées **[vérifié]** ont été lues intégralement et leur comportement ci-dessous est fiable. Les entrées marquées **[à relire]** sont listées par nom de fichier uniquement — **lisez le fichier source avant de porter la route**, ne devinez pas son contrat à partir du nom seul.

Ce document sert aussi de **suivi de migration** : une fois une route portée et testée, barrez-la et notez sa cible (`~~fichier~~ → migré vers GET /api/v1/... — divergences: ...`). Les routes v1 cibles suivent la table de nommage de `SKILL.md`.

## Auth

| Fichier | Rôle |
|---|---|
| `auth/[...nextauth].ts` | **[vérifié]** Catch-all NextAuth, provider credentials, callback `authorize` qui rappelle `signin.ts` en HTTP interne. Voir skill `auth-rbac-security` pour le remplacement (login direct + refresh tokens). Cible : `POST /api/v1/auth/login`. |
| `auth/signin.ts` | **[à relire]** Valide email/mot de passe contre la table `User`, appelé par `authorize`. C'est la logique à porter directement dans `services/authService.ts`. |
| `register.ts` | **[à relire]** Probable création de compte utilisateur — vérifier si accessible publiquement ou réservé ADMIN avant de porter tel quel. Cible probable : `POST /api/v1/utilisateurs` (ADMIN). |

## Utilisateurs

| Fichier | Rôle |
|---|---|
| `users.ts` | **[vérifié]** `GET` → liste des `User` avec `_count.actes`. Ne retourne pas `password` (bon comportement à conserver). Contient aussi un export `GET` App-Router mort (deux handlers dans le même fichier ; seul le handler Pages Router est réellement servi) — ne pas porter ce deuxième handler. Cible : `GET /api/v1/utilisateurs`. |
| `users/[id].ts` | **[à relire]** CRUD utilisateur par id. |

## Géographie (Region / Province / Commune / Officier)

| Fichier | Rôle |
|---|---|
| `region/index.ts`, `region/[id].ts` | **[à relire]** CRUD Region. Candidats prioritaires au cache Redis, voir skill `redis-caching-and-queues`. |
| `province/index.ts`, `province/[id].ts` | **[à relire]** CRUD Province. Idem. |
| `commune/index.ts`, `commune/[id].ts` | **[à relire]** CRUD Commune — attention aux champs `code_commune`/`code_ecc` (uniques), voir skill `civil-status-domain-model`. |
| `commune/upload-logo.ts` | **[à relire]** Upload du logo de commune — candidat direct à la migration MinIO, voir skill `minio-file-storage`. |
| `officier/index.ts`, `officier/[id].ts` | **[à relire]** CRUD Officier, rattaché optionnellement à une Commune. |

## Registre

| Fichier | Rôle |
|---|---|
| `registre/index.ts` | **[à relire]** Probable liste/création — croiser avec `legacy:src/services/registreService.ts` (`createRegistre`, `listRegistresByCommune`) déjà lu ; contrainte d'unicité à respecter (skill `civil-status-domain-model`). |
| `registre/[id].ts`, `registre/getRegistre.ts`, `registre/show/[id].ts` | **[à relire]** Trois façons différentes de lire un registre — à unifier en une seule route `GET /api/v1/registres/:id` plutôt que de porter la redondance. |
| `registre/edit.ts`, `registre/updateRegistre.ts` | **[à relire]** Deux chemins de mise à jour redondants — même remarque, unifier en `PUT /api/v1/registres/:id`. |
| `registre/affecter.ts` | **[à relire]** Probable affectation d'un registre à un agent/commune — vérifier le contrat exact avant de porter, et documenter le concept dans la skill `civil-status-domain-model` (question ouverte déjà notée là-bas). |
| `registres-sans-actes.ts` | **[à relire]** Liste des registres sans acte rattaché — utile pour le tableau de bord. |

## Acte

| Fichier | Rôle |
|---|---|
| `acte/index.ts` | **[vérifié]** `POST` → upload multipart (formidable), compression Sharp, génération d'identifiant IUCEC par fichier, gère le mode « multi-page » (fusion recto-verso, forcé pour `MARIAGE`) via `fusionnerRectoVerso`. `GET` → liste **non paginée**, recompresse chaque image à la volée. Endpoint le plus impacté par la migration MinIO/pagination, voir skill `minio-file-storage`. |
| `acte/[id].ts` | **[à relire]** Lecture/suppression d'un acte par id. ⚠️ Si le `DELETE` legacy supprime physiquement : divergence volontaire côté v1 (archivage + audit, jamais de delete) — voir « Politique de suppression » dans la skill `civil-status-domain-model`. |
| `acte/edit.ts` | **[à relire]** Édition — croiser avec `acteService.updateActe` déjà lu (accepte un `Partial<...>`, vérifie l'existence avant update). |
| `acte/admin-create.ts` | **[à relire]** Création côté admin — probablement la saisie multi-images/auto-validation mentionnée dans l'historique git du legacy. Vérifier si cette route diverge de `acte/index.ts` avant de les fusionner ou non. |
| `updateActe.ts` | **[à relire]** Encore un chemin de mise à jour d'acte, distinct de `acte/edit.ts` — clarifier lequel est réellement utilisé par le frontend avant de porter les deux. |
| `updateDeces.ts` | **[à relire]** Mise à jour spécifique décès. |
| `lastActe.ts`, `lastDeces.ts` | **[à relire]** Probablement « dernier acte/décès saisi » pour pré-remplissage ou affichage dashboard. |

## Identifiant IUCEC

| Fichier | Rôle |
|---|---|
| `identifiant/generer.ts` | **[à relire]** Doit appeler `genererIdentifiantUnique`/`genererIdentifiantPourRegistre`, voir skill `iucec-identifiant-service`. Cible : `POST /api/v1/identifiants/generer`. |
| `identifiant/verifier.ts` | **[à relire]** Doit appeler `validerIdentifiant`. Cible : `POST /api/v1/identifiants/verifier`. |
| `identifiant/statistiques.ts` | **[à relire]** Doit appeler `obtenirStatistiques` — bon candidat de cache court (1–5 min), voir skill `redis-caching-and-queues`. |

## Admin (import / export / statistiques)

| Fichier | Rôle |
|---|---|
| `admin/actes/import.ts` | **[vérifié]** Import CSV multipart, upsert du registre par ligne, génère un identifiant IUCEC si absent du CSV, vérifie que le validateur est ADMIN si `autoValidate`, traite le fichier ligne par ligne de façon synchrone et retourne `{ importedCount, failedCount, errors }`. Candidat prioritaire pour la file BullMQ `csv-import`, voir skill `redis-caching-and-queues`. |
| `admin/actes/export.ts` | **[à relire]** Export CSV — miroir probable du mapping de champs utilisé par `import.ts` ; réutilisez le même mapping (voir `../../civil-status-domain-model/references/acte-fields.md`) pour éviter la divergence entre import et export. Export à journaliser dans l'audit (skill `auth-rbac-security`). |
| `admin/actes/index.ts` | **[à relire]** Vue admin de la liste des actes (probablement avec filtres/pagination déjà côté frontend, à vérifier). |
| `admin/statistiques/export.ts` | **[à relire]** Export de statistiques. |

## Archivage

| Fichier | Rôle |
|---|---|
| `archivage/actes.ts` | **[à relire]** Probable filtre `status: ARCHIVED` sur `Acte`. |
| `archivage/registres.ts` | **[à relire]** Équivalent pour `Registre`. |

## OCR (hors périmètre)

`extract-text.ts` (Tesseract.js local) et `extract-text-ocrspace.ts` (OCR.space hébergé) existent côté legacy mais **ne sont pas portés** — voir la section « Hors périmètre » de `CLAUDE.md`. Ne créez pas de route Express équivalente sans en discuter d'abord.

## Méthode de travail recommandée

1. Avant de porter une route marquée **[à relire]**, ouvrez le fichier source correspondant (`legacy/src/pages/api/...`) et mettez à jour sa ligne du tableau (comportement réel, cas limites) — traitez ce document comme vivant, pas figé.
2. Repérez les doublons évidents (`registre/edit.ts` vs `registre/updateRegistre.ts`, `acte/edit.ts` vs `updateActe.ts`, trois façons de lire un registre) : demandez confirmation au produit avant de choisir laquelle porter — il est possible que le frontend actuel utilise les deux dans des contextes différents.
3. Une route n'est cochée « migrée » ici qu'après : test d'intégration écrit et vert (skill `testing-and-parity`), schéma enregistré dans l'OpenAPI, divergences volontaires (codes HTTP corrigés, suppression→archivage…) notées sur sa ligne.
