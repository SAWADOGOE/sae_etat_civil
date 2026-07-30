# Vecteurs de test IUCEC — vérifiés contre le code legacy

**Provenance** : générés le 2026-07-30 en **exécutant directement** les fonctions `genererCleControle` et `verifierIdentifiant` du fichier `identifiantService.legacy.ts` (copie figée de `legacy:src/services/identifiantService.ts`, branche `parametres`). Ce ne sont pas des valeurs calculées de tête : elles sortent du code de référence lui-même. Toute implémentation du nouveau backend doit reproduire ces sorties à l'identique.

Les fonctions testées ici sont **pures** (aucun accès base) : les `code_ecc` fictifs sont volontaires et valides comme vecteurs — la vérification d'existence de la commune est une étape séparée du service, testée à part avec la base de test.

## Vecteurs positifs — génération

Entrées : `code_ecc` (7 chars), `annee`, `numero_ordre` (avant padding). Sortie attendue : identifiant complet 17 caractères.

| code_ecc | annee | numero_ordre | identifiant attendu | note |
|---|---|---|---|---|
| 3000441 | 2025 | 1 | `30004412025000167` | corrige l'exemple erroné (`...166`) du commentaire legacy |
| 3000441 | 2025 | 2 | `30004412025000266` | |
| 3000441 | 2024 | 1 | `30004412024000168` | l'année change → la clé change |
| 3000441 | 2025 | 9999 | `30004412025999914` | plafond exact de la séquence |
| 1000001 | 2026 | 123 | `10000012026012373` | padding du numéro d'ordre (`0123`) |
| 8888888 | 2025 | 4 | `88888882025000497` | **cas limite `reste === 0` → clé `"97"`** — ne jamais « normaliser » en `00` |
| 9999999 | 2025 | 42 | `99999992025004281` | |

## Vecteurs de vérification — `verifierIdentifiant`

| entrée | attendu | note |
|---|---|---|
| `30004412025000167` | `true` | |
| `88888882025000497` | `true` | clé 97 acceptée |
| `30004412025000166` | `false` | l'exemple du commentaire d'en-tête legacy est **invalide** |
| `3000441202500016` | `false` | 16 caractères — longueur stricte |
| `""` / `null` / `undefined` | `false` | garde d'entrée |

## Vecteurs de décomposition — `decomposerIdentifiant`

| entrée | code_ecc | annee | numero_ordre | cle_controle |
|---|---|---|---|---|
| `30004412025000167` | `3000441` | `2025` (number) | `1` (number) | `"67"` (string) |
| `88888882025000497` | `8888888` | `2025` | `4` | `"97"` |

Attention aux types : `annee` et `numero_ordre` sortent en `number` (via `parseInt`), `cle_controle` reste une `string` de 2 caractères.

## Transposition en test Vitest (obligatoire avant tout merge IUCEC)

```ts
// test/unit/identifiant.vectors.test.ts
import { describe, expect, it } from 'vitest';
import { construireIdentifiant, verifierIdentifiant } from '@/services/identifiantService';
// construireIdentifiant(code_ecc, annee, ordre) = partie pure du service porté
// (assemblage paddé + clé), extraite pour être testable sans base.

const positifs: Array<[string, number, number, string]> = [
  ['3000441', 2025, 1,    '30004412025000167'],
  ['3000441', 2025, 2,    '30004412025000266'],
  ['3000441', 2024, 1,    '30004412024000168'],
  ['3000441', 2025, 9999, '30004412025999914'],
  ['1000001', 2026, 123,  '10000012026012373'],
  ['8888888', 2025, 4,    '88888882025000497'], // reste === 0 → clé "97"
  ['9999999', 2025, 42,   '99999992025004281'],
];

describe('IUCEC — vecteurs vérifiés contre le legacy', () => {
  it.each(positifs)('%s | %i | %i -> %s', (ecc, annee, ordre, attendu) => {
    expect(construireIdentifiant(ecc, annee, ordre)).toBe(attendu);
    expect(verifierIdentifiant(attendu)).toBe(true);
  });

  it.each([
    '30004412025000166', // exemple erroné du commentaire legacy
    '3000441202500016',  // 16 caractères
    '',
  ])('rejette %s', (invalide) => {
    expect(verifierIdentifiant(invalide)).toBe(false);
  });
});
```

Si ce test échoue après un refactor, c'est **l'implémentation** qu'on corrige, jamais les vecteurs. Toute mise à jour de ce fichier exige de re-générer les valeurs en exécutant `identifiantService.legacy.ts` et de le mentionner dans le commit.
