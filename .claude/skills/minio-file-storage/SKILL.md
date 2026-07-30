---
name: minio-file-storage
description: Bonnes pratiques pour stocker les images numerisees d'actes et les logos de commune dans MinIO (S3-compatible) au lieu du base64 en base Postgres, conventions de buckets/cles, upload en flux, URLs presignees, miniatures, migration des donnees existantes. Utiliser pour tout endpoint d'upload/download de fichier, la compression d'image, acte_numerisee, ou la configuration MinIO.
metadata:
  author: sae-backend
  version: 1.0.0
  category: infrastructure
---

# Stockage de fichiers avec MinIO

## Le problème que ça résout

Aujourd'hui, `Acte.acte_numerisee` stocke l'image **en base64 dans une colonne texte Postgres**, et `compressImage()` (Sharp) est ré-exécuté **à chaque lecture**, pour **chaque ligne**, sans pagination (`getAllActes()` charge toute la table). Sur un registre de plusieurs milliers d'actes, chaque `GET /api/acte` recompresse potentiellement des milliers d'images synchrone­ment. C'est la raison d'être de ce skill : sortir le binaire de Postgres, ne garder en base qu'une référence légère.

## Buckets

| Bucket | Contenu | Politique |
|---|---|---|
| `actes-numerises` | images scannées d'actes (recto, verso, multi-page fusionné) | privé, accès via URL présignée uniquement |
| `communes-logos` | logos de commune (`Commune.logo`) | lecture publique acceptable si utilisé dans l'UI publique, sinon présignée aussi |
| `exports` | CSV/PDF générés à la demande (`admin/actes/export`, `admin/statistiques/export`) | lifecycle d'expiration courte (ex. 24h), pas d'archivage long |

Un bucket par domaine, pas un bucket unique fourre-tout — ça simplifie les politiques d'accès et le lifecycle.

## Convention de clé d'objet

```
actes/{communeId}/{annee}/{registreId}/{acteId}.jpg          # image originale (ou fusion recto-verso)
actes/{communeId}/{annee}/{registreId}/{acteId}-thumb.jpg     # miniature pour les listes
communes/{communeId}/logo.{ext}
exports/{userId}/{jobId}.csv
```

La clé encode la hiérarchie métier (`Region → Province → Commune → Registre`, voir [[civil-status-domain-model]]) pour que l'exploration manuelle du bucket (support, audit) reste lisible sans base de données. Ne générez pas des clés `uuid.jpg` opaques.

## Ce que la base de données garde

`Acte.acte_numerisee` doit passer de "contenu base64" à "clé d'objet MinIO" (`actes/12/2025/34/abc123.jpg`), pas une URL complète (l'endpoint MinIO peut changer entre environnements). Générez l'URL au moment de la lecture, jamais stockée telle quelle. Si un acte multi-page (recto+verso déjà fusionnés aujourd'hui via `fusionnerRectoVerso`) doit un jour garder les deux images séparées plutôt que fusionnées, prévoyez un champ JSON `image_keys: string[]` plutôt que de réutiliser `acte_numerisee` en single-string — mais ne changez pas ce comportement de fusion sans validation métier explicite, il est intentionnel aujourd'hui (mariage + option manuelle multi-page).

Ce changement de sémantique de colonne est une migration Prisma à part entière (nouvelle colonne, script de backfill, dépréciation de l'ancienne) — ne l'introduisez pas silencieusement dans un endpoint sans migration documentée.

## Upload : flux, pas de double-buffer disque

Le code actuel écrit d'abord sur disque via `formidable` (fichiers temporaires nettoyés en `finally`), puis relit le fichier pour le compresser. Dans le nouveau backend :

1. `multer` en mode **memory storage** pour les uploads de taille raisonnable (jusqu'à quelques dizaines de Mo par fichier) — évite d'écrire sur le disque du conteneur.
2. Compression/redimensionnement Sharp **une seule fois**, à l'upload (comme aujourd'hui : `MAX_WIDTH/MAX_HEIGHT = 1920`, JPEG qualité 80, `mozjpeg: true`) — jamais recompressé à la lecture.
3. Génère aussi une miniature (ex. largeur 300px) à l'upload, stockée à côté (`-thumb.jpg`), pour que les vues liste utilisent la miniature et jamais l'original.
4. `client.putObject(bucket, key, buffer, buffer.length, { 'Content-Type': mimetype })`.

```ts
// lib/minio.ts
import { Client } from 'minio';
export const minioClient = new Client({
  endPoint: env.MINIO_ENDPOINT,
  port: env.MINIO_PORT,
  useSSL: env.MINIO_USE_SSL,
  accessKey: env.MINIO_ACCESS_KEY,
  secretKey: env.MINIO_SECRET_KEY,
});
```

Un seul client MinIO, en singleton dans `src/lib/minio.ts` — même règle que pour Prisma.

## Limites de taille : corriger l'incohérence existante

`acteService.ts` définit `MAX_FILE_SIZE = 500 * 1024 * 1024` mais le commentaire juste à côté dit `// 5 MB` — l'intention documentée (5 Mo par image scannée) ne correspond pas à la valeur réelle (500 Mo). En reportant cette constante dans le nouveau backend, **clarifiez cette valeur avec le métier avant de la reporter telle quelle** ; ne copiez pas silencieusement une incohérence. `MAX_FILES = 300` (nombre de fichiers par lot d'upload) semble intentionnel, à conserver sauf indication contraire.

## Téléchargement : URLs présignées, jamais de proxy binaire par défaut

```ts
const url = await minioClient.presignedGetObject(bucket, key, 5 * 60); // 5 min
```

- Génère une URL temporaire que le frontend consomme directement — le backend Express ne doit pas streamer le binaire lui-même sauf cas particulier (export PDF assemblé côté serveur).
- Si une URL présignée est mise en cache Redis (pour éviter de la régénérer à chaque requête de liste), sa TTL de cache doit être **strictement inférieure** à la durée de validité de l'URL elle-même — voir [[redis-caching-and-queues]].

## Migration des données existantes

Les actes déjà saisis ont leur image en base64 dans Postgres. La bascule vers MinIO nécessite un script de backfill (job ponctuel, pas un endpoint HTTP) qui : lit par lots (pagination, jamais `findMany()` sans `take`/`skip`), décode le base64, pousse vers MinIO à la clé conventionnelle ci-dessus, met à jour la ligne avec la nouvelle clé, et seulement après vérification, nettoie l'ancienne colonne. Ce script mérite son propre plan avant d'être écrit — ne l'improvisez pas dans la même PR que la mise en place de MinIO.
