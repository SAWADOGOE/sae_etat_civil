/**
 * Service de génération d'identifiant unique IUCEC pour les actes d'état civil
 *
 * SUIT EXACTEMENT LE SYSTÈME IUCEC-GENERATOR
 *
 * Format: [Code ECC][Année][Numéro d'ordre][Clé de contrôle]
 * Exemple: 30004412025000166
 *          - 3000441 = Code ECC (7 caractères FIXES de la commune)
 *          - 2025 = Année (4 caractères)
 *          - 0001 = Numéro d'ordre (4 caractères)
 *          - 66 = Clé de contrôle (2 caractères)
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

/**
 * Interface pour l'identifiant généré
 */
export interface IdentifiantGenere {
  identifiant_unique: string;
  code_ecc: string;
  annee: number;
  numero_ordre: number;
  cle_controle: string;
  date_attribution: Date;
}

/**
 * Calcule la clé de contrôle selon l'algorithme Luhn modifié
 * EXACTEMENT comme dans IUCEC-Generator
 *
 * @param identifiantSansCle - Les 15 premiers caractères de l'identifiant
 * @returns Clé de contrôle sur 2 chiffres
 */
export function genererCleControle(identifiantSansCle: string): string {
  // Poids pour l'algorithme Luhn modifié (comme dans IUCEC)
  const poids = [1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1, 2, 1];

  let somme = 0;

  for (let i = 0; i < identifiantSansCle.length; i++) {
    const chiffre = parseInt(identifiantSansCle[i]);
    const produit = chiffre * poids[i];
    somme += produit;
  }

  const reste = somme % 97;
  const cle = 97 - reste;

  return String(cle).padStart(2, '0');
}

/**
 * Vérifie si un identifiant est valide
 *
 * @param identifiant - L'identifiant complet de 17 caractères
 * @returns true si valide, false sinon
 */
export function verifierIdentifiant(identifiant: string): boolean {
  if (!identifiant || identifiant.length !== 17) {
    return false;
  }

  const identifiantSansCle = identifiant.substring(0, 15);
  const cleActuelle = identifiant.substring(15, 17);
  const cleCalculee = genererCleControle(identifiantSansCle);

  return cleActuelle === cleCalculee;
}

/**
 * Obtient ou crée la séquence pour un code ECC et une année
 * EXACTEMENT comme dans IUCEC-Generator
 */
async function obtenirSequence(code_ecc: string, annee: number) {
  let sequence = await prisma.identifiantSequence.findUnique({
    where: {
      code_ecc_annee: {
        code_ecc,
        annee,
      },
    },
  });

  if (!sequence) {
    sequence = await prisma.identifiantSequence.create({
      data: {
        code_ecc,
        annee,
        dernier_numero: 0,
        total_generes: 0,
      },
    });
  }

  return sequence;
}

/**
 * Incrémente et retourne le prochain numéro d'ordre
 * EXACTEMENT comme dans IUCEC-Generator
 */
async function obtenirProchainNumero(code_ecc: string, annee: number): Promise<number> {
  const sequence = await prisma.identifiantSequence.update({
    where: {
      code_ecc_annee: {
        code_ecc,
        annee,
      },
    },
    data: {
      dernier_numero: {
        increment: 1,
      },
      total_generes: {
        increment: 1,
      },
    },
  });

  return sequence.dernier_numero;
}

/**
 * Génère un identifiant unique IUCEC pour un acte
 * EXACTEMENT comme dans IUCEC-Generator
 *
 * @param code_ecc - Code ECC de la commune (7 caractères)
 * @param annee - Année de l'acte (optionnel, utilise l'année actuelle par défaut)
 * @returns Objet contenant l'identifiant généré et ses composants
 */
export async function genererIdentifiantUnique(
  code_ecc: string,
  annee?: number
): Promise<IdentifiantGenere> {
  try {
    // Valider le code ECC
    if (!code_ecc || code_ecc.length !== 7) {
      throw new Error('Le code ECC doit contenir exactement 7 caractères');
    }

    // Utiliser l'année actuelle si non spécifiée
    const anneeActuelle = annee || new Date().getFullYear();

    // Valider l'année
    /*if (anneeActuelle < 2000 || anneeActuelle > 2100) {
      throw new Error('L\'année doit être entre 2000 et 2100');
    }*/

    // Vérifier que la commune avec ce code ECC existe
    const commune = await prisma.commune.findUnique({
      where: { code_ecc },
    });

    if (!commune) {
      throw new Error(`Aucune commune trouvée avec le code ECC: ${code_ecc}`);
    }

    // Assurer que la séquence existe
    await obtenirSequence(code_ecc, anneeActuelle);

    // Obtenir le prochain numéro d'ordre
    const numeroOrdre = await obtenirProchainNumero(code_ecc, anneeActuelle);

    // Vérifier que le numéro d'ordre ne dépasse pas 9999
    if (numeroOrdre > 9999) {
      throw new Error(`Limite atteinte: 9999 identifiants générés pour ${code_ecc} en ${anneeActuelle}`);
    }

    // Construire l'identifiant EXACTEMENT comme IUCEC
    const numeroOrdrePadded = String(numeroOrdre).padStart(4, '0');
    const anneePadded = String(anneeActuelle).padStart(4, '0');

    // Identifiant sans clé (15 caractères)
    // Format: code_ecc (7) + année (4) + numero_ordre (4)
    const identifiantSansCle = code_ecc + anneePadded + numeroOrdrePadded;

    // Calculer la clé de contrôle
    const cleControle = genererCleControle(identifiantSansCle);

    // Identifiant complet (17 caractères)
    const identifiantUnique = identifiantSansCle + cleControle;

    return {
      identifiant_unique: identifiantUnique,
      code_ecc: code_ecc,
      annee: anneeActuelle,
      numero_ordre: numeroOrdre,
      cle_controle: cleControle,
      date_attribution: new Date(),
    };
  } catch (error) {
    console.error('Erreur lors de la génération de l\'identifiant:', error);
    throw error;
  }
}

