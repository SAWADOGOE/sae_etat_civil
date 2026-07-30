---
name: auth-rbac-security
description: Remplace NextAuth par une authentification JWT autonome (access + refresh tokens persistes), hashage des mots de passe, middleware d'autorisation par role (AGENT/ADMIN), journal d'audit, gestion des secrets et conformite donnees personnelles. Utiliser pour le login/logout, la protection de routes, la verification de role, le journal d'audit, toute question de securite API (CORS, rate limiting, headers), de secrets ou de donnees personnelles — y compris quand la tache ne mentionne la securite qu'indirectement (export de donnees, logs, nouvelle route sensible).
metadata:
  author: sae-backend
  version: 1.1.0
  category: security
---

# Authentification, autorisation et sécurité

## Pourquoi NextAuth ne se porte pas tel quel

L'auth legacy (`legacy:src/pages/api/auth/[...nextauth].ts`) utilise `next-auth` avec un provider `CredentialsProvider` dont le callback `authorize` fait un **appel HTTP interne** vers `/api/auth/signin` pour valider les identifiants — un aller-retour réseau vers soi-même, artefact du couplage à Next.js. Dans un backend Express autonome, ce détour n'a plus de raison d'être : validez les identifiants directement dans le service de login.

Comportement à conserver (c'est la partie qui compte) :
- Provider « email + mot de passe » uniquement.
- Le token porte `id` et `role` de l'utilisateur (voir callbacks `jwt`/`session` legacy).
- Pas de session serveur d'état : JWT + refresh token persisté (voir ci-dessous).

## Décision : access token court + refresh token persisté

La session NextAuth vécue par les agents aujourd'hui dure de fait ~30 jours. Un access token de 2 h **sans** refresh dégraderait brutalement leur quotidien. Décision pour ce backend :

- **Access token JWT : 2 h** (`expiresIn: '2h'`), porte `sub` (id) et `role`.
- **Refresh token : 30 jours, à rotation** — chaîne aléatoire opaque (pas un JWT), stockée **hashée** (SHA-256 suffit pour un secret à haute entropie) dans une table dédiée `RefreshToken` créée par migration dans **ce** dépôt (gouvernance du schéma : voir `CLAUDE.md`) :

```prisma
model RefreshToken {
  id         String   @id @default(cuid())
  tokenHash  String   @unique
  userId     String
  user       User     @relation(fields: [userId], references: [id])
  expiresAt  DateTime
  revokedAt  DateTime?
  createdAt  DateTime @default(now())
  @@index([userId])
}
```

- `POST /api/v1/auth/refresh` : vérifie le hash, la non-révocation et l'expiration, **révoque** le token présenté et en émet un nouveau (rotation) + un nouvel access token. Un refresh déjà révoqué re-présenté = signal de vol : révoquer toute la famille de tokens de l'utilisateur et journaliser.
- `POST /api/v1/auth/logout` : révoque le refresh token courant.
- Le modèle `Session` du schéma legacy n'est **pas** réutilisé pour ça (voir skill `civil-status-domain-model`) — il sera déprécié en phase 4 de la bascule.

## Émission du token

```ts
// services/authService.ts
import bcrypt from 'bcryptjs'; // même lib que le legacy — compatibilité des hash existants
import jwt from 'jsonwebtoken';

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new UnauthorizedError('Identifiants invalides');
  }
  const token = jwt.sign({ sub: user.id, role: user.role }, env.JWT_SECRET, { expiresIn: '2h' });
  const refreshToken = await creerRefreshToken(user.id); // aléatoire, hashé en base, 30 j
  return { token, refreshToken, user: { id: user.id, role: user.role, nom_user: user.nom_user, prenom_user: user.prenom_user } };
}
```

**Important** : les mots de passe existants en base ont été hashés avec `bcryptjs`. Ne changez pas d'algorithme (ex. vers `argon2`) sans une migration de ré-hashage progressif (vérifier avec l'ancien algo au login, ré-hasher avec le nouveau à la volée) — sinon tous les utilisateurs existants sont bloqués au premier déploiement.

Ne renvoyez jamais `user.password` (même hashé) dans une réponse JSON — grep sur `password` dans les DTO/`select` Prisma avant de merger une route qui touche `User`. Le legacy `users.ts` a le bon réflexe : le conserver.

## Middleware de vérification

