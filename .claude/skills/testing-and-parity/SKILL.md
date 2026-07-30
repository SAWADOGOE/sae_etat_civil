---
name: testing-and-parity
description: Strategie de tests du backend (Vitest unitaires, Supertest integration sur Postgres reel via Testcontainers, tests de parite contre le legacy) et regles de CI bloquante. Utiliser des qu'on ecrit ou modifie un test, qu'on porte une route legacy (le test d'integration est un prealable pour la marquer migree), qu'on touche a l'IUCEC (vecteurs obligatoires), qu'on configure la CI, ou qu'on prepare une phase de bascule — meme si la demande ne mentionne pas explicitement les tests.
metadata:
  author: sae-backend
  version: 1.0.0
  category: quality
---

# Tests et parité avec le legacy

Ce projet est une **réécriture à iso-comportement** : la valeur des tests n'est pas seulement d'attraper des régressions futures, c'est de **prouver que le nouveau backend se comporte comme l'ancien**. La pyramide a donc trois étages, du plus rapide au plus probant.

## 1. Tests unitaires (Vitest) — logique pure

Ciblent les services sans I/O : construction/vérification d'identifiant IUCEC, règles de validation Zod (formats de date selon `article`), normalisations (`centre_registre` trim/upper), mapping CSV. Aucun mock de Prisma à outrance : si un test unitaire a besoin de trois mocks Prisma, c'est probablement un test d'intégration déguisé — écrivez-le à l'étage 2.

**Règle non négociable n°1 — vecteurs IUCEC.** Le fichier `test/unit/identifiant.vectors.test.ts` transpose les vecteurs de `.claude/skills/iucec-identifiant-service/references/vecteurs-test-iucec.md` (squelette `it.each` fourni là-bas). Aucun merge touchant de près ou de loin l'IUCEC sans cette suite verte. Si elle échoue, on corrige l'implémentation, jamais les vecteurs.

## 2. Tests d'intégration (Supertest + Postgres réel)

Chaque route passe par la vraie pile : `app.ts` → middlewares → controller → service → **Postgres réel** (pas de SQLite « proche », pas de Prisma mocké — les contraintes d'unicité, les enums et les erreurs Prisma font partie du contrat).

**Base de test : Testcontainers.**

```ts
// test/integration/setup.ts
import { PostgreSqlContainer } from '@testcontainers/postgresql';
import { execSync } from 'node:child_process';

export async function setupTestDb() {
  const container = await new PostgreSqlContainer('postgres:15-alpine').start();
  process.env.DATABASE_URL = container.getConnectionUri();
  execSync('npx prisma migrate deploy', { env: process.env, stdio: 'inherit' });
  return container; // .stop() en teardown global
}
```

- Un conteneur par run de suite (pas par test) ; entre les tests, `TRUNCATE` des tables mutées ou transactions rollback — au choix, mais documenté dans `test/integration/README.md` dès la première suite.
- Alternative sans Docker (poste contraint) : variable `TEST_DATABASE_URL` pointant une base jetable du `docker-compose.yml` de dev — mais la CI, elle, utilise Testcontainers.
- **Fixtures minimales** dans `test/fixtures/seed.ts` : 1 région → 1 province → 1 commune **avec `code_ecc`** (ex. `3000441`) et 1 commune **sans** `code_ecc` (pour tester l'erreur de génération), 1 registre par `type_registre`, 1 user `AGENT` + 1 `ADMIN` (mots de passe bcrypt connus). Réutilisées partout — pas de données inventées inline dans chaque test.

**Règle non négociable n°2 — une route portée = un test d'intégration d'abord.** Une route legacy n'est cochée « migrée » dans `references/legacy-endpoints-inventory.md` (skill `api-conventions-and-validation`) qu'avec au moins un test d'intégration couvrant : cas nominal, cas d'erreur principal (404/409/400 selon la route), et exigence d'auth (401 sans token, 403 si rôle insuffisant). Exemple type :

```ts
// test/integration/registres.test.ts
it('refuse un doublon de registre en 409', async () => {
  const payload = { communeId, centre_registre: 'PRINCIPAL', numero: '12', annee: 2025, type_registre: 'NAISSANCE' };
  await request(app).post('/api/v1/registres').set(authAdmin).send(payload).expect(201);
  const res = await request(app).post('/api/v1/registres').set(authAdmin).send(payload).expect(409);
  expect(res.body.error.code).toBe('CONFLICT');
});
```

## 3. Tests de parité contre le legacy

L'arbitre final avant chaque phase de bascule (voir `CLAUDE.md`, stratégie strangler). Principe : rejouer **les mêmes requêtes** contre le legacy (`http://localhost:3000`, son docker-compose) et ce backend (`http://localhost:4000`, ports décalés — skill `express-backend-architecture`), branchés sur la **même base**, et comparer les réponses.

- Corpus dans `test/parity/corpus/*.json` : une entrée = `{ nom, methode, chemin_legacy, chemin_v1, body?, headers? }`. Construisez-le en lisant les appels réels du frontend (`legacy:src/`) — pas en imaginant des requêtes.
- Harnais `test/parity/run.ts` : pour chaque entrée, exécute les deux appels, **normalise** (supprime les champs volatils : `requestId`, horodatages générés, ordre des tableaux si non garanti), puis diff JSON profond. Sortie : rapport des divergences par route.
- **Divergences volontaires** (codes 400→404, 500→409, enveloppe `{data}`, suppression→archivage…) : déclarées dans le harnais route par route (table `divergencesAttendues`), jamais absorbées par une normalisation globale qui masquerait de vraies régressions. La liste doit correspondre aux notes de l'inventaire.
- La parité se joue **hors auth** dans un premier temps (les mécanismes de token diffèrent) : comparez le métier avec un token valide de chaque côté ; l'auth elle-même est couverte par les tests d'intégration.

## CI — bloquante (GitHub Actions)

**Règle non négociable n°3.** Le legacy masque ses erreurs de build (`ignoreBuildErrors`) ; ici la CI est stricte et rouge = pas de merge :

```yaml
# .github/workflows/ci.yml (minimal)
name: ci
on: [push, pull_request]
jobs:
  verifier:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: npm }
      - run: npm ci
      - run: npx prisma generate
      - run: npx tsc --noEmit
      - run: npx eslint .
      - run: npx vitest run          # Testcontainers dispo sur ubuntu-latest
      - run: npm run openapi:generate # échoue si la spec ne se génère plus
      - run: docker build .
```

Ajoutez `gitleaks` en job séparé (voir skill `auth-rbac-security`, section Secrets). Les tests de parité ne tournent pas en CI (ils exigent le legacy en face) : ils se lancent manuellement avant chaque phase de bascule et leur rapport est joint à la décision de bascule.

## Ce qu'il ne faut pas faire

- Ne pas mocker Prisma dans les tests d'intégration — le but est justement d'exercer contraintes et erreurs réelles.
- Ne pas écrire de tests dépendant de l'ordre d'exécution ou d'un état laissé par un autre test.
- Ne pas « corriger » un vecteur IUCEC ou une fixture pour faire passer un test — si la spec de fait (legacy) contredit le test, c'est le test qu'on réaligne sur le legacy, avec trace dans le commit.
- Ne pas marquer une route migrée dans l'inventaire sans son test d'intégration (règle n°2) — même pour « juste un petit GET ».
