---
name: civil-status-domain-model
description: Explique le modele metier de l'etat civil burkinabe (Region -> Province -> Commune -> Registre -> Acte, workflow de statut, champs par type d'acte naissance/mariage/deces) tel qu'il existe dans le schema Prisma actuel. Utiliser des qu'une tache touche au modele de donnees, a la creation/validation d'un acte, au workflow PENDING/COMPLETED/REJECTED/ARCHIVED, a la contrainte d'unicite d'un registre, ou qu'on ecrit une route/service/migration Express manipulant Acte, Registre, Commune, Province, Region, Officier ou User.
metadata:
  author: sae-backend
  version: 1.0.0
  category: domain-knowledge
---

# Modèle métier — état civil (naissance / mariage / décès)

Ce skill décrit le modèle de données **tel qu'il existe déjà** dans `../prisma/schema.prisma` (schéma partagé, ne pas dupliquer). Le backend Express doit exposer ce modèle, pas le redessiner. Toute divergence de nommage ou de structure casse la compatibilité avec les données déjà saisies.

## Hiérarchie géographique

```
Region (1) → Province (N) → Commune (N) → Registre (N) → Acte (N)
```

- `Region.code_region`, `Province.code_province`, `Commune.code_commune` : codes de **10 caractères**, uniques, à but de référence/reporting. Ils ne servent **pas** à construire l'identifiant IUCEC.
- `Commune.code_ecc` : code de **7 caractères**, unique, c'est celui-là (et uniquement celui-là) qui entre dans la composition de l'identifiant unique — voir le skill [[iucec-identifiant-service]].
- `Commune.logo` : aujourd'hui probablement une chaîne (chemin ou base64) ; candidat direct à la migration vers MinIO, voir [[minio-file-storage]].
- `Officier` (nom, prenom, fonction) est optionnellement rattaché à une `Commune` — c'est l'officier d'état civil qui signe/valide les actes de cette commune.

## Registre

Un registre représente un cahier physique de la commune pour une année et un type d'acte donné.

```ts
// Contrainte d'unicité — NE JAMAIS l'omettre dans les requêtes de lookup/upsert
@@unique([communeId, centre_registre, numero, annee, type_registre])
```

- `centre_registre` a une valeur par défaut `"PRINCIPAL"` — un même numéro/année/type peut exister dans plusieurs centres secondaires d'une même commune. Toujours normaliser en majuscules et `.trim()` avant comparaison (`registreService.ts` le fait déjà via `.trim().toUpperCase()`, reproduire ce comportement).
- `type_registre` : enum `NAISSANCE | MARIAGE | DECES` — détermine quels champs de `Acte` sont pertinents pour les actes rattachés à ce registre.

## Acte — une table large, pas une table par type

`Acte` est **une seule table dénormalisée** qui porte les champs des trois types d'actes. Ce choix est intentionnel et existant : **ne créez pas de nouvelle table par type d'acte** dans le backend Express, ajoutez plutôt un champ en suivant le pattern de nommage déjà en place.

### Champs partagés (réutilisés entre naissance et décès)

`prenom`, `nom`, `date_naissance`, `heure`, `lieu_naissance`, `sexe` sont **doublement utilisés** :
- pour un acte de **naissance** : identité de l'enfant.
- pour un acte de **décès** : identité du défunt (en complément de `date_deces`, `heure_deces`, `lieu_deces`, `profession_defunt`, `domicile_defunt`, `heure_naissance`).

C'est une source de confusion fréquente : avant d'écrire une requête ou un DTO, vérifiez toujours le `type_registre` du registre parent pour savoir comment interpréter ces champs.

### Naissance — champs des parents

Préfixe `_pere` / `_mere` : `nom_pere`, `prenom_pere`, `date_naissance_pere`, `lieu_naissance_pere`, `profession_pere`, `domicile_pere` (symétrique pour `_mere`).

### Décès — déclarant et conjoint

`nom_declarant`, `prenom_declarant`, `qualite_declarant` ; `situation_matrimoniale`, `date_mariage`, `nom_conjoint`, `prenom_conjoint`, et `conjoints` (JSON sérialisé en `String` pour les conjoints multiples — désérialiser avec précaution côté Express, ce n'est pas un vrai type JSON Prisma).

### Mariage — namespacé `_epoux` / `_epouse`

Chaque bloc d'identité (`epoux`, `epouse`, `pere_epoux`, `mere_epoux`, `pere_epouse`, `mere_epouse`, `temoin_epoux`, `temoin_epouse`) répète le même sous-ensemble de champs : `nom/prenom` toujours, puis selon le rôle `date_naissance`, `lieu_naissance`, `domicile`, `profession`. Voir `references/acte-fields.md` pour la liste exhaustive groupée — ne la retapez pas de mémoire, la table fait ~150 colonnes.

Autres champs mariage : `option_mariage`, `regime_mariage`, `heure_mariage`.

### Jugement supplétif

`type_acte` (`TypeActe.oui | non`) indique si l'acte résulte d'un jugement supplétif. Si `oui`, `numero_jugement`, `lieu_jugement`, `date_jugement`, `declaration_jugement` doivent être considérés.

### Identifiant IUCEC

`identifiant_unique`, `code_ecc`, `annee_identifiant`, `numero_ordre`, `cle_controle`, `identifiant_attribue_le` — ne jamais les écrire à la main, toujours passer par le service décrit dans [[iucec-identifiant-service]].

### Format de date selon `article`

`article` (enum `le | vers | en`) contrôle le format attendu de `date_naissance` :
- `le` → format `jj/mm/aaaa` strict
- `vers` / `en` → format `aaaa` (année seule)

Cette règle est aujourd'hui appliquée **uniquement côté client** (`acteSchema.ts`, via `.superRefine`). Le nouveau backend doit la réappliquer côté serveur — voir [[api-conventions-and-validation]] pour le schéma Zod équivalent. Ne validez jamais `date_naissance` avec un simple `z.string()` sans tenir compte de `article`.

## Workflow de statut

```
PENDING → COMPLETED → REJECTED → ARCHIVED
```

- `userId` : l'agent qui a créé/saisi l'acte (relation `ActeOwner`).
- `validatedById` + `validated: boolean` : l'administrateur qui a validé l'acte (relation `ValidatedBy`) — **doit être un `User.role === ADMIN`**, cette règle est déjà appliquée dans l'import CSV (`admin/actes/import.ts`) et doit être centralisée dans le middleware RBAC du nouveau backend plutôt que revérifiée route par route (voir [[auth-rbac-security]]).
- `completed: boolean` est distinct de `status` — un acte peut être `completed` (saisie terminée) sans être encore `validated`.

## User et rôles

Deux rôles seulement : `AGENT` (saisie) et `ADMIN` (validation, administration, accès aux statistiques/exports). Un `User` a deux relations distinctes vers `Acte` : celle des actes qu'il a créés (`actes`) et celle des actes qu'il a validés (`validatedActes`) — ne pas les confondre dans les requêtes de statistiques par utilisateur.

Le modèle `Session` existe dans le schéma mais sert à la stratégie de session NextAuth actuelle (non utilisée en pratique car la stratégie active est `jwt`, pas `database`). Le nouveau backend JWT autonome n'a pas besoin de cette table, sauf si vous décidez d'implémenter des refresh tokens persistés — dans ce cas, documentez ce choix explicitement plutôt que de réutiliser `Session` tel quel sans réflexion.

## Références

- `references/acte-fields.md` — inventaire complet des champs de `Acte`, groupés par type d'acte. À consulter avant d'écrire un DTO Zod, un mapping CSV, ou un `select` Prisma.