```ts
// middleware/auth.ts
export function requireAuth(req: Request, res: Response, next: NextFunction) {
  const token = req.headers.authorization?.replace('Bearer ', '');
  if (!token) return next(new UnauthorizedError('Token manquant'));
  try {
    req.user = jwt.verify(token, env.JWT_SECRET) as { sub: string; role: Role };
    next();
  } catch {
    next(new UnauthorizedError('Token invalide ou expiré'));
  }
}

export function requireRole(...roles: Role[]) {
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.user || !roles.includes(req.user.role)) {
      return next(new AppError(403, 'Accès refusé'));
    }
    next();
  };
}
```

C'est l'équivalent direct du `withAuth` de `legacy:middleware.ts`, qui protège aujourd'hui tout sauf `/login`, `/api/*` et les assets statiques — mais appliqué **par route**, pas globalement, puisqu'un backend API n'a pas de notion de « page ». Chaque route protégée déclare explicitement `requireAuth` (et `requireRole('ADMIN')` si nécessaire) dans sa définition. Notez au passage que le legacy **exclut** `/api/*` de son middleware : le RBAC au niveau route est aujourd'hui quasi inexistant — le nouveau backend le rend systématique.

## Centraliser les vérifications de rôle actuellement dispersées

Le contrôle « le validateur doit être ADMIN » existe aujourd'hui **ad hoc** dans `legacy:src/pages/api/admin/actes/import.ts` (`if (autoValidate && validator?.role !== Role.ADMIN) ...`). Dans le nouveau backend, ce type de contrôle passe par `requireRole('ADMIN')` sur la route, ou par une assertion de service explicite et nommée (`assertCanValidateActes(user)`) réutilisée partout où la règle s'applique — pas réécrite inline à chaque endpoint.

## Permissions par commune : état des lieux et règle d'écriture

Aujourd'hui, **rien** dans le legacy ne restreint un `AGENT` à une commune : tout agent authentifié peut a priori saisir pour n'importe quelle commune. `legacy:src/pages/api/registre/affecter.ts` suggère un mécanisme d'affectation dont le contrat n'a pas encore été relu (voir la question ouverte dans la skill `civil-status-domain-model`).

Décision v1 : **reproduire l'existant** (pas de restriction par commune) — introduire une restriction serait un changement métier, pas un portage. Mais écrivez le code de façon à pouvoir durcir sans réécriture : toute vérification d'accès à une ressource communale passe par une assertion nommée centralisée (ex. `assertCanAccessCommune(user, communeId)` — qui en v1 laisse passer) plutôt que par des conditions éparpillées. Si le produit confirme un besoin de cloisonnement (superviseur régional, agent mono-commune), c'est cette assertion qu'on implémentera, et l'enum `Role` ne s'étend **que** sur décision produit explicite.

## Journal d'audit — obligatoire pour de l'état civil

Le legacy ne trace rien d'autre que `validatedById`. Pour des données d'état civil, il faut savoir **qui a fait quoi, quand, sur quel enregistrement**. Nouveau modèle, par migration dans ce dépôt :

```prisma
model JournalAudit {
  id          String   @id @default(cuid())
  userId      String?
  action      String   // ex. ACTE_CREE, ACTE_MODIFIE, ACTE_VALIDE, ACTE_REJETE, ACTE_ARCHIVE,
                       //     ACTE_CONSULTE, EXPORT_CSV, IMPORT_CSV, LOGIN_OK, LOGIN_ECHEC, TOKEN_REVOQUE
  ressource   String   // 'Acte', 'Registre', 'User', ...
  ressourceId String?
  details     String?  // JSON compact : ids et NOMS DE CHAMPS modifiés — jamais les valeurs personnelles
  requestId   String?
  ip          String?
  createdAt   DateTime @default(now())
  @@index([ressource, ressourceId])
  @@index([userId, createdAt])
}
```

Règles d'usage :
- Helper unique `audit(action, { userId, ressource, ressourceId, details, req })` appelé depuis les **services** (pas les controllers), pour que les jobs BullMQ puissent auditer aussi.
- À journaliser au minimum : login réussi/échoué, création/modification/validation/rejet/archivage d'un acte, consultation d'un acte individuel (`GET /actes/:id` — pas les listes, volume inutile), imports, exports, révocations de token.
- `details` ne contient **jamais** de données personnelles en clair (pas de noms, dates de naissance…) : uniquement des identifiants et la liste des champs modifiés. Le journal est lui-même une donnée sensible : lecture réservée `ADMIN`, jamais exposée publiquement.
- Durée de rétention : à fixer avec le métier/juriste (voir conformité ci-dessous) — en attendant, on conserve tout, on ne purge pas.

