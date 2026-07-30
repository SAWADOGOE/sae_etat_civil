# Inventaire complet des champs `Acte`

Source : `../../prisma/schema.prisma` (modèle `Acte`). Regroupé par usage pour servir de base à des DTO Zod, des `select` Prisma ciblés, ou un mapping CSV import/export. Ne pas ajouter de champ ici sans l'ajouter d'abord dans le schéma Prisma partagé.

## Identité / méta (tous types d'actes)

`id` (cuid), `numero_acte`, `acte_numerisee` (image — candidate MinIO, voir [[minio-file-storage]]), `extractedText` (texte libre associé à l'acte — l'extraction OCR qui l'alimentait est hors périmètre de cette version, voir `../../../CLAUDE.md`), `type_acte` (`oui`/`non`, jugement supplétif), `declaration_jugement`, `date_etablissement`, `officier`, `mention`, `completed`, `message`, `status`, `article`, `createdAt`, `updatedAt`, `registreId`, `userId`, `validatedById`, `validated`.

## Jugement supplétif

`numero_jugement`, `lieu_jugement`, `date_jugement`.

## Identifiant IUCEC

`identifiant_unique`, `code_ecc`, `annee_identifiant`, `numero_ordre`, `cle_controle`, `identifiant_attribue_le` — voir [[iucec-identifiant-service]], ne jamais peupler manuellement.

## Naissance : enfant (partagés avec décès/défunt — voir plus bas)

`prenom`, `nom`, `date_naissance`, `heure`, `lieu_naissance`, `sexe`.

## Naissance : père

`nom_pere`, `prenom_pere`, `date_naissance_pere`, `lieu_naissance_pere`, `profession_pere`, `domicile_pere`.

## Naissance : mère

`nom_mere`, `prenom_mere`, `date_naissance_mere`, `lieu_naissance_mere`, `profession_mere`, `domicile_mere`.

## Décès : défunt

Réutilise `prenom`, `nom`, `date_naissance`, `sexe`, `lieu_naissance` (identité) + spécifiques :
`date_deces`, `heure_deces`, `lieu_deces`, `heure_naissance`, `profession_defunt`, `domicile_defunt`, `situation_matrimoniale`, `date_mariage`, `nom_conjoint`, `prenom_conjoint`, `conjoints` (JSON sérialisé en texte, tableau pour conjoints multiples).

## Décès : déclarant

`nom_declarant`, `prenom_declarant`, `qualite_declarant`.

## Mariage : options

`option_mariage`, `regime_mariage`, `heure_mariage`.

## Mariage : époux

`prenom_epoux`, `nom_epoux`, `date_naissance_epoux`, `lieu_naissance_epoux`, `domicile_epoux`, `profession_epoux`.

## Mariage : père de l'époux

`nom_pere_epoux`, `prenom_pere_epoux`, `date_naissance_pere_epoux`, `lieu_naissance_pere_epoux`, `profession_pere_epoux`, `domicile_pere_epoux`.

## Mariage : mère de l'époux

`nom_mere_epoux`, `prenom_mere_epoux`, `date_naissance_mere_epoux`, `lieu_naissance_mere_epoux`, `profession_mere_epoux`, `domicile_mere_epoux`.

## Mariage : épouse

`prenom_epouse`, `nom_epouse`, `date_naissance_epouse`, `lieu_naissance_epouse`, `domicile_epouse`, `profession_epouse`.

## Mariage : père de l'épouse

`nom_pere_epouse`, `prenom_pere_epouse`, `date_naissance_pere_epouse`, `lieu_naissance_pere_epouse`, `profession_pere_epouse`, `domicile_pere_epouse`.

## Mariage : mère de l'épouse

`nom_mere_epouse`, `prenom_mere_epouse`, `date_naissance_mere_epouse`, `lieu_naissance_mere_epouse`, `profession_mere_epouse`, `domicile_mere_epouse`.

## Mariage : témoins

`nom_temoin_epoux`, `prenom_temoin_epoux`, `profession_temoin_epoux`, `domicile_temoin_epoux`, `nom_temoin_epouse`, `prenom_temoin_epouse`, `profession_temoin_epouse`, `domicile_temoin_epouse`.

## Enums associés

- `Status`: `PENDING | COMPLETED | REJECTED | ARCHIVED`
- `Article`: `le | vers | en`
- `TypeActe`: `oui | non`
- `RegistreType` / `ActeType` (redondants dans le schéma actuel) : `NAISSANCE | MARIAGE | DECES`

## Conseil pour les DTO Zod côté Express

Découpez en sous-schémas Zod réutilisables plutôt qu'un unique schéma de 150 champs :
`acteCommunSchema`, `acteNaissanceSchema` (étend commun + père/mère), `acteDecesSchema` (étend commun + déclarant), `acteMariageSchema` (composé de 8 blocs identité répétés : `personneSchema` paramétrable). Sélectionnez le bon sous-schéma selon `registre.type_registre`, exactement comme le fait la contrainte métier — ne validez pas les ~150 champs comme s'ils étaient tous obligatoires en même temps.
