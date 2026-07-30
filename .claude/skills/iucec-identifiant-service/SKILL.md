---
name: iucec-identifiant-service
description: Documente l'algorithme exact de generation de l'identifiant unique IUCEC a 17 caracteres (code_ecc + annee + numero d'ordre + cle de controle Luhn modifie %97) et la regle d'incrementation atomique via IdentifiantSequence, avec vecteurs de test verifies. Utiliser imperativement des qu'on implemente, modifie, teste ou meme lit la generation, verification ou decomposition d'un identifiant_unique, un endpoint /identifiants/*, ou toute logique touchant code_ecc, numero_ordre, cle_controle.
metadata:
  author: sae-backend
  version: 1.1.0
  category: domain-knowledge
---

# Service d'identifiant unique IUCEC

## Règle absolue

Cet algorithme existe déjà et fonctionne. La référence est le fichier vendoré `references/identifiantService.legacy.ts` — **copie figée** de `legacy:src/services/identifiantService.ts`, à ne jamais modifier ; c'est la spécification exécutable. Le réécrire en Express n'est **pas l'occasion de le réinterpréter** : c'est un portage à l'identique. Des identifiants déjà attribués et potentiellement vérifiés par des systèmes tiers dépendent de cette formule exacte.

**Tests obligatoires** : aucun code touchant l'IUCEC ne peut être mergé sans que la suite de vecteurs de `references/vecteurs-test-iucec.md` passe (voir aussi la skill `testing-and-parity`). Ces vecteurs ont été générés en **exécutant les fonctions du fichier legacy lui-même** — ils font foi.

## ⚠️ Le commentaire d'en-tête du fichier legacy contient un exemple FAUX

Le bloc de commentaires en tête de `identifiantService.legacy.ts` donne l'exemple `30004412025000166` (clé `66`). Or **la propre fonction `verifierIdentifiant` du fichier renvoie `false` pour cette valeur** : pour `(3000441, 2025, 0001)`, l'algorithme produit la clé `67`, donc `30004412025000167`. Le commentaire est erroné, **le code fait foi**. Ne recopiez jamais cet exemple dans de la doc, des tests ou des messages — utilisez les vecteurs vérifiés. (Si un identifiant `...166` existait réellement en base, ce serait un identifiant invalide au sens de l'algorithme : à signaler au produit, pas à « réparer » en changeant l'algorithme.)

## Format (17 caractères)

```
[code_ecc: 7][année: 4][numéro_ordre: 4][clé_contrôle: 2]
Exemple vérifié : 30004412025000167
                  3000441 | 2025 | 0001 | 67
```

- `code_ecc` : exactement 7 caractères (le service lève une erreur sinon), doit correspondre à une `Commune.code_ecc` existante en base — sinon erreur explicite (`Aucune commune trouvée avec le code ECC: ...`).
- `année` : 4 chiffres, zero-paddée (`padStart(4, '0')`). Par défaut l'année courante si non fournie ; si on génère à partir d'un registre, c'est `registre.annee` qui prime (voir plus bas).
- `numéro_ordre` : 4 chiffres, zero-paddé, **séquentiel par `(code_ecc, année)`**. Plafond dur à **9999** — au-delà, le service lève une erreur explicite plutôt que de déborder silencieusement.
- `clé_contrôle` : 2 chiffres, calculée sur les 15 premiers caractères.

## Calcul de la clé de contrôle (Luhn modifié, `% 97`)

```ts
const poids = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1]; // 15 poids, un par caractère de code_ecc+année+numero_ordre

function genererCleControle(identifiantSansCle: string): string {
  let somme = 0;
  for (let i = 0; i < identifiantSansCle.length; i++) {
    somme += parseInt(identifiantSansCle[i]) * poids[i];
  }
  const reste = somme % 97;
  const cle = 97 - reste;
  return String(cle).padStart(2, '0');
}
```

Points d'attention en portant ce code :
- Les poids sont indexés **par position de caractère**, pas par groupe logique (code_ecc/année/numero_ordre) — ne réordonnez pas le tableau.
- `parseInt(identifiantSansCle[i])` suppose que **tous les caractères de `code_ecc` sont des chiffres**. Si un `code_ecc` contient un jour une lettre, cette fonction plante silencieusement (`NaN` dans la somme). Documentez cette hypothèse plutôt que de la corriger sans validation métier — demandez confirmation avant de changer ce comportement.
- `97 - reste` vaut `97` quand `reste === 0` : la clé est alors `"97"`, pas `"00"`. `String(97).padStart(2,'0')` donne bien 2 caractères — comportement correct, ne pas « corriger » en `cle % 97`, ce qui casserait la parité avec les identifiants existants. Ce cas limite est couvert par le vecteur `88888882025000497` (voir `references/vecteurs-test-iucec.md`).

## Décomposition et vérification

```ts
function decomposerIdentifiant(id: string) {
  return {
    code_ecc:     id.substring(0, 7),
    annee:        parseInt(id.substring(7, 11)),
    numero_ordre: parseInt(id.substring(11, 15)),
    cle_controle: id.substring(15, 17),
  };
}

function verifierIdentifiant(id: string): boolean {
  if (!id || id.length !== 17) return false;
  return id.substring(15, 17) === genererCleControle(id.substring(0, 15));
}
```

## Séquence : `IdentifiantSequence` est l'unique source de vérité

```prisma
model IdentifiantSequence {
  code_ecc       String
  annee          Int
  dernier_numero Int @default(0)
  total_generes  Int @default(0)
  @@unique([code_ecc, annee])
}
```

- **Ne jamais** calculer `numero_ordre` par un `COUNT(*)` sur `Acte` — la table peut contenir des trous (actes archivés, imports partiels) qui désynchroniseraient le compteur.
- L'incrément doit rester une opération Prisma atomique au niveau base de données :

```ts
await prisma.identifiantSequence.update({
  where: { code_ecc_annee: { code_ecc, annee } },
  data: { dernier_numero: { increment: 1 }, total_generes: { increment: 1 } },
});
```

- Créer la ligne de séquence si absente (`findUnique` puis `create` si `null`) **avant** l'incrément — c'est le pattern déjà en place (`obtenirSequence` puis `obtenirProchainNumero` dans le fichier vendoré), le conserver.
- **Interdiction explicite** : ne mettez pas ce compteur en cache Redis d'une manière qui pourrait servir un `numero_ordre` sans passer par cet `update` atomique en base — voir la mise en garde dans la skill `redis-caching-and-queues`. Un cache en lecture seule pour l'endpoint de statistiques (`obtenirStatistiques`) est acceptable ; un cache qui *décide* du prochain numéro ne l'est pas, car deux instances Express en parallèle produiraient alors le même identifiant.

## Génération à partir d'un registre

`genererIdentifiantPourRegistre(registreId, annee?)` résout d'abord le `code_ecc` via `registre.commune.code_ecc` :
- si la commune n'a pas encore de `code_ecc` attribué → erreur explicite invitant à en attribuer un (ne pas générer un identifiant partiel ou factice).
- l'année utilisée par défaut est **celle du registre** (`registre.annee`), pas l'année calendaire courante — un rattrapage de saisie en 2026 pour un registre 2024 doit produire un identifiant `2024...`.

## API à exposer (parité avec l'existant)

Les trois endpoints legacy (`legacy:src/pages/api/identifiant/{generer,verifier,statistiques}.ts`) doivent avoir un équivalent Express au même contrat d'entrée/sortie, exposé sous `/api/v1/identifiants/*` — voir l'inventaire et la table de correspondance dans la skill `api-conventions-and-validation`. `validerIdentifiant` fait à la fois la vérification de format *et* une résolution en base (acte existant ou commune correspondante) : gardez cette double sémantique, ne la scindez pas sans le signaler.

## Références

- `references/identifiantService.legacy.ts` — copie figée du service legacy complet. Spécification exécutable ; ne pas modifier, ne pas importer dans le code de production (porter le code dans `src/services/`, avec le singleton Prisma de `src/lib/prisma.ts`).
- `references/vecteurs-test-iucec.md` — vecteurs de test générés depuis le code legacy, incluant le cas limite clé `"97"` et des vecteurs négatifs. À transposer en test Vitest dès le premier portage.
