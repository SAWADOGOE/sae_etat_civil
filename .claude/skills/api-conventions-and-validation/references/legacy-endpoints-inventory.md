# Inventaire des endpoints legacy (`../../../src/pages/api`)

Relevé au moment de la rédaction de ce skill. Les entrées marquées **[vérifié]** ont été lues intégralement et leur comportement ci-dessous est fiable. Les entrées marquées **[à relire]** sont listées par nom de fichier uniquement — **lisez le fichier source avant de porter la route**, ne devinez pas son contrat à partir du nom seul.

## Auth

| Fichier | Rôle |
|---|---|
| `auth/[...nextauth].ts` | **[vérifié]** Catch-all NextAuth, provider credentials, callback `authorize` qui rappelle `signin.ts` en HTTP interne. Voir [[auth-rbac-security]] pour le remplacement JWT direct. |
| `auth/signin.ts` | **[à relire]** Valide email/mot de passe contre la table `User`, appelé par `authorize`. C'est la logique à porter directement dans `services/authService.ts`. |
| `register.ts` | **[à relire]** Probable création de compte utilisateur — vérifier si accessible publiquement ou réservé ADMIN avant de porter tel quel. |

## Utilisateurs

| Fichier | Rôle |
|---|---|
| `users.ts` | **[vérifié]** `GET` → liste des `User` avec `_count.actes`. Ne retourne pas `password` (bon comportement à conserver). Contient aussi un export `GET` App-Router mort code (deux handlers dans le même fichier, l'un Pages Router utilisé, l'autre App Router probablement jamais appelé vu que ce projet route les API via Pages Router) — ne pas porter ce deuxième handler. |
| `users/[id].ts` | **[à relire]** CRUD utilisateur par id. |

## Géographie (Region / Province / Commune / Officier)

| Fichier | Rôle |
|---|---|
| `region/index.ts`, `region/[id].ts` | **[à relire]** CRUD Region. Candidats prioritaires au cache Redis, voir [[redis-caching-and-queues]]. |
| `province/index.ts`, `province/[id].ts` | **[à relire]** CRUD Province. Idem. |
| `commune/index.ts`, `commune/[id].ts` | **[à relire]** CRUD Commune — attention aux champs `code_commune`/`code_ecc` (uniques), voir [[civil-status-domain-model]]. |
| `commune/upload-logo.ts` | **[à relire]** Upload du logo de commune — candidat direct à la migration MinIO, voir [[minio-file-storage]]. |
| `officier/index.ts`, `officier/[id].ts` | **[à relire]** CRUD Officier, rattaché optionnellement à une Commune. |

## Registre

| Fichier | Rôle |
|---|---|
| `registre/index.ts` | **[à relire]** Probable liste/création — croiser avec `registreService.ts` (`createRegistre`, `listRegistresByCommune`) déjà lu, voir [[civil-status-domain-model]] pour la contrainte d'unicité à respecter. |
| `registre/[id].ts`, `registre/getRegistre.ts`, `registre/show/[id].ts` | **[à relire]** Trois façons différentes de lire un registre — à unifier en une seule route `GET /registres/:id` dans le nouveau backend plutôt que de porter la redondance. |
| `registre/edit.ts`, `registre/updateRegistre.ts` | **[à relire]** Deux chemins de mise à jour redondants — même remarque, unifier en `PUT /registres/:id`. |
| `registre/affecter.ts` | **[à relire]** Probable affectation d'un registre à un agent/commune — vérifier le contrat exact avant de porter. |
| `registres-sans-actes.ts` | **[à relire]** Liste des registres sans acte rattaché — utile pour le tableau de bord. |

## Acte

