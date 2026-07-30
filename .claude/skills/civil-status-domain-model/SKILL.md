---
name: civil-status-domain-model
description: Explique le modele metier de l'etat civil burkinabe (Region -> Province -> Commune -> Registre -> Acte, workflow de statut, champs par type d'acte naissance/mariage/deces, dates metier en String, politique de suppression) tel qu'il existe dans le schema Prisma. Utiliser des qu'une tache touche au modele de donnees, a la creation/validation/suppression d'un acte, au workflow PENDING/COMPLETED/REJECTED/ARCHIVED, a la contrainte d'unicite d'un registre, ou qu'on ecrit une route/service/migration manipulant Acte, Registre, Commune, Province, Region, Officier ou User — meme pour une simple requete de lecture.
metadata:
  author: sae-backend
  version: 1.1.0
  category: domain-knowledge
---

# Modèle métier — état civil (naissance / mariage / décès)

Cette skill décrit le modèle de données **tel qu'il existe déjà** dans `prisma/schema.prisma` de ce dépôt (importé du legacy, désormais propriété de ce dépôt — voir « Gouvernance du schéma » dans `CLAUDE.md` ; tant que l'import n'a pas eu lieu, la référence est `legacy:prisma/schema.prisma`). Le backend Express doit exposer ce modèle, pas le redessiner. Toute divergence de nommage ou de structure casse la compatibilité avec les données déjà saisies.

## Hiérarchie géographique

```
Region (1) → Province (N) → Commune (N) → Registre (N) → Acte (N)
```

- `Region.code_region`, `Province.code_province`, `Commune.code_commune` : codes de **10 caractères**, uniques, à but de référence/reporting. Ils ne servent **pas** à construire l'identifiant IUCEC.
- `Commune.code_ecc` : code de **7 caractères**, unique, c'est celui-là (et uniquement celui-là) qui entre dans la composition de l'identifiant unique — voir la skill `iucec-identifiant-service`.
- `Commune.logo` : aujourd'hui probablement une chaîne (chemin ou base64) ; candidat direct à la migration vers MinIO, voir la skill `minio-file-storage`.
- `Officier` (nom, prenom, fonction) est optionnellement rattaché à une `Commune` — c'est l'officier d'état civil qui signe/valide les actes de cette commune.

## Registre

Un registre représente un cahier physique de la commune pour une année et un type d'acte donné.

```ts
// Contrainte d'unicité — NE JAMAIS l'omettre dans les requêtes de lookup/upsert
@@unique([communeId, centre_registre, numero, annee, type_registre])
```

- `centre_registre` a une valeur par défaut `"PRINCIPAL"` — un même numéro/année/type peut exister dans plusieurs centres secondaires d'une même commune. Toujours normaliser en majuscules et `.trim()` avant comparaison (`legacy:src/services/registreService.ts` le fait déjà via `.trim().toUpperCase()`, reproduire ce comportement).
- `type_registre` : enum `NAISSANCE | MARIAGE | DECES` — détermine quels champs de `Acte` sont pertinents pour les actes rattachés à ce registre.

### Affectation registre ↔ agent : question ouverte

Le legacy expose `legacy:src/pages/api/registre/affecter.ts`, ce qui suggère un concept d'affectation d'un registre à un agent ou à une commune. Ce concept n'est **pas** encore décrit ici car son contrat exact n'a pas été relu. Avant de porter cette route : lisez le fichier source, documentez ici ce que l'affectation signifie réellement (données touchées, effet sur les droits), et n'inventez **pas** un modèle de permission par affectation qui n'existerait pas dans le code — voir aussi la question des permissions par commune dans la skill `auth-rbac-security`.

## Acte — une table large, pas une table par type

`Acte` est **une seule table dénormalisée** (~110 champs scalaires) qui porte les champs des trois types d'actes. Ce choix est intentionnel et existant : **ne créez pas de nouvelle table par type d'acte**, ajoutez plutôt un champ en suivant le pattern de nommage déjà en place.

### Champs partagés (réutilisés entre naissance et décès)

`prenom`, `nom`, `date_naissance`, `heure`, `lieu_naissance`, `sexe` sont **doublement utilisés** :
- pour un acte de **naissance** : identité de l'enfant.
- pour un acte de **décès** : identité du défunt (en complément de `date_deces`, `heure_deces`, `lieu_deces`, `profession_defunt`, `domicile_defunt`, `heure_naissance`). Notez qu'il n'existe **pas** de préfixe `_defunt` généralisé — seuls quelques champs spécifiques le portent en suffixe.

C'est une source de confusion fréquente : avant d'écrire une requête ou un DTO, vérifiez toujours le `type_registre` du registre parent pour savoir comment interpréter ces champs.

### Naissance — champs des parents

Préfixe `_pere` / `_mere` : `nom_pere`, `prenom_pere`, `date_naissance_pere`, `lieu_naissance_pere`, `profession_pere`, `domicile_pere` (symétrique pour `_mere`).

### Décès — déclarant et conjoint

