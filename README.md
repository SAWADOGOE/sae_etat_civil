# Backend Express — SAE État Civil (en préparation)

Ce dépôt **autonome** accueille la réécriture en Express.js du backend de l'application SAE État Civil. Le projet existant (frontend Next.js + API legacy) vit dans un autre dépôt : [`SAWADOGOE/etat_civil_saisie`](https://github.com/SAWADOGOE/etat_civil_saisie), branche `parametres`.

**État actuel : cadrage uniquement.** Pas encore de code applicatif — seulement `CLAUDE.md` (la charte du projet : décisions d'architecture, contraintes non négociables, gouvernance du schéma Prisma, stratégie de bascule) et un ensemble de *skills* Claude Code sous `.claude/skills/`. Ces skills encodent l'analyse du backend legacy et les bonnes pratiques cibles : Express 5, MinIO pour les fichiers, Redis pour le cache et les files d'attente, JWT + audit trail, logs structurés, monitoring, tests de parité.

## Pour reprendre le travail

Ouvrez ce dépôt avec Claude Code : `CLAUDE.md` est chargé automatiquement et les skills se déclenchent selon la tâche (créer une route, gérer un upload, écrire un job d'arrière-plan, écrire des tests, etc.).

Si une tâche nécessite de lire le code legacy, il se clone en lecture seule dans `./legacy/` (dossier ignoré par git) — la commande exacte est dans `CLAUDE.md`, section « Le dépôt legacy ». Les extraits critiques (algorithme IUCEC, schéma de validation des actes) sont déjà vendorés dans les skills.

Prochaine étape naturelle, dans l'ordre :

1. Bootstrap du projet (`package.json`, `tsconfig.json`, `.nvmrc`, structure `src/`, docker-compose de dev) en suivant la skill `express-backend-architecture`.
2. Import du schéma Prisma legacy (`prisma/schema.prisma` + `prisma/migrations/`) en commit dédié — voir « Gouvernance du schéma » dans `CLAUDE.md`.
3. Mise en place de la CI et du harnais de tests (skill `testing-and-parity`), avec en premier le test des vecteurs IUCEC.