| Fichier | Rôle |
|---|---|
| `acte/index.ts` | **[vérifié]** `POST` → upload multipart (formidable), compression Sharp, génération d'identifiant IUCEC par fichier, gère le mode "multi-page" (fusion recto-verso, forcé pour `MARIAGE`) via `fusionnerRectoVerso`. `GET` → liste **non paginée**, recompresse chaque image à la volée si `registreId` est fourni ou non. C'est l'endpoint le plus impacté par la migration MinIO/pagination, voir [[minio-file-storage]] et la section pagination de ce skill. |
| `acte/[id].ts` | **[à relire]** Lecture/suppression d'un acte par id. |
| `acte/edit.ts` | **[à relire]** Édition — croiser avec `acteService.updateActe` déjà lu (accepte un `Partial<...>`, vérifie l'existence avant update). |
| `acte/admin-create.ts` | **[à relire]** Création côté admin — probablement la saisie multi-images/auto-validation mentionnée dans l'historique git récent du dépôt (`casse composée noms/prénoms, saisie d'acte admin (multi-images, auto-validation)`). Vérifier si cette route diverge de `acte/index.ts` avant de les fusionner ou non dans le nouveau backend. |
| `updateActe.ts` | **[à relire]** Encore un chemin de mise à jour d'acte, distinct de `acte/edit.ts` — clarifier lequel est réellement utilisé par le frontend avant de porter les deux. |
| `updateDeces.ts` | **[à relire]** Mise à jour spécifique décès. |
| `lastActe.ts`, `lastDeces.ts` | **[à relire]** Probablement "dernier acte/décès saisi" pour pré-remplissage ou affichage dashboard. |

## Identifiant IUCEC

| Fichier | Rôle |
|---|---|
| `identifiant/generer.ts` | **[à relire]** Doit appeler `genererIdentifiantUnique`/`genererIdentifiantPourRegistre`, voir [[iucec-identifiant-service]]. |
| `identifiant/verifier.ts` | **[à relire]** Doit appeler `validerIdentifiant`. |
| `identifiant/statistiques.ts` | **[à relire]** Doit appeler `obtenirStatistiques` — bon candidat de cache court (1–5 min), voir [[redis-caching-and-queues]]. |

## Admin (import / export / statistiques)

| Fichier | Rôle |
|---|---|
| `admin/actes/import.ts` | **[vérifié]** Import CSV multipart, upsert du registre par ligne, génère un identifiant IUCEC si absent du CSV, vérifie que le validateur est ADMIN si `autoValidate`, traite le fichier ligne par ligne de façon synchrone et retourne `{ importedCount, failedCount, errors }`. Candidat prioritaire pour la file BullMQ `csv-import`, voir [[redis-caching-and-queues]]. |
| `admin/actes/export.ts` | **[à relire]** Export CSV — miroir probable du mapping de champs utilisé par `import.ts` ; réutilisez le même mapping des ~150 champs (voir `../civil-status-domain-model/references/acte-fields.md`) pour éviter la divergence entre import et export. |
| `admin/actes/index.ts` | **[à relire]** Vue admin de la liste des actes (probablement avec filtres/pagination déjà côté frontend, à vérifier). |
| `admin/statistiques/export.ts` | **[à relire]** Export de statistiques. |

## Archivage

| Fichier | Rôle |
|---|---|
| `archivage/actes.ts` | **[à relire]** Probable filtre `status: ARCHIVED` sur `Acte`. |
| `archivage/registres.ts` | **[à relire]** Équivalent pour `Registre`. |

## OCR (hors périmètre)

`extract-text.ts` (Tesseract.js local) et `extract-text-ocrspace.ts` (OCR.space hébergé) existent côté Next.js mais **ne sont pas portés dans cette version du backend** — voir la section « Hors périmètre » de `../../../CLAUDE.md`. Ne créez pas de route Express équivalente sans en discuter d'abord.

## Méthode de travail recommandée

1. Avant de porter une route marquée **[à relire]**, ouvrez le fichier source correspondant et mettez à jour cette ligne du tableau (comportement réel, cas limites) — traitez ce document comme vivant, pas figé.
2. Repérez les doublons évidents (`registre/edit.ts` vs `registre/updateRegistre.ts`, `acte/edit.ts` vs `updateActe.ts`, trois façons de lire un registre) : demandez confirmation au produit avant de choisir laquelle porter, plutôt que d'en garder une au hasard — il est possible que le frontend actuel utilise les deux dans des contextes différents.
3. Une fois une route portée et testée, cochez-la ici (`~~fichier~~ → migré vers POST /v1/...`) pour que ce document serve aussi de suivi de migration.