`nom_declarant`, `prenom_declarant`, `qualite_declarant` ; `situation_matrimoniale`, `date_mariage`, `nom_conjoint`, `prenom_conjoint`, et `conjoints` (JSON sérialisé en `String` pour les conjoints multiples — désérialiser avec précaution côté Express, ce n'est pas un vrai type JSON Prisma).

### Mariage — namespacé `_epoux` / `_epouse`

Chaque bloc d'identité (`epoux`, `epouse`, `pere_epoux`, `mere_epoux`, `pere_epouse`, `mere_epouse`, `temoin_epoux`, `temoin_epouse`) répète le même sous-ensemble de champs : `nom/prenom` toujours, puis selon le rôle `date_naissance`, `lieu_naissance`, `domicile`, `profession`. Voir `references/acte-fields.md` pour la liste exhaustive groupée — ne la retapez pas de mémoire, la table est trop large pour ça.

Autres champs mariage : `option_mariage`, `regime_mariage`, `heure_mariage`.

### Jugement supplétif

`type_acte` (`TypeActe.oui | non`) indique si l'acte résulte d'un jugement supplétif. Si `oui`, `numero_jugement`, `lieu_jugement`, `date_jugement`, `declaration_jugement` doivent être considérés.

### Identifiant IUCEC

`identifiant_unique`, `code_ecc`, `annee_identifiant`, `numero_ordre`, `cle_controle`, `identifiant_attribue_le` — ne jamais les écrire à la main, toujours passer par le service décrit dans la skill `iucec-identifiant-service`.

### Les dates métier sont des `String` — et le restent

`date_naissance`, `date_deces`, `date_mariage`, `date_etablissement`, `date_jugement`, toutes les dates des blocs parents/époux/témoins : ce sont des **chaînes de caractères**, pas des `DateTime`. Le format attendu dépend de `article` (enum `le | vers | en`) :
- `le` → format `jj/mm/aaaa` strict
- `vers` / `en` → format `aaaa` (année seule)

Ne « modernisez » **jamais** ces colonnes en `DateTime` Prisma ni les valeurs en `Date` JS : une date partielle (`1987`) n'est pas représentable en `Date`, les données saisies et le frontend seraient cassés, et la règle conditionnelle par `article` deviendrait inexprimable. Cette règle est aujourd'hui appliquée **uniquement côté client** (`legacy:src/app/sae/enregistrement/acteSchema.ts`, via `.superRefine`). Le nouveau backend doit la réappliquer côté serveur — voir la skill `api-conventions-and-validation` pour le schéma Zod équivalent. Ne validez jamais `date_naissance` avec un simple `z.string()` sans tenir compte de `article`. Seuls `createdAt`, `updatedAt` et `identifiant_attribue_le` sont de vrais `DateTime` (horodatages techniques).

## Workflow de statut

```
PENDING → COMPLETED → REJECTED → ARCHIVED
```

- `userId` : l'agent qui a créé/saisi l'acte (relation `ActeOwner`).
- `validatedById` + `validated: boolean` : l'administrateur qui a validé l'acte (relation `ValidatedBy`) — **doit être un `User.role === ADMIN`**, règle déjà appliquée dans l'import CSV (`legacy:src/pages/api/admin/actes/import.ts`) et à centraliser dans le middleware RBAC du nouveau backend plutôt que revérifiée route par route (voir la skill `auth-rbac-security`).
- `completed: boolean` est distinct de `status` — un acte peut être `completed` (saisie terminée) sans être encore `validated`.

## Politique de suppression

**Aucune suppression physique d'un `Acte` ou d'un `Registre` via l'API de ce backend.** Un registre d'état civil est un document légal : la disparition silencieuse d'une ligne est inacceptable.

- Un `DELETE HTTP` sur `/api/v1/actes/:id` (s'il est exposé pour compatibilité) se traduit par `status: ARCHIVED` + une entrée dans le journal d'audit (voir skill `auth-rbac-security`), jamais par un `prisma.acte.delete()`.
- La suppression physique reste possible uniquement via un script d'administration hors API (dossier `scripts/`), exécuté manuellement, avec validation produit explicite et journalisée.
- Au moment de porter `legacy:src/pages/api/acte/[id].ts` : lisez ce que fait réellement le `DELETE` legacy. S'il supprime physiquement et que le frontend en dépend, c'est une **divergence volontaire** du nouveau backend — documentez-la dans l'inventaire des endpoints et faites-la valider par le produit avant la bascule de cette route.

## User et rôles

Deux rôles seulement : `AGENT` (saisie) et `ADMIN` (validation, administration, accès aux statistiques/exports). Un `User` a deux relations distinctes vers `Acte` : celle des actes qu'il a créés (`actes`) et celle des actes qu'il a validés (`validatedActes`) — ne pas les confondre dans les requêtes de statistiques par utilisateur.

Le modèle `Session` existe dans le schéma mais sert à la stratégie de session NextAuth du legacy (non utilisée en pratique, la stratégie active étant `jwt`). Le nouveau backend ne le réutilise **pas** : la persistance des refresh tokens passe par une table dédiée `RefreshToken` créée par migration — décision et détails dans la skill `auth-rbac-security`. `Session` sera dépréciée puis supprimée en phase 4 de la bascule (voir `CLAUDE.md`).

## Références

- `references/acte-fields.md` — inventaire complet des champs de `Acte` (vérifié exhaustif contre le schéma : 110 champs scalaires + 3 relations), groupés par type d'acte. À consulter avant d'écrire un DTO Zod, un mapping CSV, ou un `select` Prisma.