## Sécurité transverse (absente ou partielle aujourd'hui)

- **CORS** : le frontend Next.js et ce backend seront deux origines distinctes — configurez `cors()` avec une allowlist explicite d'origines depuis l'env, pas `origin: '*'`.
- **Helmet** : headers de sécurité par défaut (`app.use(helmet())`).
- **Rate limiting sur `/api/v1/auth/login` et `/refresh`** : `express-rate-limit`, ex. 10 tentatives / 15 min / IP — inexistant aujourd'hui.
- **Ne pas exposer les détails d'erreur en production** : généralisé via le middleware d'erreur central (skill `express-backend-architecture`).
- **Uploads** : taille max et types MIME vérifiés côté serveur — voir la skill `minio-file-storage` (et l'incohérence `MAX_FILE_SIZE` legacy à clarifier avant de la reporter).

## Secrets — règles et incident à connaître

**Contexte (incident réel)** : le dépôt legacy a commité en clair (1) le `NEXTAUTH_SECRET` dans `docker-compose.yml` et (2) une **clé privée de compte de service Google Cloud** (`config/archivage-452209-...json`, dupliquée dans `src/config/`), le tout présent dans l'historique git d'un dépôt qui a été public. Ces valeurs sont **compromises définitivement** : elles ont été révoquées/rotationnées côté fournisseurs et ne doivent jamais réapparaître, ni ici ni ailleurs.

Règles pour ce dépôt :
- `.env` jamais commité ; `.env.example` (valeurs factices commentées) toujours à jour — toute nouvelle variable d'env ajoutée dans `src/config/env.ts` apparaît dans `.env.example` dans la même PR.
- `JWT_SECRET` : valeur forte (≥ 32 caractères aléatoires), **différente par environnement**, générée à part (`openssl rand -base64 48`), jamais dérivée d'anciens secrets.
- Aucun fichier de credentials (JSON de service account, clés PEM, certificats privés) dans le dépôt, même « temporairement ». Si un service cloud est nécessaire, la référence passe par variable d'env pointant un secret injecté au déploiement.
- Détection automatique : hook pre-commit + job CI avec `gitleaks` (ou équivalent) — un secret détecté = pipeline rouge.
- Si un secret fuite malgré tout : révoquer immédiatement chez le fournisseur, faire tourner, puis seulement ensuite nettoyer l'historique si pertinent. La révocation prime sur le nettoyage git (l'historique a pu être cloné).

## Conformité — données à caractère personnel

Ce système traite des données personnelles sensibles de citoyens (filiation, naissances, décès, mariages). Le Burkina Faso encadre ces traitements (loi n°010-2004/AN portant protection des données à caractère personnel, révisée par la loi n°001-2021/AN ; autorité de contrôle : la CIL — Commission de l'Informatique et des Libertés). **Faire confirmer les obligations exactes par le référent juridique du projet** ; en attendant, ce backend applique par construction :
- **Minimisation dans les sorties** : logs avec redaction (skill `logging-monitoring-observability`), journal d'audit sans valeurs personnelles, exports réservés `ADMIN` et journalisés.
- **Traçabilité** : le journal d'audit ci-dessus est la base de toute réponse à une demande d'accès ou à un incident.
- **Pas de transfert non maîtrisé** : aucun envoi de données d'actes vers des services tiers (le retrait de l'OCR hébergé OCR.space va dans ce sens — hors périmètre, voir `CLAUDE.md`).
- Les questions registre des traitements, durées de conservation et droits des personnes sont des sujets produit/juridique à documenter avant la mise en production — ne pas improviser de réponse technique.

## Rôles

Uniquement `AGENT` et `ADMIN` (enum Prisma `Role`, voir skill `civil-status-domain-model`). Pas de rôle intermédiaire aujourd'hui — si un besoin apparaît (ex. superviseur régional), c'est une décision produit à valider avant d'étendre l'enum, pas un choix d'implémentation à prendre seul.
