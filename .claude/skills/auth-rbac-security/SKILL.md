---
name: auth-rbac-security
description: Remplace NextAuth par une authentification JWT autonome pour Express, hashage des mots de passe, emission/validation du token, middleware d'autorisation par role (AGENT/ADMIN), equivalent du middleware.ts withAuth actuel. Utiliser pour le login, la protection de routes, la verification de role, ou toute question de securite API (CORS, rate limiting, headers).
metadata:
  author: sae-backend
  version: 1.0.0
  category: security
---

# Authentification et autorisation

## Pourquoi NextAuth ne se porte pas tel quel

L'auth actuelle (`src/pages/api/auth/[...nextauth].ts`) utilise `next-auth` avec un provider `CredentialsProvider` dont le callback `authorize` fait un **appel HTTP interne** vers `/api/auth/signin` pour valider les identifiants — un aller-retour réseau vers soi-même, artefact du couplage à Next.js. Dans un backend Express autonome, ce détour n'a plus de raison d'être : validez les identifiants directement dans le handler de login.

Comportement à conserver (c'est la partie qui compte) :
- Provider "email + mot de passe" uniquement.
- Le token porte `id` et `role` de l'utilisateur (voir callbacks `jwt`/`session` actuels).
- Stratégie JWT (pas de session en base) — cohérent avec l'absence d'usage réel de la table `Session`.

## Émission du token

```ts
// services/authService.ts
import bcrypt from 'bcryptjs'; // déjà une dépendance du monorepo, garder la même lib côté hash pour compatibilité des mots de passe existants
import jwt from 'jsonwebtoken';

export async function login(email: string, password: string) {
  const user = await prisma.user.findUnique({ where: { email } });
  if (!user || !(await bcrypt.compare(password, user.password))) {
    throw new UnauthorizedError('Identifiants invalides');
  }
  const token = jwt.sign(
    { sub: user.id, role: user.role },
    env.JWT_SECRET,
    { expiresIn: '2h' }
  );
  return { token, user: { id: user.id, role: user.role, nom_user: user.nom_user, prenom_user: user.prenom_user } };
}
```

**Important** : les mots de passe existants en base ont été hashés avec `bcryptjs`. Ne changez pas d'algorithme (ex. vers `argon2`) sans une migration de ré-hashage progressif (vérifier avec l'ancien algo au login, ré-hasher avec le nouveau à la volée) — sinon tous les utilisateurs existants sont bloqués au premier déploiement.

Ne renvoyez jamais `user.password` (même hashé) dans une réponse JSON — grep sur `password` dans les DTO/`select` Prisma avant de merger une route qui touche `User`.

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

C'est l'équivalent direct du `withAuth` de `middleware.ts` (racine du dépôt), qui aujourd'hui protège tout sauf `/login`, `/api/*` et les assets statiques — mais appliqué **par route**, pas globalement, puisqu'un backend API n'a pas de notion de "page". Chaque route protégée déclare explicitement `requireAuth` (et `requireRole('ADMIN')` si nécessaire) dans sa définition.

## Centraliser les vérifications de rôle actuellement dispersées

Le contrôle "le validateur doit être ADMIN" existe aujourd'hui **ad hoc** dans `admin/actes/import.ts` (`if (autoValidate && validator?.role !== Role.ADMIN) ...`). Dans le nouveau backend, ce type de contrôle doit passer par `requireRole('ADMIN')` sur la route, ou par une vérification de service explicite et nommée (`assertCanValidateActes(user)`) réutilisée partout où la règle s'applique — pas réécrite inline à chaque nouvel endpoint qui en a besoin.

## Sécurité transverse (absente ou partielle aujourd'hui)

- **CORS** : le frontend Next.js et ce backend seront deux origines distinctes une fois séparés — configurez `cors()` avec une allowlist explicite d'origines, pas `origin: '*'`.
- **Helmet** : headers de sécurité par défaut (`app.use(helmet())`).
- **Rate limiting sur `/auth/login`** : `express-rate-limit`, ex. 10 tentatives / 15 min / IP, pour limiter le brute-force — inexistant aujourd'hui.
- **Ne pas exposer les détails d'erreur en production** : reproduire et généraliser (via le middleware d'erreur central, voir [[express-backend-architecture]]) le réflexe déjà présent ponctuellement dans le code actuel (`details: process.env.NODE_ENV === 'development' ? error.message : undefined`).
- **Secrets** : `JWT_SECRET` doit être une valeur forte, générée à part, et différente par environnement — ne réutilisez pas la valeur `NEXTAUTH_SECRET` committée en clair dans le `docker-compose.yml` racine actuel. Cette pratique (secret en clair dans un fichier versionné) ne doit pas être reconduite pour le nouveau service : passez par un fichier `.env` non versionné ou un secret manager, et profitez-en pour signaler/faire tourner l'ancien secret exposé.

## Rôles

Uniquement `AGENT` et `ADMIN` (enum Prisma `Role`, voir [[civil-status-domain-model]]). Pas de rôle intermédiaire aujourd'hui — si un besoin de rôle supplémentaire apparaît (ex. superviseur régional), c'est une décision produit à valider avant d'étendre l'enum, pas un choix d'implémentation à prendre seul.