/**
 * Génère un identifiant pour un acte à partir de son registre
 * Récupère automatiquement le code_ecc de la commune
 *
 * @param registreId - ID du registre
 * @param annee - Année (optionnel)
 * @returns Identifiant généré
 */
export async function genererIdentifiantPourRegistre(
  registreId: number,
  annee?: number
): Promise<IdentifiantGenere> {
  try {
    // Récupérer le registre avec sa commune
    const registre = await prisma.registre.findUnique({
      where: { id: registreId },
      include: {
        commune: true,
      },
    });

    if (!registre) {
      throw new Error(`Registre avec ID ${registreId} introuvable`);
    }

    if (!registre.commune.code_ecc) {
      throw new Error(
        `La commune "${registre.commune.nom_commune}" n'a pas de code ECC attribué. ` +
        `Veuillez d'abord attribuer un code ECC à cette commune.`
      );
    }

    // Utiliser l'année du registre si non spécifiée
    const anneeUtilisee = annee || registre.annee;

    // Générer l'identifiant avec le code ECC de la commune
    return await genererIdentifiantUnique(registre.commune.code_ecc, anneeUtilisee);
  } catch (error) {
    console.error('Erreur lors de la génération de l\'identifiant pour le registre:', error);
    throw error;
  }
}

/**
 * Décompose un identifiant en ses composants
 * EXACTEMENT comme dans IUCEC-Generator
 */
export function decomposerIdentifiant(identifiant: string) {
  if (!identifiant || identifiant.length !== 17) {
    throw new Error('Identifiant invalide: doit contenir 17 caractères');
  }

  return {
    code_ecc: identifiant.substring(0, 7),
    annee: parseInt(identifiant.substring(7, 11)),
    numero_ordre: parseInt(identifiant.substring(11, 15)),
    cle_controle: identifiant.substring(15, 17),
  };
}

/**
 * Obtient les statistiques des identifiants pour un code ECC
 * EXACTEMENT comme dans IUCEC-Generator
 */
export async function obtenirStatistiques(code_ecc: string, annee: number) {
  const sequence = await prisma.identifiantSequence.findUnique({
    where: {
      code_ecc_annee: {
        code_ecc,
        annee,
      },
    },
  });

  if (!sequence) {
    return {
      code_ecc,
      total_generes: 0,
      dernier_numero: 0,
      annee,
      disponibles: 9999, // Maximum possible
    };
  }

  return {
    code_ecc,
    total_generes: sequence.total_generes,
    dernier_numero: sequence.dernier_numero,
    annee: sequence.annee,
    disponibles: 9999 - sequence.dernier_numero,
  };
}

/**
 * Valide un identifiant et retourne les informations complètes
 * EXACTEMENT comme dans IUCEC-Generator
 */
export async function validerIdentifiant(identifiant: string) {
  // Vérifier le format et la clé de contrôle
  if (!verifierIdentifiant(identifiant)) {
    return {
      valide: false,
      erreur: 'Format d\'identifiant invalide ou clé de contrôle incorrecte',
    };
  }

  // Décomposer l'identifiant
  const composants = decomposerIdentifiant(identifiant);

  // Chercher l'acte correspondant
  const acte = await prisma.acte.findUnique({
    where: { identifiant_unique: identifiant },
    include: {
      registre: {
        include: {
          commune: {
            include: {
              province: {
                include: {
                  region: true,
                },
              },
            },
          },
        },
      },
    },
  });

  // Chercher la commune avec ce code ECC
  const commune = await prisma.commune.findUnique({
    where: { code_ecc: composants.code_ecc },
    include: {
      province: {
        include: {
          region: true,
        },
      },
    },
  });

  if (!acte) {
    return {
      valide: true,
      existe: false,
      composants,
      commune: commune ? {
        code_ecc: commune.code_ecc,
        nom_commune: commune.nom_commune,
        province: commune.province.nom_province,
        region: commune.province.region.nom_region,
      } : null,
      message: 'Identifiant valide mais non attribué à un acte',
    };
  }

  return {
    valide: true,
    existe: true,
    composants,
    acte: {
      id: acte.id,
      numero_acte: acte.numero_acte,
      status: acte.status,
      date_creation: acte.createdAt,
      identifiant_attribue_le: acte.identifiant_attribue_le,
      registre: {
        numero: acte.registre.numero,
        annee: acte.registre.annee,
        type: acte.registre.type_registre,
        commune: acte.registre.commune.nom_commune,
        code_ecc: acte.registre.commune.code_ecc,
        province: acte.registre.commune.province.nom_province,
        region: acte.registre.commune.province.region.nom_region,
      },
    },
  };
}

export default {
  genererIdentifiantUnique,
  genererIdentifiantPourRegistre,
  genererCleControle,
  verifierIdentifiant,
  decomposerIdentifiant,
  obtenirStatistiques,
  validerIdentifiant,
};
