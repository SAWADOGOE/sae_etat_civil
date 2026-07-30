# Backend Express — SAE État Civil (en préparation)

Ce dossier va accueillir la réécriture du backend de l'application en Express.js, séparé du frontend Next.js situé à la racine du dépôt.

**État actuel : cadrage uniquement.** Il n'y a pas encore de code applicatif ici — seulement `CLAUDE.md` et un ensemble de *skills* Claude Code sous `.claude/skills/`. Ces skills encodent l'analyse du backend existant (`../src/pages/api`, `../src/services`, `../prisma/schema.prisma`) et les décisions d'architecture pour la suite : Express, MinIO pour les fichiers, Redis pour le cache et les files d'attente, logs structurés et monitoring.

## Pour reprendre le travail

Ouvrez ce dossier avec Claude Code : `CLAUDE.md` est chargé automatiquement, et les skills se déclenchent en fonction de la tâche demandée (créer une route, gérer un upload, écrire un job d'import en tâche de fond, etc.). Voir la liste complète et le rôle de chaque skill dans `CLAUDE.md`.

Prochaine étape naturelle : bootstrap du projet Express (`package.json`, `tsconfig.json`, structure `src/`) en suivant le skill `express-backend-architecture`.
